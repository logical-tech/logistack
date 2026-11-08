// Real Swarm and real Caddy: a pull request event previews a git stack, its services answer on
// their preview domains through the proxy, and closing the pull request leaves no Docker object of
// the preview. Every object is `ls-test-stkprev-*` labelled `logistack.test=stkprev`. Opt in with
// STKPREV_IT=1; needs the repo's Caddy build (LS_TEST_CADDY_IMAGE, default `ls-test-dns-caddy:dev`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encrypt, isTerminal } from "@logistack/core";
import {
	deployment,
	domain,
	environment,
	gitProvider,
	mount,
	organization,
	service,
} from "@logistack/db";
import { hmacSha256 } from "@logistack/providers";
import { desc, eq, inArray } from "drizzle-orm";
// The api does not depend on the proxy package; the worker does.
import { compileProxy } from "../../../packages/proxy/src/index.ts";
import { loadConfig } from "../../worker/src/config.ts";
import { type RunningWorker, startWorker } from "../../worker/src/index.ts";
import { svcName } from "../../worker/src/load.ts";
import { sweepOrphans } from "../../worker/src/reconcile.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const PREFIX = "ls-test-stkprev-";
const LABEL = "logistack.test=stkprev";
const CADDY = `${PREFIX}caddy`;
const CADDY_IMAGE = process.env.LS_TEST_CADDY_IMAGE ?? "ls-test-dns-caddy:dev";
const SHA = "c3".repeat(20);
const quiet = (...argv: string[]) =>
	Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" });
const enabled =
	hasDocker &&
	process.env.STKPREV_IT === "1" &&
	quiet("docker", "image", "inspect", CADDY_IMAGE).exitCode === 0;

function docker(...args: string[]): string {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}
const ours = (kind: string) =>
	docker(kind, "ls", "--filter", `name=${PREFIX}`, "--format", "{{.Name}}")
		.split("\n")
		.filter((n) => n.startsWith(PREFIX));

/** Removes objects named `ls-test-stkprev-*`; the harness removes its own containers. */
async function cleanup() {
	quiet("docker", "rm", "-f", CADDY);
	for (const s of ours("service")) quiet("docker", "service", "rm", s);
	for (let i = 0; i < 60; i++) {
		const left = docker(
			"ps",
			"-a",
			"--filter",
			"label=com.docker.swarm.service.name",
			"--format",
			'{{.Label "com.docker.swarm.service.name"}}',
		)
			.split("\n")
			.filter((n) => n.startsWith(PREFIX));
		if (!left.length) break;
		await Bun.sleep(500);
	}
	for (const c of ours("config")) quiet("docker", "config", "rm", c);
	for (const s of ours("secret")) quiet("docker", "secret", "rm", s);
	for (const v of ours("volume")) quiet("docker", "volume", "rm", "-f", v);
	for (const n of ours("network")) quiet("docker", "network", "rm", n);
}

/** A page that shows a variable and, for `api`, something written to its volume first. */
const httpd = (script: string) =>
	`["sh", "-c", "mkdir -p /www && ${script} && exec httpd -f -p 8080 -h /www"]`;
const COMPOSE = (title: string) => `services:
  web:
    image: busybox:1.37
    command: ${httpd(`echo \\"${title} $$LOGISTACK_PREVIEW_URL_API $$LOGISTACK_PREVIEW_URL\\" > /www/index.html`)}
  api:
    image: busybox:1.37
    command: ${httpd("echo api-$$LOGISTACK_SERVICE > /data/seen && cp /data/seen /www/index.html")}
    volumes:
      - apidata:/data
volumes:
  apidata: {}
`;

describe.skipIf(!enabled)("stack previews on the real Swarm", () => {
	let h: Harness;
	let w: RunningWorker;
	let work: string;
	let cookie: string;
	let providerId: string;
	const cfgDir = mkdtempSync(join(tmpdir(), `${PREFIX}cfg-`));
	const files = new Map([
		["main", COMPOSE("main")],
		["feature-5", COMPOSE("feature")],
	]);
	const real = globalThis.fetch;
	const call = (method: string, path: string, body?: unknown) =>
		h.call(method, `/api${path}`, { headers: { cookie }, body });

	beforeAll(async () => {
		await cleanup();
		quiet("docker", "pull", "-q", "busybox:1.37");
		h = await startHarness({ area: "stkprev", label: "stkprev" });
		for (const net of ["control", "ingress"])
			docker(
				"network",
				"create",
				"--driver",
				"overlay",
				"--attachable",
				"--label",
				LABEL,
				`${PREFIX}${net}`,
			);
		work = mkdtempSync(join(tmpdir(), PREFIX));
		w = await startWorker(
			loadConfig({
				DATABASE_URL: h.config.DATABASE_URL,
				REDIS_URL: h.config.REDIS_URL,
				LOGISTACK_MASTER_KEY: h.config.LOGISTACK_MASTER_KEY,
				LS_WORK_DIR: work,
				LS_CONTROL_NETWORK: `${PREFIX}control`,
				LS_INGRESS_NETWORK: `${PREFIX}ingress`,
				LS_CADDY_SERVICE: `${PREFIX}caddy`,
				LS_NAME_PREFIX: PREFIX,
				LS_SCOPE_LABELS: JSON.stringify({ "logistack.test": "stkprev" }),
				LS_DEPLOY_TIMEOUT_MS: "180000",
				LS_RECONCILE_INTERVAL_MS: "0",
				LS_ORPHAN_GRACE_MS: "0",
				LOG_LEVEL: "silent",
			}),
		);
		await h.call("POST", "/api/setup", {
			body: {
				...setupBody,
				instance: { ...setupBody.instance, localRegistryEnabled: false },
			},
		});
		cookie = await h.signIn(owner.email, owner.password);

		const pair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign"],
		)) as CryptoKeyPair;
		const der = new Uint8Array(
			await crypto.subtle.exportKey("pkcs8", pair.privateKey),
		);
		const [org] = await h.deps.db.select().from(organization);
		const [gp] = await h.deps.db
			.insert(gitProvider)
			.values({
				organizationId: org?.id ?? "",
				kind: "github",
				name: "GitHub",
				configEncrypted: await encrypt(
					h.deps.masterKey,
					JSON.stringify({
						appId: "1",
						privateKey: `-----BEGIN PRIVATE KEY-----\n${der.toBase64()}\n-----END PRIVATE KEY-----\n`,
						webhookSecret: "hook-secret",
						installationId: "2",
					}),
				),
			})
			.returning();
		providerId = gp?.id ?? "";
		globalThis.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.startsWith("https://api.github.com/")) return real(input, init);
			if (url.endsWith("/access_tokens"))
				return Response.json({
					token: "ghs_test",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				});
			const u = new URL(url);
			if (u.pathname === "/repos/acme/shop/contents/compose.yml") {
				const body = files.get(u.searchParams.get("ref") ?? "");
				return body === undefined
					? new Response("Not Found", { status: 404 })
					: new Response(body);
			}
			return Response.json({ id: 1 });
		}) as typeof fetch;
	}, 180_000);

	afterAll(async () => {
		globalThis.fetch = real;
		await w?.stop();
		await cleanup();
		await h?.close();
		if (work) rmSync(work, { recursive: true, force: true });
		rmSync(cfgDir, { recursive: true, force: true });
	}, 180_000);

	const pr = async (action: string) => {
		const payload = {
			action,
			number: 5,
			repository: { full_name: "acme/shop" },
			pull_request: {
				title: "Feature 5",
				html_url: "https://github.com/acme/shop/pull/5",
				user: { login: "dev" },
				head: { ref: "feature-5", sha: SHA, repo: { full_name: "acme/shop" } },
				base: { ref: "main" },
			},
		};
		const raw = JSON.stringify(payload);
		return h.call("POST", `/api/webhooks/git/${providerId}`, {
			body: payload,
			headers: {
				"x-github-event": "pull_request",
				"x-hub-signature-256": `sha256=${(await hmacSha256("hook-secret", raw)).toHex()}`,
			},
		});
	};

	/** Waits until the latest deployment of each service is terminal; returns their statuses. */
	async function settled(serviceIds: string[]) {
		const deadline = Date.now() + 240_000;
		for (;;) {
			const out: Record<string, string> = {};
			for (const id of serviceIds) {
				const [d] = await h.deps.db
					.select()
					.from(deployment)
					.where(eq(deployment.serviceId, id))
					.orderBy(desc(deployment.createdAt))
					.limit(1);
				if (d && isTerminal(d.status))
					out[id] = d.error ? `${d.status}: ${d.error}` : d.status;
			}
			if (Object.keys(out).length === serviceIds.length) return out;
			if (Date.now() > deadline)
				throw new Error(`deployments stuck: ${JSON.stringify(out)}`);
			await Bun.sleep(1000);
		}
	}

	/** Starts Caddy routing every domain of `envId` over plain HTTP; returns its published address. */
	async function proxyFor(envId: string) {
		const rows = await h.deps.db
			.select({ domain })
			.from(domain)
			.innerJoin(service, eq(service.id, domain.serviceId))
			.where(eq(service.environmentId, envId));
		const config = compileProxy({
			settings: {
				adminListen: "localhost:2019",
				acmeEmail: "ops@example.com",
				storage: { redisUrl: "redis://unused:6379/0", keyPrefix: "x" },
			},
			dashboard: {
				hostname: "ls.stkprev.test",
				upstream: { host: "x", port: 1 },
			},
			routes: rows.map(({ domain: d }) => ({
				domainId: d.id,
				hostname: d.hostname,
				upstream: { host: svcName(w.ctx, d.serviceId), port: d.port },
				https: false,
				cert: "none",
			})),
		});
		const { https: _, ...servers } = config.apps.http.servers;
		writeFileSync(
			join(cfgDir, "caddy.json"),
			JSON.stringify({
				...config,
				storage: { module: "file_system", root: "/tmp/caddy" },
				apps: { http: { ...config.apps.http, servers } },
			}),
		);
		docker(
			"run",
			"-d",
			"--name",
			CADDY,
			"--label",
			LABEL,
			"--network",
			`${PREFIX}ingress`,
			"-p",
			"127.0.0.1::80",
			"-v",
			`${cfgDir}/caddy.json:/etc/caddy/caddy.json:ro`,
			"--entrypoint",
			"caddy",
			CADDY_IMAGE,
			"run",
			"--config",
			"/etc/caddy/caddy.json",
		);
		return docker("port", CADDY, "80/tcp").split("\n")[0] as string;
	}

	test("a pull request previews the stack on its own domains, and closing it leaves nothing behind", async () => {
		const projectId = (await call("POST", "/projects", { name: "Shop" })).json
			.id;
		const sourceEnv = (await call("GET", `/projects/${projectId}/environments`))
			.json[0].id;
		const created = await call(
			"POST",
			`/environments/${sourceEnv}/stacks/git`,
			{
				name: "shop",
				git: {
					gitProviderId: providerId,
					repository: "acme/shop",
					branch: "main",
					composePath: "compose.yml",
				},
			},
		);
		expect(created.status).toBe(201);
		for (const s of created.json.services as { id: string; name: string }[])
			expect(
				(
					await call("POST", `/services/${s.id}/domains`, {
						hostname: `${s.name}.shop.example.com`,
						port: 8080,
						https: true,
						cert: "auto",
					})
				).status,
			).toBe(201);
		const settings = await call("PUT", `/projects/${projectId}/previews`, {
			enabled: true,
			sourceEnvironmentId: sourceEnv,
			stacks: ["shop"],
			domainPattern: "pr-{number}-{service}.preview.test",
		});
		expect(settings.status).toBe(200);

		const opened = await pr("opened");
		expect(opened.json.outcome).toBe("deployed");
		const [env] = await h.deps.db
			.select()
			.from(environment)
			.where(eq(environment.slug, "pr-5"));
		expect(env?.preview).toMatchObject({
			urls: ["https://pr-5-api.preview.test", "https://pr-5-web.preview.test"],
			serviceUrls: {
				api: "https://pr-5-api.preview.test",
				web: "https://pr-5-web.preview.test",
			},
			primaryUrl: "https://pr-5-api.preview.test",
		});
		const svcs = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.environmentId, env?.id ?? ""));
		expect(svcs.map((s) => s.slug).sort()).toEqual(["api", "web"]);
		expect(svcs.every((s) => s.stackId)).toBe(true);
		expect(Object.values(await settled(svcs.map((s) => s.id)))).toEqual([
			"healthy",
			"healthy",
		]);

		const caddy = await proxyFor(env?.id ?? "");
		const get = async (host: string) => {
			const deadline = Date.now() + 60_000;
			for (;;) {
				const res = await real(`http://${caddy}/`, {
					headers: { host },
				}).catch(() => null);
				if (res?.status === 200) return (await res.text()).trim();
				if (Date.now() > deadline)
					throw new Error(`${host} never answered: ${res?.status}`);
				await Bun.sleep(500);
			}
		};
		// The page comes from the pull request's compose file and knows its sibling's preview URL.
		expect(await get("pr-5-web.preview.test")).toBe(
			"feature https://pr-5-api.preview.test https://pr-5-api.preview.test",
		);
		expect(await get("pr-5-api.preview.test")).toBe("api-api");

		const previewIds = [
			env?.id ?? "",
			...svcs.map((s) => s.id),
			...(
				await h.deps.db
					.select({ id: mount.id })
					.from(mount)
					.where(
						inArray(
							mount.serviceId,
							svcs.map((s) => s.id),
						),
					)
			).map((m) => m.id),
		];
		const labelled = () =>
			["service", "volume", "network"].flatMap((kind) =>
				previewIds.flatMap((id) =>
					docker(
						kind,
						"ls",
						"--filter",
						`label=${LABEL}`,
						"--filter",
						`label=logistack.resource=${id}`,
						"--format",
						"{{.Name}}",
					)
						.split("\n")
						.filter(Boolean),
				),
			);
		expect(labelled().length).toBeGreaterThanOrEqual(4);

		expect((await pr("closed")).json.outcome).toBe("removed");
		const deadline = Date.now() + 120_000;
		while (labelled().length && Date.now() < deadline) {
			await sweepOrphans(w.ctx);
			await Bun.sleep(1000);
		}
		expect(labelled()).toEqual([]);
		// The source stack keeps running.
		expect(
			ours("service").filter((n) =>
				(created.json.services as { id: string }[]).some(
					(s) => n === svcName(w.ctx, s.id),
				),
			),
		).toHaveLength(2);
	}, 600_000);
});
