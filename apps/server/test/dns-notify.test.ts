import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decrypt } from "@logistack/core";
import {
	auditLog,
	certificate,
	dnsProvider,
	domain,
	notificationChannel,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import { channelStatusKey, redisFor } from "../src/redis.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const fixture = (name: string) =>
	readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const TOKEN = "cf-test-token-0123456789";

type CfRecord = {
	id: string;
	name: string;
	type: string;
	content: string;
	ttl: number;
	proxied: boolean;
};

/**
 * Stands in for api.cloudflare.com: one zone, an in-memory record table, and a request log.
 * Any other host (chat webhooks) is recorded and answered 200.
 */
function fakeCloudflare() {
	const records = new Map<string, CfRecord>();
	const calls: {
		method: string;
		url: string;
		host: string | null;
		body?: unknown;
	}[] = [];
	let next = 1;
	const state = { originDenied: false };
	const zones = [{ id: "zone-example", name: "example.com" }];
	const real = globalThis.fetch;
	const ok = (result: unknown) =>
		Response.json({ success: true, result, result_info: { total_pages: 1 } });
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({
			method,
			url: url.href,
			host: new Headers(init?.headers).get("host"),
			body,
		});
		if (url.hostname !== "api.cloudflare.com") return new Response("ok");
		const auth = new Headers(init?.headers).get("authorization");
		if (auth !== `Bearer ${TOKEN}`)
			return Response.json(
				{ success: false, errors: [{ message: "Invalid API Token" }] },
				{ status: 403 },
			);
		const path = url.pathname.replace("/client/v4", "");
		if (path === "/zones") return ok(zones);
		if (path === "/certificates") {
			if (state.originDenied)
				return Response.json(
					{
						success: false,
						errors: [{ code: 10000, message: "Authentication error" }],
					},
					{ status: 403 },
				);
			return ok(
				method === "POST"
					? { id: "origin-1", certificate: signCsr(body.csr, body.hostnames) }
					: [],
			);
		}
		const m = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
		if (!m) return new Response("not found", { status: 404 });
		const id = m[2];
		if (method === "GET")
			return ok(
				[...records.values()].filter(
					(r) =>
						(!url.searchParams.get("name") ||
							r.name === url.searchParams.get("name")) &&
						(!url.searchParams.get("type") ||
							r.type === url.searchParams.get("type")),
				),
			);
		if (method === "DELETE") {
			if (!id || !records.delete(id))
				return new Response("gone", { status: 404 });
			return ok({ id });
		}
		const rec = { ...body, id: id ?? `rec-${next++}` } as CfRecord;
		records.set(rec.id, rec);
		return ok(rec);
	}) as typeof fetch;
	return { records, calls, state, restore: () => (globalThis.fetch = real) };
}

/** Stands in for Origin CA's signer: the fixture certificate signs the CSR's key with the requested SANs. */
function signCsr(csr: string, hostnames: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "ls-test-dns-origin-"));
	try {
		const ext = join(dir, "ext.cnf");
		writeFileSync(
			ext,
			`subjectAltName=${hostnames.map((h) => `DNS:${h}`).join(",")}\n`,
		);
		const files = ["custom-cert.pem", "custom-key.pem"].map((f) =>
			join(import.meta.dir, "fixtures", f),
		);
		const p = Bun.spawnSync(
			[
				"openssl",
				"x509",
				"-req",
				"-days",
				"30",
				"-set_serial",
				"7",
				"-CA",
				files[0] as string,
				"-CAkey",
				files[1] as string,
				"-extfile",
				ext,
			],
			{ stdin: Buffer.from(csr), stdout: "pipe", stderr: "pipe" },
		);
		if (p.exitCode !== 0) throw new Error(p.stderr.toString());
		return p.stdout.toString();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const imageSpec = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [{ target: 80, protocol: "tcp" }],
	replicas: 1,
	resources: {},
	placement: [],
};

describe.skipIf(!hasDocker)("dns, domains, certificates, notifications", () => {
	let h: Harness;
	let cookie: string;
	let cf: ReturnType<typeof fakeCloudflare>;
	let serviceId: string;
	let providerId: string;
	const as = (extra: { body?: unknown } = {}) => ({
		headers: { cookie },
		...extra,
	});

	beforeAll(async () => {
		h = await startHarness({ area: "dns", label: "dns" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call(
			"POST",
			"/api/projects",
			as({ body: { name: "Shop" } }),
		);
		const envs = await h.call(
			"GET",
			`/api/projects/${project.json.id}/environments`,
			as(),
		);
		const svc = await h.call(
			"POST",
			`/api/environments/${envs.json[0].id}/services`,
			as({ body: { name: "Web", spec: imageSpec } }),
		);
		serviceId = svc.json.id;
		cf = fakeCloudflare();
	}, 60_000);
	afterAll(async () => {
		cf?.restore();
		await h?.close();
	});

	test("config schemas are public and mark credentials secret", async () => {
		const res = await h.call("GET", "/api/integrations/schemas");
		expect(res.status).toBe(200);
		expect(res.json.dns.cloudflare.properties.apiToken.secret).toBe(true);
		expect(res.json.dns.route53.properties.accessKeyId.secret).toBeUndefined();
		expect(res.json.notify.slack.properties.webhookUrl.secret).toBe(true);
	});

	test("testing credentials verifies them and lists zones", async () => {
		const bad = await h.call(
			"POST",
			"/api/dns-providers/test",
			as({ body: { kind: "cloudflare", credentials: { apiToken: "nope" } } }),
		);
		expect(bad.status).toBe(400);
		expect(bad.json.error.message).toContain("HTTP 403");
		const shape = await h.call(
			"POST",
			"/api/dns-providers/test",
			as({ body: { kind: "cloudflare", credentials: {} } }),
		);
		expect(shape.json.error.code).toBe("validation_failed");
		const good = await h.call(
			"POST",
			"/api/dns-providers/test",
			as({ body: { kind: "cloudflare", credentials: { apiToken: TOKEN } } }),
		);
		expect(good.status).toBe(200);
		expect(good.json.zones).toEqual([
			{ id: "zone-example", name: "example.com" },
		]);
	});

	test("create stores credentials encrypted and never returns them", async () => {
		const res = await h.call(
			"POST",
			"/api/dns-providers",
			as({
				body: {
					kind: "cloudflare",
					name: "Cloudflare",
					credentials: { apiToken: TOKEN, stray: "dropped" },
					zones: [{ id: "zone-example", name: "example.com" }],
				},
			}),
		);
		expect(res.status).toBe(201);
		providerId = res.json.id;
		expect(JSON.stringify(res.json)).not.toContain(TOKEN);
		const [row] = await h.deps.db
			.select()
			.from(dnsProvider)
			.where(eq(dnsProvider.id, providerId));
		expect(row?.credentialsEncrypted.startsWith("v1:")).toBe(true);
		expect(row?.credentialsEncrypted).not.toContain(TOKEN);
		const audits = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "dns_provider.create"));
		expect(audits).toHaveLength(1);
		expect(JSON.stringify(audits[0]?.diff)).not.toContain(TOKEN);

		const list = await h.call("GET", "/api/dns-providers", as());
		expect(list.json).toEqual([
			expect.objectContaining({
				id: providerId,
				kind: "cloudflare",
				zones: [{ id: "zone-example", name: "example.com" }],
				domains: 0,
			}),
		]);
		const renamed = await h.call(
			"PATCH",
			`/api/dns-providers/${providerId}`,
			as({ body: { name: "CF main" } }),
		);
		expect(renamed.json.name).toBe("CF main");
		const zones = await h.call(
			"GET",
			`/api/dns-providers/${providerId}/zones`,
			as(),
		);
		expect(zones.json.zones).toHaveLength(1);
	});

	test("a domain in a managed zone gets its record, and loses it on delete", async () => {
		const match = await h.call(
			"GET",
			`/api/services/${serviceId}/dns-match?hostname=shop.example.com`,
			as(),
		);
		expect(match.json).toEqual({
			publicIp: "203.0.113.7",
			match: {
				providerId,
				providerName: "CF main",
				kind: "cloudflare",
				zone: { id: "zone-example", name: "example.com" },
				existing: [],
			},
		});
		const none = await h.call(
			"GET",
			`/api/services/${serviceId}/dns-match?hostname=shop.other.org`,
			as(),
		);
		expect(none.json.match).toBeNull();

		const record = await h.call(
			"POST",
			`/api/services/${serviceId}/dns-records`,
			as({
				body: {
					dnsProviderId: providerId,
					hostname: "shop.example.com",
					type: "A",
					content: "203.0.113.7",
					proxied: true,
				},
			}),
		);
		expect(record.status).toBe(200);
		expect([...cf.records.values()]).toEqual([
			expect.objectContaining({
				name: "shop.example.com",
				type: "A",
				content: "203.0.113.7",
				proxied: true,
			}),
		]);
		// Upsert again: same record, replaced in place.
		const again = await h.call(
			"POST",
			`/api/services/${serviceId}/dns-records`,
			as({
				body: {
					dnsProviderId: providerId,
					hostname: "shop.example.com",
					type: "A",
					content: "203.0.113.8",
				},
			}),
		);
		expect(again.json.id).toBe(record.json.id);
		expect(cf.records.size).toBe(1);

		const created = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({
				body: {
					hostname: "shop.example.com",
					port: 80,
					https: true,
					cert: "auto",
					dnsProviderId: providerId,
					dnsRecordId: record.json.id,
				},
			}),
		);
		expect(created.status).toBe(201);
		const list = await h.call("GET", "/api/domains", as());
		expect(list.json).toEqual([
			expect.objectContaining({
				hostname: "shop.example.com",
				tls: "dns-01",
				status: "pending",
				service: { id: serviceId, name: "Web" },
				certificate: null,
			}),
		]);
		const inUse = await h.call(
			"DELETE",
			`/api/dns-providers/${providerId}`,
			as(),
		);
		expect(inUse.status).toBe(409);

		const del = await h.call("DELETE", `/api/domains/${created.json.id}`, as());
		expect(del.status).toBe(204);
		expect(cf.records.size).toBe(0);
		expect(
			cf.calls.some(
				(c) =>
					c.method === "DELETE" &&
					c.url.endsWith(`/dns_records/${record.json.id}`),
			),
		).toBe(true);
	});

	test("zone records: list, create, edit, delete, managed ones marked", async () => {
		const base = `/api/dns-providers/${providerId}/zones/zone-example/records`;
		const mx = await h.call(
			"POST",
			base,
			as({
				body: {
					name: "Example.com",
					type: "MX",
					ttl: 1,
					values: ["10 mail.example.com."],
					comment: "primary",
				},
			}),
		);
		expect(mx.status).toBe(201);
		expect(mx.json).toMatchObject({
			name: "example.com",
			type: "MX",
			values: ["10 mail.example.com"],
			comment: "primary",
			domain: null,
		});
		expect(cf.records.get(mx.json.id)).toMatchObject({
			priority: 10,
			content: "mail.example.com",
		});

		const invalid = await h.call(
			"POST",
			base,
			as({
				body: {
					name: "x.other.org",
					type: "A",
					ttl: 30,
					values: ["1.2.3.999"],
				},
			}),
		);
		expect(invalid.status).toBe(400);
		expect(invalid.json.error.message).toContain("Must be inside example.com");

		const a = await h.call(
			"POST",
			base,
			as({
				body: {
					name: "shop.example.com",
					type: "A",
					ttl: 1,
					values: ["203.0.113.7"],
					proxied: true,
				},
			}),
		);
		const dom = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({
				body: {
					hostname: "shop.example.com",
					port: 80,
					https: true,
					cert: "auto",
					dnsProviderId: providerId,
					dnsRecordId: a.json.id,
				},
			}),
		);
		expect(dom.status).toBe(201);

		const list = await h.call("GET", base, as());
		expect(list.status).toBe(200);
		expect(list.json.zone).toEqual({ id: "zone-example", name: "example.com" });
		expect(list.json.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: mx.json.id, domain: null }),
				expect.objectContaining({
					id: a.json.id,
					proxied: true,
					domain: { id: dom.json.id, hostname: "shop.example.com" },
				}),
			]),
		);

		const edited = await h.call(
			"PUT",
			`${base}/${mx.json.id}`,
			as({
				body: {
					name: "example.com",
					type: "MX",
					ttl: 300,
					values: ["20 mx2.example.com"],
				},
			}),
		);
		expect(edited.status).toBe(200);
		expect(edited.json.values).toEqual(["20 mx2.example.com"]);

		const unknownZone = await h.call(
			"GET",
			`/api/dns-providers/${providerId}/zones/nope/records`,
			as(),
		);
		expect(unknownZone.status).toBe(404);
		// Route 53 and Hetzner ids carry a slash; it must survive the path.
		const slashed = await h.call("DELETE", `${base}/a%2Fb`, as());
		expect(slashed.status).toBe(204);

		for (const id of [mx.json.id, a.json.id]) {
			const del = await h.call("DELETE", `${base}/${id}`, as());
			expect(del.status).toBe(204);
		}
		expect(cf.records.size).toBe(0);
		const [row] = await h.deps.db
			.select()
			.from(domain)
			.where(eq(domain.id, dom.json.id));
		expect(row?.dnsRecordId).toBeNull();
		await h.call("DELETE", `/api/domains/${dom.json.id}`, as());
		const audits = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "dns_record.delete"));
		expect(audits.length).toBeGreaterThanOrEqual(2);
	});

	test("wildcards are refused without DNS-01 through a provider owning the zone", async () => {
		const post = (body: Record<string, unknown>) =>
			h.call(
				"POST",
				`/api/services/${serviceId}/domains`,
				as({ body: { port: 80, https: true, cert: "auto", ...body } }),
			);
		const noProvider = await post({ hostname: "*.apps.example.com" });
		expect(noProvider.status).toBe(400);
		expect(noProvider.json.error.message).toContain("DNS-01");
		const httpOnly = await post({
			hostname: "*.apps.example.com",
			https: false,
			cert: "none",
			dnsProviderId: providerId,
		});
		expect(httpOnly.status).toBe(400);
		const wrongZone = await post({
			hostname: "*.apps.other.org",
			dnsProviderId: providerId,
		});
		expect(wrongZone.status).toBe(400);
		expect(wrongZone.json.error.message).toContain("does not manage");
		const ok = await post({
			hostname: "*.apps.example.com",
			dnsProviderId: providerId,
		});
		expect(ok.status).toBe(201);
		await h.call("DELETE", `/api/domains/${ok.json.id}`, as());
	});

	test("custom certificates: parsed, validated, matched to hostnames", async () => {
		const certPem = fixture("custom-cert.pem");
		const privateKey = fixture("custom-key.pem");
		const inspect = await h.call(
			"POST",
			"/api/certificates/inspect",
			as({ body: { certPem, privateKey } }),
		);
		expect(inspect.status).toBe(200);
		expect(inspect.json).toEqual({
			sans: ["custom.test", "*.custom.test"],
			issuer: "custom.test",
			notBefore: expect.any(String),
			notAfter: "2126-10-10T11:48:00.000Z",
		});
		const mismatch = await h.call(
			"POST",
			"/api/certificates/inspect",
			as({ body: { certPem, privateKey: fixture("other-key.pem") } }),
		);
		expect(mismatch.status).toBe(400);
		expect(mismatch.json.error.message).toContain("does not belong");
		const garbage = await h.call(
			"POST",
			"/api/certificates/inspect",
			as({ body: { certPem: "hello", privateKey } }),
		);
		expect(garbage.json.error.message).toContain("PEM");

		const stored = await h.call(
			"POST",
			"/api/certificates",
			as({ body: { name: "Custom", certPem, privateKey } }),
		);
		expect(stored.status).toBe(201);
		const audit = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "certificate.create"));
		expect(JSON.stringify(audit[0]?.diff)).not.toContain("PRIVATE KEY");

		const wrongHost = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({
				body: {
					hostname: "shop.example.com",
					port: 80,
					https: true,
					cert: "custom",
					customCertificateId: stored.json.id,
				},
			}),
		);
		expect(wrongHost.status).toBe(400);
		expect(wrongHost.json.error.message).toContain("does not cover");
		const dom = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({
				body: {
					hostname: "a.custom.test",
					port: 80,
					https: true,
					cert: "custom",
					customCertificateId: stored.json.id,
				},
			}),
		);
		expect(dom.status).toBe(201);
		const list = await h.call("GET", "/api/certificates", as());
		expect(list.json.custom).toEqual([
			expect.objectContaining({ name: "Custom", domains: 1 }),
		]);
		const busy = await h.call(
			"DELETE",
			`/api/certificates/${stored.json.id}`,
			as(),
		);
		expect(busy.status).toBe(409);
		await h.call("DELETE", `/api/domains/${dom.json.id}`, as());
		expect(
			(await h.call("DELETE", `/api/certificates/${stored.json.id}`, as()))
				.status,
		).toBe(204);
	});

	test("Cloudflare Origin CA: key and CSR made here, certificate stored and bound", async () => {
		const dom = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({
				body: {
					hostname: "origin.example.com",
					port: 80,
					https: true,
					cert: "auto",
				},
			}),
		);
		expect(dom.status).toBe(201);
		const base = `/api/domains/${dom.json.id}/origin-certificate`;
		const check = await h.call("POST", `${base}/test`, as());
		expect(check.json).toEqual({
			hostname: "origin.example.com",
			provider: { id: providerId, name: expect.any(String) },
			zone: { id: "zone-example", name: "example.com" },
			permission: "Zone > SSL and Certificates > Edit",
		});

		cf.state.originDenied = true;
		const denied = await h.call("POST", `${base}/test`, as());
		expect(denied.status).toBe(400);
		expect(denied.json.error.message).toContain("SSL and Certificates > Edit");
		cf.state.originDenied = false;

		const issued = await h.call(
			"POST",
			base,
			as({ body: { keyType: "ecc", validityDays: 5475 } }),
		);
		expect(issued.status).toBe(201);
		expect(issued.json).toMatchObject({
			sans: ["origin.example.com"],
			issuer: "custom.test",
			domains: 1,
		});
		const sent = cf.calls.find(
			(x) => x.method === "POST" && x.url.endsWith("/certificates"),
		)?.body as Record<string, unknown>;
		expect(sent).toMatchObject({
			hostnames: ["origin.example.com"],
			request_type: "origin-ecc",
			requested_validity: 5475,
		});
		expect(String(sent.csr)).toStartWith("-----BEGIN CERTIFICATE REQUEST-----");

		const [d] = await h.deps.db
			.select()
			.from(domain)
			.where(eq(domain.id, dom.json.id));
		expect(d).toMatchObject({
			https: true,
			cert: "custom",
			customCertificateId: issued.json.id,
			status: "pending",
		});
		const [crt] = await h.deps.db
			.select()
			.from(certificate)
			.where(eq(certificate.id, issued.json.id));
		expect(crt?.keyPemEncrypted).not.toContain("PRIVATE KEY");
		expect(
			await decrypt(h.deps.masterKey, crt?.keyPemEncrypted as string),
		).toStartWith("-----BEGIN PRIVATE KEY-----");
		const audits = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "certificate.origin_issue"));
		expect(JSON.stringify(audits)).not.toContain("PRIVATE KEY");

		const outside = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({
				body: { hostname: "x.other.org", port: 80, https: true, cert: "auto" },
			}),
		);
		const none = await h.call(
			"POST",
			`/api/domains/${outside.json.id}/origin-certificate/test`,
			as(),
		);
		expect(none.status).toBe(400);
		expect(none.json.error.message).toContain("No Cloudflare DNS provider");
		for (const id of [dom.json.id, outside.json.id])
			await h.call("DELETE", `/api/domains/${id}`, as());
		await h.call("DELETE", `/api/certificates/${issued.json.id}`, as());
	});

	test("managed certificates come from the worker's snapshot", async () => {
		await redisFor(h.config.REDIS_URL).set(
			"ls:certs",
			JSON.stringify({
				at: new Date().toISOString(),
				certs: [
					{
						names: ["*.example.com"],
						issuer: "R11",
						notBefore: "2026-10-01T00:00:00.000Z",
						notAfter: "2026-12-30T00:00:00.000Z",
					},
				],
			}),
		);
		const dom = await h.call(
			"POST",
			`/api/services/${serviceId}/domains`,
			as({
				body: {
					hostname: "blog.example.com",
					port: 80,
					https: true,
					cert: "auto",
				},
			}),
		);
		const list = await h.call("GET", "/api/domains", as());
		expect(list.json[0]).toMatchObject({
			hostname: "blog.example.com",
			tls: "http-01",
			certificate: {
				source: "managed",
				issuer: "R11",
				notAfter: "2026-12-30T00:00:00.000Z",
			},
		});
		const certs = await h.call("GET", "/api/certificates", as());
		expect(certs.json.managed).toHaveLength(1);
		await h.call("DELETE", `/api/domains/${dom.json.id}`, as());
	});

	test("the ACME directory defaults to Let's Encrypt and can be switched", async () => {
		expect(
			(await h.call("GET", "/api/certificates/issuer", as())).json,
		).toEqual({ directory: "letsencrypt" });
		const bad = await h.call(
			"PUT",
			"/api/certificates/issuer",
			as({ body: { directory: "buypass" } }),
		);
		expect(bad.status).toBe(400);
		const put = await h.call(
			"PUT",
			"/api/certificates/issuer",
			as({ body: { directory: "letsencrypt-staging" } }),
		);
		expect(put.json).toEqual({ directory: "letsencrypt-staging" });
		expect(
			(await h.call("GET", "/api/certificates/issuer", as())).json.directory,
		).toBe("letsencrypt-staging");
	});

	test("notification channels: test, store encrypted, rules, delivery status", async () => {
		// A real public name: the SSRF guard resolves it before the fake fetch answers.
		const config = {
			webhookUrl: "https://hooks.slack.com/services/T000/B000/secret",
		};
		const sent = await h.call(
			"POST",
			"/api/notification-channels/test",
			as({ body: { kind: "slack", config } }),
		);
		expect(sent.status).toBe(200);
		// Pinned to the checked address, with the name kept in Host.
		const last = cf.calls.at(-1);
		expect(last?.host).toBe("hooks.slack.com");
		expect(new URL(last?.url ?? "").pathname).toBe(
			"/services/T000/B000/secret",
		);
		for (const [webhookUrl, why] of [
			["https://127.0.0.1/hook", "private address"],
			["https://[::1]/hook", "private address"],
			["http://hooks.slack.com/services/x", "only https"],
		])
			expect(
				(
					await h.call(
						"POST",
						"/api/notification-channels/test",
						as({ body: { kind: "slack", config: { webhookUrl } } }),
					)
				).json.error.message,
			).toContain(why);
		const invalid = await h.call(
			"POST",
			"/api/notification-channels/test",
			as({ body: { kind: "slack", config: { webhookUrl: "not a url" } } }),
		);
		expect(invalid.json.error.code).toBe("validation_failed");

		const ch = await h.call(
			"POST",
			"/api/notification-channels",
			as({ body: { kind: "slack", name: "Ops", config } }),
		);
		expect(ch.status).toBe(201);
		const [row] = await h.deps.db
			.select()
			.from(notificationChannel)
			.where(eq(notificationChannel.id, ch.json.id));
		expect(row?.configEncrypted).not.toContain("T000/B000/secret");
		const audits = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.resourceType, "notification_channel"));
		expect(JSON.stringify(audits.map((a) => a.diff))).not.toContain(
			"T000/B000/secret",
		);

		const rule = await h.call(
			"POST",
			"/api/notification-rules",
			as({
				body: {
					events: ["deployment.failed", "certificate.expiring"],
					scope: { serviceId },
					channelId: ch.json.id,
				},
			}),
		);
		expect(rule.status).toBe(201);
		expect(rule.json).toMatchObject({ enabled: true, scope: { serviceId } });
		const foreign = await h.call(
			"POST",
			"/api/notification-rules",
			as({
				body: {
					events: ["deployment.failed"],
					scope: { serviceId: "svc_nope" },
					channelId: ch.json.id,
				},
			}),
		);
		expect(foreign.status).toBe(404);

		await redisFor(h.config.REDIS_URL).set(
			channelStatusKey(ch.json.id),
			JSON.stringify({
				lastSuccessAt: null,
				lastFailureAt: "2026-11-03T10:00:00.000Z",
				lastError: "slack send: HTTP 404: no_service",
				consecutiveFailures: 3,
			}),
		);
		const list = await h.call("GET", "/api/notification-channels", as());
		expect(list.json).toEqual([
			expect.objectContaining({
				name: "Ops",
				rules: 1,
				delivery: expect.objectContaining({
					lastError: "slack send: HTTP 404: no_service",
					consecutiveFailures: 3,
				}),
			}),
		]);
		expect(
			(await h.call("DELETE", `/api/notification-channels/${ch.json.id}`, as()))
				.status,
		).toBe(204);
		expect((await h.call("GET", "/api/notification-rules", as())).json).toEqual(
			[],
		);
	});
});

describe.skipIf(!hasDocker)("setup with a DNS provider", () => {
	let h: Harness;
	let cf: ReturnType<typeof fakeCloudflare>;
	beforeAll(async () => {
		h = await startHarness({ area: "dns", label: "dns" });
		cf = fakeCloudflare();
	}, 60_000);
	afterAll(async () => {
		cf?.restore();
		await h?.close();
	});

	const instance = {
		...setupBody.instance,
		generatedDomainBase: "custom",
		customWildcard: "*.srv1.example.com",
	};

	test("checks the token and zone before writing anything", async () => {
		const bad = await h.call("POST", "/api/setup/dns-provider-check", {
			body: {
				kind: "cloudflare",
				credentials: { apiToken: TOKEN },
				base: "srv1.other.org",
			},
		});
		expect(bad.status).toBe(400);
		expect(bad.json.error.message).toContain("none of its 1 zone");
		const ok = await h.call("POST", "/api/setup/dns-provider-check", {
			body: {
				kind: "cloudflare",
				credentials: { apiToken: TOKEN },
				base: "srv1.example.com",
			},
		});
		expect(ok.json.zone).toEqual({ id: "zone-example", name: "example.com" });
		expect(cf.records.size).toBe(0);
	});

	test("creates the provider, the base records and the instance wildcard", async () => {
		const res = await h.call("POST", "/api/setup", {
			body: {
				...setupBody,
				instance: {
					...instance,
					dnsProvider: { kind: "cloudflare", credentials: { apiToken: TOKEN } },
				},
			},
		});
		expect(res.status).toBe(201);
		expect(res.json.dnsRecords).toEqual([
			{
				name: "*.srv1.example.com",
				type: "A",
				content: "203.0.113.7",
				error: null,
			},
			{
				name: "srv1.example.com",
				type: "A",
				content: "203.0.113.7",
				error: null,
			},
		]);
		expect(
			[...cf.records.values()].map((r) => [r.name, r.type, r.content]),
		).toEqual([
			["*.srv1.example.com", "A", "203.0.113.7"],
			["srv1.example.com", "A", "203.0.113.7"],
		]);
		const rows = await h.deps.db.select().from(dnsProvider);
		expect(rows).toEqual([
			expect.objectContaining({
				organizationId: res.json.organizationId,
				kind: "cloudflare",
				zonesCache: [{ id: "zone-example", name: "example.com" }],
			}),
		]);
		expect(rows[0]?.credentialsEncrypted).not.toContain(TOKEN);
		const audit = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "setup.complete"));
		expect(JSON.stringify(audit[0]?.diff)).not.toContain(TOKEN);
	});
});
