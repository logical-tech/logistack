import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope } from "@logistack/contracts";
import {
	type NotificationChannel,
	type NotificationRule,
	ProviderError,
} from "@logistack/providers";
import { compileProxy, type ProxyRoute } from "@logistack/proxy";
import {
	type CertSubject,
	type DomainRef,
	expiryNotices,
} from "../src/certs.ts";
import type { DomainRow } from "../src/load.ts";
import {
	attempt,
	type DispatchDeps,
	dispatch,
	type Outcome,
} from "../src/notify.ts";
import {
	dnsChallengeFor,
	domainRoute,
	isolateRoutes,
	withAcmeDirectory,
	withInstanceWildcard,
} from "../src/proxy.ts";

const fixture = (name: string) =>
	readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const upstream = { host: "ls-svc-1", port: 80 };
const base = {
	settings: {
		adminListen: "10.0.0.2:2019",
		acmeEmail: "ops@example.com",
		storage: { redisUrl: "redis://redis:6379/0", keyPrefix: "caddy" },
	},
	dashboard: { hostname: "ls.example.com", upstream },
};

describe("proxy sync inputs", () => {
	const row = {
		id: "dom_1",
		serviceId: "svc_1",
		hostname: "custom.test",
		port: 80,
		pathPrefix: null,
		https: true,
		cert: "custom",
		customCertificateId: "crt_1",
		redirectTo: null,
		dnsProviderId: null,
	} as DomainRow;

	test("a route compileProxy throws on is skipped, the rest still compile", () => {
		const good: ProxyRoute = {
			domainId: "dom_good",
			hostname: "app.example.com",
			upstream,
			https: true,
			cert: "auto",
		};
		// Bypasses domainRoute, as an old row or a hand edit would.
		const bad: ProxyRoute = {
			domainId: "dom_bad",
			hostname: "*.apps.example.com",
			upstream,
			https: true,
			cert: "auto",
		};
		expect(() => compileProxy({ ...base, routes: [good, bad] })).toThrow();
		const { routes, errors } = isolateRoutes([good, bad], base);
		expect(routes).toEqual([good]);
		expect([...errors.keys()]).toEqual(["dom_bad"]);
		expect(errors.get("dom_bad")).toContain("needs cert");
		expect(() => compileProxy({ ...base, routes })).not.toThrow();
	});

	test("a custom certificate whose key does not match is a domain error", () => {
		const certPem = fixture("custom-cert.pem");
		expect(
			domainRoute(row, "h", {
				customCert: { certPem, keyPem: fixture("other-key.pem") },
			}),
		).toEqual({
			ok: false,
			error: "the private key does not match the certificate",
		});
		expect(
			domainRoute(row, "h", {
				customCert: { certPem: "garbage", keyPem: fixture("custom-key.pem") },
			}),
		).toMatchObject({ ok: false });
		expect(
			domainRoute(row, "h", {
				customCert: { certPem, keyPem: fixture("custom-key.pem") },
			}),
		).toMatchObject({ ok: true, route: { cert: "custom" } });
	});

	test("stored provider configs become the caddy-dns field names", () => {
		expect(dnsChallengeFor("cloudflare", { apiToken: "t" })).toEqual({
			provider: "cloudflare",
			credentials: { api_token: "t" },
		});
		expect(
			dnsChallengeFor("route53", { accessKeyId: "a", secretAccessKey: "s" }),
		).toEqual({
			provider: "route53",
			credentials: {
				access_key_id: "a",
				secret_access_key: "s",
				region: "us-east-1",
			},
		});
		expect(() => dnsChallengeFor("ovh", {})).toThrow("no DNS-01 support");
	});

	test("the instance wildcard gets one DNS-01 policy and is automated", () => {
		const challenge = dnsChallengeFor("cloudflare", { apiToken: "t" });
		const cfg = withInstanceWildcard(
			compileProxy({
				...base,
				routes: [
					{
						domainId: "d",
						hostname: "web-abc123.srv1.example.com",
						upstream,
						https: true,
						cert: "auto",
					},
				],
			}),
			"*.srv1.example.com",
			challenge,
		);
		const tls = cfg.apps.tls as typeof cfg.apps.tls & {
			certificates: { automate: string[] };
		};
		expect(tls.certificates.automate).toEqual(["*.srv1.example.com"]);
		expect(tls.automation.policies[0]).toEqual({
			subjects: ["*.srv1.example.com"],
			issuers: [
				{
					module: "acme",
					ca: "https://acme-v02.api.letsencrypt.org/directory",
					email: "ops@example.com",
					challenges: {
						dns: { provider: { name: "cloudflare", api_token: "t" } },
					},
				},
			],
		});
		// The catch-all stays last, so other hosts keep HTTP-01.
		expect(tls.automation.policies.at(-1)?.subjects).toBeUndefined();
		const internal = withAcmeDirectory(cfg, "internal");
		expect(
			internal.apps.tls.automation.policies.every(
				(p) => p.issuers.length === 1 && p.issuers[0]?.module === "internal",
			),
		).toBe(true);
		const staging = withAcmeDirectory(cfg, "letsencrypt-staging");
		expect(
			staging.apps.tls.automation.policies.flatMap((p) =>
				p.issuers.map((i) => (i.module === "acme" ? i.ca : i.module)),
			),
		).toEqual([
			"https://acme-staging-v02.api.letsencrypt.org/directory",
			"https://acme-staging-v02.api.letsencrypt.org/directory",
		]);
		// The DNS-01 challenge survives the swap.
		expect(staging.apps.tls.automation.policies[0]?.issuers[0]).toMatchObject({
			challenges: { dns: { provider: { name: "cloudflare" } } },
		});
		expect(withAcmeDirectory(cfg, "letsencrypt")).toBe(cfg);
	});
});

describe("certificate expiry notices", () => {
	const now = new Date("2026-11-03T00:00:00Z");
	const inDays = (d: number) =>
		new Date(now.getTime() + d * 86_400_000 + 3_600_000).toISOString();
	const managed = (names: string[], days: number): CertSubject => ({
		source: "managed",
		cert: {
			names,
			issuer: "R11",
			notBefore: now.toISOString(),
			notAfter: inDays(days),
		},
	});
	const dom = (
		id: string,
		hostname: string,
		serviceId: string,
		org = "org_a",
	): DomainRef => ({
		id,
		hostname,
		tls: "auto",
		customCertificateId: null,
		serviceId,
		projectId: "prj_1",
		organizationId: org,
	});

	test("fires at the tightest crossed threshold, never above 14 days", () => {
		const domains = [dom("d1", "a.example.com", "svc_1")];
		const at = (days: number) =>
			expiryNotices([managed(["a.example.com"], days)], domains, now).map(
				(n) => n.payload.threshold,
			);
		expect(at(30)).toEqual([]);
		expect(at(14)).toEqual([14]);
		expect(at(10)).toEqual([14]);
		expect(at(7)).toEqual([7]);
		expect(at(3)).toEqual([3]);
		expect(at(-1)).toEqual([]);
	});

	test("a wildcard over many services is one notice per organization", () => {
		const notices = expiryNotices(
			[managed(["*.srv1.example.com"], 5)],
			[
				dom("d1", "a.srv1.example.com", "svc_1"),
				dom("d2", "b.srv1.example.com", "svc_2"),
				dom("d3", "c.srv1.example.com", "svc_3", "org_b"),
				dom("d4", "x.other.org", "svc_4"),
			],
			now,
		);
		expect(notices.map((n) => [n.organizationId, n.payload.domains])).toEqual([
			["org_a", 2],
			["org_b", 1],
		]);
		// Two services: unscoped. One service: scoped, so service rules match.
		expect(notices[0]?.payload.serviceId).toBeUndefined();
		expect(notices[0]?.payload.projectId).toBe("prj_1");
		expect(notices[1]?.payload.serviceId).toBe("svc_3");
		expect(new Set(notices.map((n) => n.dedupeKey)).size).toBe(2);
	});

	test("uploads notify their own organization, used or not", () => {
		const [n] = expiryNotices(
			[
				{
					source: "custom",
					id: "crt_1",
					name: "Wildcard 2026",
					organizationId: "org_c",
					cert: {
						names: ["*.custom.test"],
						issuer: "Sectigo",
						notBefore: now.toISOString(),
						notAfter: inDays(2),
					},
				},
			],
			[],
			now,
		);
		expect(n).toMatchObject({
			organizationId: "org_c",
			resource: { type: "certificate", id: "crt_1" },
			payload: { name: "Wildcard 2026", threshold: 3, daysLeft: 2, domains: 0 },
		});
	});
});

describe("notification dispatch", () => {
	const event: EventEnvelope = {
		id: "evt_1",
		type: "deployment.failed",
		organizationId: "org_a",
		resource: { type: "deployment", id: "dep_1" },
		payload: { serviceId: "svc_1", projectId: "prj_1", error: "exit 1" },
		at: new Date("2026-11-03T10:00:00Z"),
	};
	const rule = (
		id: string,
		channelId: string,
		over: Partial<NotificationRule> = {},
	): NotificationRule => ({
		id,
		events: ["deployment.failed"],
		scope: {},
		channelId,
		enabled: true,
		...over,
	});

	function harness(
		rules: NotificationRule[],
		failures: Record<string, unknown[]> = {},
	) {
		const sent: string[] = [];
		const sleeps: number[] = [];
		const recorded: [string, Outcome][] = [];
		const claimed = new Set<string>();
		const channel = (id: string): NotificationChannel => ({
			test: async () => {},
			send: async (e, r) => {
				const next = failures[id]?.shift();
				if (next) throw next;
				sent.push(`${id}:${e.id}:${r.title}`);
			},
		});
		const deps: DispatchDeps = {
			claim: async (id) => !claimed.has(id) && Boolean(claimed.add(id)),
			rules: async () => rules,
			channel: async (id) => (id === "missing" ? null : channel(id)),
			record: async (id, o) => void recorded.push([id, o]),
			// Runs the retry at once; the real one waits in the notify queue.
			retryLater: async (job, ms) => {
				sleeps.push(ms);
				await attempt(job, deps, { attempts: 4, baseMs: 100 });
			},
		};
		return { deps, sent, sleeps, recorded };
	}

	test("matches event × scope, sends each channel once, dedupes by event id", async () => {
		const h = harness([
			rule("r1", "ch_all"),
			rule("r2", "ch_all", { scope: { serviceId: "svc_1" } }),
			rule("r3", "ch_svc2", { scope: { serviceId: "svc_2" } }),
			rule("r4", "ch_off", { enabled: false }),
			rule("r5", "ch_other", { events: ["backup.failed"] }),
			rule("r6", "ch_project", { scope: { projectId: "prj_1" } }),
		]);
		await dispatch(event, h.deps);
		expect(h.sent.sort()).toEqual([
			"ch_all:evt_1:Deployment failed",
			"ch_project:evt_1:Deployment failed",
		]);
		await dispatch(event, h.deps);
		await dispatch({ ...event }, h.deps);
		expect(h.sent).toHaveLength(2);
		expect(h.recorded.map(([id, o]) => [id, o.ok]).sort()).toEqual([
			["ch_all", true],
			["ch_project", true],
		]);
	});

	test("retries with exponential backoff, then records the failure", async () => {
		const h = harness([rule("r1", "ch_flaky"), rule("r2", "ch_dead")], {
			ch_flaky: [
				new Error("ECONNRESET"),
				new ProviderError("slack", "send", "HTTP 502", 502),
			],
			ch_dead: Array.from(
				{ length: 9 },
				() => new ProviderError("x", "send", "HTTP 503", 503),
			),
		});
		const out = await dispatch(event, h.deps, { attempts: 4, baseMs: 100 });
		expect(out.get("ch_flaky")).toBe("retrying");
		expect(Object.fromEntries(h.recorded)).toEqual({
			ch_flaky: { ok: true },
			ch_dead: { ok: false, error: "x send: HTTP 503" },
		});
		// flaky: 2 waits before its 3rd try; dead: 3 waits across 4 tries.
		expect(h.sleeps.sort((a, b) => a - b)).toEqual([100, 100, 200, 200, 400]);
	});

	test("a channel's own 4xx refusal is not retried; 429 is", async () => {
		const h = harness([rule("r1", "ch_gone"), rule("r2", "ch_busy")], {
			ch_gone: [
				new ProviderError("discord", "send", "HTTP 404: Unknown Webhook", 404),
			],
			ch_busy: Array.from(
				{ length: 9 },
				() => new ProviderError("slack", "send", "HTTP 429", 429),
			),
		});
		const out = await dispatch(event, h.deps);
		expect(out.get("ch_gone")).toEqual({
			ok: false,
			error: "discord send: HTTP 404: Unknown Webhook",
		});
		expect(h.sleeps).toHaveLength(3);
	});
});
