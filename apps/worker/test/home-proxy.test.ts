import { describe, expect, test } from "bun:test";
import { compileProxy, PRIVATE_RANGES } from "@logistack/proxy";
import {
	HOME_PROXY_RECORD_COMMENT,
	homeProxyCandidates,
	homeProxyRecordsPlan,
} from "../src/home-proxy.ts";
import { withInstanceWildcard } from "../src/proxy.ts";

const now = new Date(0);
const route = (name: string, upstream: string, insecure = false) => ({
	id: `hpr_${name}`,
	name,
	upstream,
	insecure,
	createdAt: now,
	updatedAt: now,
});
const cf = {
	provider: "cloudflare",
	credentials: { api_token: "t" },
} as const;

describe("local proxy routes", () => {
	const routes = homeProxyCandidates(
		{ zone: "home.example.com", tls: "acme" },
		[
			route("nas", "https://192.168.1.10:5001", true),
			route("ha", "http://192.168.1.20:8123"),
			route("v6", "http://[fd00::5]:80"),
			route("broken", "ftp://x"),
		],
		cf,
	);

	test("one per valid upstream, private clients only, DNS-01 on the zone's provider", () => {
		expect(routes.map((r) => r.hostname)).toEqual([
			"nas.home.example.com",
			"ha.home.example.com",
			"v6.home.example.com",
		]);
		expect(routes[0]).toMatchObject({
			domainId: "local-hpr_nas",
			upstream: { host: "192.168.1.10", port: 5001, tls: { insecure: true } },
			https: true,
			cert: "auto",
			dnsChallenge: cf,
			access: [{ type: "ip_allow", cidrs: PRIVATE_RANGES }],
		});
		expect(routes[1]?.upstream).toEqual({ host: "192.168.1.20", port: 8123 });
	});

	test("compile: TLS transport for https upstreams, bracketed IPv6 dial, 403 outside the LAN", () => {
		const cfg = compileProxy({
			settings: {
				adminListen: "127.0.0.1:2019",
				acmeEmail: "",
				storage: { redisUrl: "redis://r", keyPrefix: "caddy" },
			},
			dashboard: {
				hostname: "stack.example.com",
				upstream: { host: "api", port: 3000 },
			},
			routes,
		});
		const json = JSON.stringify(cfg);
		const handlers = (id: string) =>
			cfg.apps.http.servers.https?.routes.find(
				(r) => r["@id"] === `ls-domain-${id}`,
			)?.handle as {
				handler: string;
				transport?: unknown;
				upstreams?: { dial: string }[];
			}[];
		const proxy = (id: string) =>
			handlers(id).find((h) => h.handler === "reverse_proxy");
		expect(proxy("local-hpr_nas")?.transport).toEqual({
			protocol: "http",
			tls: { insecure_skip_verify: true },
		});
		expect(proxy("local-hpr_ha")?.transport).toBeUndefined();
		expect(proxy("local-hpr_v6")?.upstreams).toEqual([
			{ dial: "[fd00::5]:80" },
		]);
		expect(handlers("local-hpr_ha")[0]?.handler).toBe("subroute");
		expect(json).toContain('"status_code":403');
	});

	test("internal CA: the zone wildcard gets its own internal-issuer policy", () => {
		const base = compileProxy({
			settings: {
				adminListen: "127.0.0.1:2019",
				acmeEmail: "",
				storage: { redisUrl: "redis://r", keyPrefix: "caddy" },
			},
			dashboard: {
				hostname: "stack.example.com",
				upstream: { host: "api", port: 3000 },
			},
			routes: homeProxyCandidates(
				{ zone: "home.lan", tls: "internal" },
				[route("nas", "192.168.1.10:5000")],
				undefined,
			),
		});
		const cfg = withInstanceWildcard(
			withInstanceWildcard(base, "*.home.lan", "internal"),
			"*.home.lan",
			"internal",
		);
		const tls = cfg.apps.tls as typeof cfg.apps.tls & {
			certificates: { automate: string[] };
		};
		expect(tls.certificates.automate).toEqual(["*.home.lan"]);
		expect(tls.automation.policies[0]).toEqual({
			subjects: ["*.home.lan"],
			issuers: [{ module: "internal" }],
		});
		expect(
			tls.automation.policies.filter((p) => p.subjects?.includes("*.home.lan")),
		).toHaveLength(1);
	});
});

describe("local proxy records on the home DNS", () => {
	const ours = (name: string, content = "192.168.1.2") => ({
		name,
		type: "A",
		content,
		comment: HOME_PROXY_RECORD_COMMENT,
	});

	test("adds missing names, drops ours for removed routes or an old address, keeps hand-made ones", () => {
		const plan = homeProxyRecordsPlan(
			[
				ours("nas.home.lan"),
				ours("old.home.lan"),
				ours("ha.home.lan", "192.168.1.9"),
				{ name: "printer.home.lan", type: "A", content: "192.168.1.30" },
			],
			["nas.home.lan", "ha.home.lan"],
			"192.168.1.2",
		);
		expect(plan.add).toEqual([
			{
				name: "ha.home.lan",
				type: "A",
				content: "192.168.1.2",
				ttl: 300,
				comment: HOME_PROXY_RECORD_COMMENT,
			},
		]);
		expect(plan.remove.map((r) => `${r.name} ${r.content}`)).toEqual([
			"old.home.lan 192.168.1.2",
			"ha.home.lan 192.168.1.9",
		]);
	});

	test("a hand-made record with the same name and address stands in for ours and stays", () => {
		const handMade = { name: "ha.home.lan", type: "A", content: "192.168.1.2" };
		expect(
			homeProxyRecordsPlan([handMade], ["ha.home.lan"], "192.168.1.2"),
		).toEqual({ add: [], remove: [] });
	});

	test("converged: nothing to do", () => {
		expect(
			homeProxyRecordsPlan(
				[ours("nas.home.lan")],
				["nas.home.lan"],
				"192.168.1.2",
			),
		).toEqual({ add: [], remove: [] });
	});
});
