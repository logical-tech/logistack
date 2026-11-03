import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import type { EventEnvelope, ServiceSpec } from "@logistack/contracts";
import { encrypt, importMasterKey } from "@logistack/core";
import {
	certificate,
	createDb,
	type Db,
	dnsProvider,
	domain,
	environment,
	instanceSettings,
	notificationChannel,
	notificationRule,
	organization,
	project,
	runMigrations,
	service,
} from "@logistack/db";
import type { DockerClient } from "@logistack/docker";
import { eq } from "drizzle-orm";
import { createBus, setLogLevel } from "../src/bus.ts";
import {
	CERTS_KEY,
	readCaddyCerts,
	refreshCertSnapshot,
} from "../src/certs.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/ctx.ts";
import type { NodeRunner } from "../src/node-runner.ts";
import { channelStatusKey, dispatch, dispatchDeps } from "../src/notify.ts";
import { syncProxy } from "../src/proxy.ts";
import type { Queues } from "../src/queues.ts";
import { hasDocker, sh } from "./harness.ts";

/** Every object here is named `ls-test-dns-w-*` and labelled `logistack.test=dns`; cleanup removes exactly these. */
const P = "ls-test-dns-w-";
const NET = `${P}net`;
const NAMES = [`${P}pg`, `${P}redis`, `${P}caddy`];
const LABEL = "logistack.test=dns";
const CADDY_IMAGE = "ls-test-dns-caddy:dev";

const hasCaddyImage =
	hasDocker &&
	Bun.spawnSync(["docker", "image", "inspect", CADDY_IMAGE], {
		stdout: "ignore",
		stderr: "ignore",
	}).exitCode === 0;

const fixture = (name: string) =>
	readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

function cleanup() {
	for (const n of NAMES)
		Bun.spawnSync(["docker", "rm", "-f", "-v", n], {
			stdout: "ignore",
			stderr: "ignore",
		});
	Bun.spawnSync(["docker", "network", "rm", NET], {
		stdout: "ignore",
		stderr: "ignore",
	});
}

/** Container IPs are reachable from the host on OrbStack and Linux Docker. */
const ipOf = (name: string) =>
	(
		JSON.parse(sh("docker", "inspect", name)) as {
			NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
		}[]
	)[0]?.NetworkSettings.Networks[NET]?.IPAddress as string;

async function until<T>(
	fn: () => Promise<T | undefined | false>,
	what: string,
	ms = 30_000,
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn().catch(() => undefined);
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(250);
	}
}

/** The certificate a TLS server presents for `servername`. */
function peer(host: string, servername: string) {
	return new Promise<{ san: string; issuer: string; fingerprint: string }>(
		(resolve, reject) => {
			const s = tls.connect(
				{ host, port: 443, servername, rejectUnauthorized: false },
				() => {
					const c = s.getPeerCertificate();
					resolve({
						san: c.subjectaltname ?? "",
						issuer: String(c.issuer?.CN ?? ""),
						fingerprint: c.fingerprint256,
					});
					s.end();
				},
			);
			s.on("error", reject);
		},
	);
}

describe.skipIf(!hasCaddyImage)(
	"proxy sync against real Caddy and Redis",
	() => {
		let ctx: Ctx;
		let db: Db;
		let caddyIp: string;
		const spec = {
			kind: "application",
			source: { type: "image", image: "nginx:1.27" },
			build: { type: "image" },
			ports: [{ target: 80, protocol: "tcp" }],
			replicas: 1,
			resources: {},
			placement: [],
		} as unknown as ServiceSpec;

		beforeAll(async () => {
			setLogLevel("silent");
			cleanup();
			sh("docker", "network", "create", "--label", LABEL, NET);
			const run = (name: string, ...args: string[]) =>
				sh(
					"docker",
					"run",
					"-d",
					"--name",
					name,
					"--label",
					LABEL,
					"--network",
					NET,
					...args,
				);
			run(
				NAMES[0] as string,
				"-e",
				"POSTGRES_PASSWORD=test",
				"postgres:17-alpine",
			);
			run(NAMES[1] as string, "redis:7-alpine");
			run(
				NAMES[2] as string,
				"--entrypoint",
				"sh",
				CADDY_IMAGE,
				"-c",
				`echo '{"admin":{"listen":"0.0.0.0:2019"}}' > /tmp/boot.json && exec caddy run --config /tmp/boot.json`,
			);
			const [pgIp, redisIp] = [
				ipOf(NAMES[0] as string),
				ipOf(NAMES[1] as string),
			];
			caddyIp = ipOf(NAMES[2] as string);
			const databaseUrl = `postgres://postgres:test@${pgIp}:5432/postgres`;
			await until(
				() => runMigrations(databaseUrl).then(() => true),
				"postgres",
			);
			await until(
				() => fetch(`http://${caddyIp}:2019/config/`).then((r) => r.ok),
				"caddy admin",
			);
			const cfg = loadConfig({
				DATABASE_URL: databaseUrl,
				REDIS_URL: `redis://${redisIp}:6379`,
				LOGISTACK_MASTER_KEY: crypto
					.getRandomValues(new Uint8Array(32))
					.toBase64(),
				LOG_LEVEL: "silent",
			});
			db = createDb(cfg.DATABASE_URL, { onnotice: () => {} });
			const docker = {
				tasks: {
					list: async () => [
						{
							Status: { State: "running" },
							NetworksAttachments: [
								{
									Network: { Spec: { Name: cfg.LS_CONTROL_NETWORK } },
									Addresses: [`${caddyIp}/24`],
								},
							],
						},
					],
				},
			} as unknown as DockerClient;
			ctx = {
				cfg,
				db,
				docker,
				bus: await createBus(cfg.REDIS_URL),
				masterKey: await importMasterKey(cfg.LOGISTACK_MASTER_KEY),
				queues: {} as Queues,
				nodes: {} as NodeRunner,
			};
		}, 120_000);

		afterAll(async () => {
			ctx?.bus.close();
			await db?.$client.end();
			cleanup();
		});

		test("custom cert, internal issuer, instance wildcard; bad rows are isolated", async () => {
			const seal = (s: string) => encrypt(ctx.masterKey, s);
			await db.insert(organization).values({
				id: "org_a",
				name: "Acme",
				slug: "acme",
				createdAt: new Date(),
			});
			await db.insert(instanceSettings).values({
				id: "singleton",
				setupCompleted: true,
				publicUrl: "https://ls.base.test",
				letsencryptEmail: "ops@base.test",
				generatedDomainBase: "custom",
				customWildcard: "*.base.test",
				acmeDirectory: "internal",
			});
			const [prj] = await db
				.insert(project)
				.values({ organizationId: "org_a", name: "Shop", slug: "shop" })
				.returning();
			const [env] = await db
				.insert(environment)
				.values({
					projectId: prj?.id as string,
					name: "Production",
					slug: "production",
					kind: "production",
					isDefault: true,
				})
				.returning();
			const [svc] = await db
				.insert(service)
				.values({
					environmentId: env?.id as string,
					name: "Web",
					slug: "web",
					kind: "application",
					spec,
				})
				.returning();
			const [dns] = await db
				.insert(dnsProvider)
				.values({
					organizationId: "org_a",
					kind: "cloudflare",
					name: "base.test",
					credentialsEncrypted: await seal(JSON.stringify({ apiToken: "t" })),
					zonesCache: [{ id: "z1", name: "base.test" }],
				})
				.returning();
			const certPem = fixture("custom-cert.pem");
			const [good, bad] = await db
				.insert(certificate)
				.values([
					{
						organizationId: "org_a",
						name: "Good",
						certPem,
						keyPemEncrypted: await seal(fixture("custom-key.pem")),
						notAfter: new Date("2126-10-10"),
						sans: ["custom.test", "*.custom.test"],
					},
					{
						organizationId: "org_a",
						name: "Wrong key",
						certPem,
						keyPemEncrypted: await seal(fixture("other-key.pem")),
						notAfter: new Date("2126-10-10"),
						sans: ["custom.test", "*.custom.test"],
					},
				])
				.returning();
			const serviceId = svc?.id as string;
			const row = (
				hostname: string,
				extra: Partial<typeof domain.$inferInsert> = {},
			) => ({
				serviceId,
				hostname,
				port: 80,
				...extra,
			});
			// Inserted straight into the table, past the API's checks, as an old row would be.
			await db.insert(domain).values([
				row("custom.test", { cert: "custom", customCertificateId: good?.id }),
				row("auto.test"),
				row("web-abc123.base.test", { isGenerated: true }),
				row("*.apps.base.test", { dnsProviderId: dns?.id }),
				row("*.nodns.test"),
				row("a.custom.test", {
					cert: "custom",
					customCertificateId: bad?.id,
				}),
			]);

			await syncProxy(ctx);

			const statuses = Object.fromEntries(
				(await db.select().from(domain)).map((d) => [
					d.hostname,
					[d.status, d.statusMessage],
				]),
			);
			expect(statuses).toEqual({
				"custom.test": ["active", null],
				"auto.test": ["active", null],
				"web-abc123.base.test": ["active", null],
				"*.apps.base.test": ["active", null],
				"*.nodns.test": ["error", "a wildcard domain needs a DNS provider"],
				"a.custom.test": [
					"error",
					"the private key does not match the certificate",
				],
			});

			const uploaded = new X509Certificate(certPem).fingerprint256;
			expect((await peer(caddyIp, "custom.test")).fingerprint).toBe(uploaded);
			const auto = await until(
				() => peer(caddyIp, "auto.test").then((p) => (p.san ? p : undefined)),
				"auto.test certificate",
			);
			expect(auto.san).toBe("DNS:auto.test");
			expect(auto.issuer).toContain("Caddy Local Authority");
			// The generated host and the dashboard share the one instance wildcard.
			for (const host of ["web-abc123.base.test", "ls.base.test"])
				expect(
					(
						await until(
							() => peer(caddyIp, host).then((p) => (p.san ? p : undefined)),
							host,
						)
					).san,
				).toBe("DNS:*.base.test");

			const names = await until(async () => {
				const certs = await readCaddyCerts(ctx.bus.redis);
				const all = certs.map((c) => c.names.join(","));
				return all.includes("*.base.test") && all.includes("auto.test") && all;
			}, "certificates in redis");
			// Exact hosts under the base got no certificate of their own.
			expect(names).not.toContain("web-abc123.base.test");
			expect(names).not.toContain("ls.base.test");
			await refreshCertSnapshot(ctx);
			const snapshot = JSON.parse((await ctx.bus.redis.get(CERTS_KEY)) ?? "{}");
			expect(snapshot.certs).toContainEqual(
				expect.objectContaining({
					names: ["auto.test"],
					issuer: expect.stringContaining("Caddy Local Authority"),
				}),
			);
		}, 90_000);

		test("dispatcher over real Redis: two replicas, one delivery; failures are recorded", async () => {
			const hits: string[] = [];
			let failing = false;
			const hook = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				async fetch(req) {
					hits.push(req.headers.get("x-logistack-delivery") ?? "");
					return new Response(null, { status: failing ? 500 : 204 });
				},
			});
			try {
				const [ch] = await db
					.insert(notificationChannel)
					.values({
						organizationId: "org_a",
						kind: "webhook",
						name: "Hook",
						configEncrypted: await encrypt(
							ctx.masterKey,
							JSON.stringify({
								url: `http://127.0.0.1:${hook.port}/hook`,
								secret: "0123456789abcdef0123",
							}),
						),
					})
					.returning();
				await db.insert(notificationRule).values({
					organizationId: "org_a",
					events: ["domain.error"],
					channelId: ch?.id as string,
				});
				const event: EventEnvelope = {
					id: `evt_${crypto.randomUUID()}`,
					type: "domain.error",
					organizationId: "org_a",
					resource: { type: "domain", id: "dom_x" },
					payload: { hostname: "x.test", error: "boom" },
					at: new Date(),
				};
				// Through the SSRF guard a plain-http loopback receiver is refused and recorded.
				const guarded = await dispatch(
					{ ...event, id: `evt_${crypto.randomUUID()}` },
					dispatchDeps(ctx),
					{ attempts: 2, baseMs: 1 },
				);
				expect(guarded.get(ch?.id as string)).toEqual({
					ok: false,
					error: "webhook send: network error: only https URLs are allowed",
				});
				expect(hits).toEqual([]);
				await ctx.bus.redis.del(channelStatusKey(ch?.id as string));

				const replicas = [dispatchDeps(ctx, fetch), dispatchDeps(ctx, fetch)];
				await Promise.all(replicas.map((d) => dispatch(event, d)));
				expect(hits).toEqual([event.id]);

				failing = true;
				const second = { ...event, id: `evt_${crypto.randomUUID()}` };
				const out = await dispatch(second, replicas[0] as never, {
					attempts: 3,
					baseMs: 10,
				});
				expect(out.get(ch?.id as string)).toEqual({
					ok: false,
					error: "webhook send: HTTP 500",
				});
				expect(hits.filter((h) => h === second.id)).toHaveLength(3);
				const status = JSON.parse(
					(await ctx.bus.redis.get(channelStatusKey(ch?.id as string))) ?? "{}",
				);
				expect(status).toMatchObject({
					lastSuccessAt: expect.any(String),
					lastError: "webhook send: HTTP 500",
					consecutiveFailures: 1,
				});
			} finally {
				hook.stop(true);
			}
		});

		test("a second sync with nothing changed writes nothing", async () => {
			const before = await db.select().from(domain);
			await syncProxy(ctx);
			const after = await db.select().from(domain);
			expect(after.map((d) => [d.id, d.updatedAt.getTime()]).sort()).toEqual(
				before.map((d) => [d.id, d.updatedAt.getTime()]).sort(),
			);
			expect(
				(await db.select().from(domain).where(eq(domain.status, "error")))
					.length,
			).toBe(2);
		});
	},
);
