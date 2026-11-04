import { describe, expect, test } from "bun:test";
import {
	type CaddyRoute,
	compileProxy,
	type ProxyRoute,
	routeId,
} from "../src/index.ts";
import { dashboard, input, routes, settings } from "./fixtures.ts";

const compile = (rs: ProxyRoute[], s = settings) =>
	compileProxy({ settings: s, dashboard, routes: rs });
const httpsRoutes = (rs: ProxyRoute[]) =>
	compile(rs).apps.http.servers.https?.routes ?? [];
const httpRoutes = (rs: ProxyRoute[]) =>
	compile(rs).apps.http.servers.http?.routes ?? [];
const ids = (rs: CaddyRoute[]) => rs.map((r) => r["@id"]);
const byId = (rs: CaddyRoute[], id: string) => rs.find((r) => r["@id"] === id);

test("full config snapshot", () => {
	expect(compileProxy(input)).toMatchSnapshot();
});

test("identical input in any order gives byte-identical JSON", () => {
	const a = JSON.stringify(compileProxy(input));
	const reversed = [...routes].reverse();
	const rotated = [...routes.slice(3), ...routes.slice(0, 3)];
	expect(JSON.stringify(compileProxy({ ...input, routes: reversed }))).toBe(a);
	expect(JSON.stringify(compileProxy({ ...input, routes: rotated }))).toBe(a);
});

test("every domain route carries an @id", () => {
	const all = [...httpsRoutes(routes), ...httpRoutes(routes)];
	expect(all.every((r) => typeof r["@id"] === "string")).toBe(true);
	for (const r of routes)
		expect(all.some((c) => c["@id"] === `ls-domain-${r.domainId}`)).toBe(true);
});

describe("routing order", () => {
	test("dashboard first, exact hosts before wildcards, longest prefix first, 404 last", () => {
		const extra: ProxyRoute = {
			domainId: "d8",
			hostname: "a.preview.example.com",
			upstream: { host: "x", port: 1 },
			https: true,
			cert: "auto",
		};
		expect(ids(httpsRoutes([...routes, extra]))).toEqual([
			"ls-dashboard",
			"ls-domain-d8",
			"ls-domain-d7",
			"ls-domain-d2",
			"ls-domain-d1",
			"ls-domain-d4",
			"ls-domain-d5",
			"ls-domain-d3",
			"ls-not-found-https",
		]);
	});
});

test("path prefix matches the prefix itself and everything below it", () => {
	const r = byId(httpsRoutes(routes), "ls-domain-d2");
	expect(r?.match).toEqual([
		{ host: ["app.example.com"], path: ["/api", "/api/*"] },
	]);
	const trailing = byId(
		httpsRoutes([{ ...routes[1], pathPrefix: "/api/" } as ProxyRoute]),
		"ls-domain-d2",
	);
	expect(trailing?.match?.[0]?.path).toEqual(["/api", "/api/*"]);
	const root = byId(
		httpsRoutes([{ ...routes[1], pathPrefix: "/" } as ProxyRoute]),
		"ls-domain-d2",
	);
	expect(root?.match).toEqual([{ host: ["app.example.com"] }]);
});

test("redirectTo replaces the upstream with a path-preserving 308", () => {
	expect(byId(httpsRoutes(routes), "ls-domain-d5")?.handle).toEqual([
		{
			handler: "static_response",
			status_code: 308,
			headers: { Location: ["https://app.example.com{http.request.uri}"] },
		},
	]);
});

test("http to https redirect covers every https host, http-only routes stay on :80", () => {
	const http = httpRoutes(routes);
	expect(ids(http)).toEqual([
		"ls-https-redirect",
		"ls-domain-d6",
		"ls-not-found-http",
	]);
	expect(http[0]?.match?.[0]?.host).toEqual([
		"*.preview.example.com",
		"api.example.net",
		"app.example.com",
		"ls.example.com",
		"shop.example.org",
		"www.example.com",
	]);
	expect(ids(httpsRoutes(routes))).not.toContain("ls-domain-d6");
});

test("custom cert is loaded as PEM and has no DNS-01 policy", () => {
	const cfg = compile(routes);
	expect(cfg.apps.tls.certificates?.load_pem).toEqual([
		{ certificate: "CERT-PEM", key: "KEY-PEM", tags: ["ls-cert-c1"] },
	]);
	const subjects = cfg.apps.tls.automation.policies.flatMap(
		(p) => p.subjects ?? [],
	);
	expect(subjects).not.toContain("shop.example.org");
});

test("no custom certs means no certificates block", () => {
	const cfg = compile([routes[0] as ProxyRoute]);
	expect(cfg.apps.tls.certificates).toBeUndefined();
});

describe("automation policies", () => {
	test("DNS-01 subjects grouped per credential, HTTP-01 catch-all last", () => {
		const r53: ProxyRoute = {
			domainId: "d9",
			hostname: "r53.example.io",
			upstream: { host: "x", port: 1 },
			https: true,
			cert: "auto",
			dnsChallenge: {
				provider: "route53",
				credentials: {
					access_key_id: "AK",
					secret_access_key: "SK",
					region: "eu-west-1",
				},
			},
		};
		const policies = compile([...routes, r53]).apps.tls.automation.policies;
		expect(policies.map((p) => p.subjects)).toEqual([
			["*.preview.example.com", "api.example.net"],
			["r53.example.io"],
			undefined,
		]);
		expect(policies[0]?.issuers).toEqual([
			{
				module: "acme",
				ca: "https://acme-v02.api.letsencrypt.org/directory",
				email: "ops@example.com",
				challenges: {
					dns: { provider: { name: "cloudflare", api_token: "cf-token" } },
				},
			},
		]);
		expect(policies[2]?.issuers).toEqual([
			{
				module: "acme",
				ca: "https://acme-v02.api.letsencrypt.org/directory",
				email: "ops@example.com",
			},
		]);
	});

	test("same provider with different credentials gets separate policies", () => {
		const other: ProxyRoute = {
			...(routes[6] as ProxyRoute),
			domainId: "d10",
			hostname: "b.example.net",
		};
		if (other.cert === "auto")
			other.dnsChallenge = {
				provider: "cloudflare",
				credentials: { api_token: "other" },
			};
		const subjects = compile([
			routes[6] as ProxyRoute,
			other,
		]).apps.tls.automation.policies.map((p) => p.subjects);
		expect(subjects).toHaveLength(3);
	});

	test("ZeroSSL is added as fallback issuer on every policy", () => {
		const policies = compile(routes, {
			...settings,
			zerossl: { keyId: "kid", macKey: "mac" },
		}).apps.tls.automation.policies;
		for (const p of policies) {
			expect(p.issuers).toHaveLength(2);
			expect(p.issuers[1]).toMatchObject({
				module: "acme",
				ca: "https://acme.zerossl.com/v2/DV90",
				external_account: { key_id: "kid", mac_key: "mac" },
			});
		}
	});
});

test("wildcard without DNS challenge is rejected", () => {
	expect(() =>
		compile([
			{
				domainId: "w",
				hostname: "*.x.example.com",
				upstream: { host: "x", port: 1 },
				https: true,
				cert: "auto",
			},
		]),
	).toThrow(/domain w: wildcard/);
});

test("redis URL becomes storage fields", () => {
	expect(compile([]).storage).toEqual({
		module: "redis",
		address: ["ls-redis:6379"],
		password: "s3cret",
		db: 2,
		key_prefix: "logistack/caddy",
		tls_enabled: false,
	});
	const tls = compile([], {
		...settings,
		storage: { redisUrl: "rediss://u:p%40w@r.example:7000", keyPrefix: "k" },
	});
	expect(tls.storage).toMatchObject({
		address: ["r.example:7000"],
		username: "u",
		password: "p@w",
		db: 0,
		tls_enabled: true,
	});
});

test("grace period, access log and admin listen are set", () => {
	const cfg = compile([]);
	expect(cfg.apps.http.grace_period).toBe("10s");
	expect(cfg.admin.listen).toBe("0.0.0.0:2019");
	expect(cfg.logging.logs.access?.include).toEqual([
		"http.log.access.ls-access",
	]);
	expect(cfg.apps.http.servers.https?.logs).toEqual({
		default_logger_name: "ls-access",
	});
});

test("basic auth runs before the upstream, and never on a redirect", () => {
	const base = routes.find((r) => r.https && !r.redirectTo) as ProxyRoute;
	const users = [{ username: "ops", hash: "$2a$10$abc" }];
	const all = [...httpsRoutes([{ ...base, basicAuth: users }])];
	const handle = byId(all, routeId(base.domainId))?.handle;
	expect(handle?.[0]).toEqual({
		handler: "authentication",
		providers: {
			http_basic: {
				accounts: [{ username: "ops", password: "$2a$10$abc" }],
				hash: { algorithm: "bcrypt" },
				realm: "restricted",
			},
		},
	});
	expect(handle?.[1]?.handler).toBe("reverse_proxy");
});
