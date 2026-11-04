import { expect, test } from "bun:test";
import {
	healthPathIssue,
	LB_DEFAULTS,
	lbIssue,
	loadBalancerConfig,
	readLoadBalancer,
	targetIssue,
	WEBSERVERS,
	webserverKind,
	webserverMounts,
} from "./webservers";

test("the load balancer config round-trips through its marker line", () => {
	const s = {
		targets: ["web:3000", " 10.0.0.5:8080 ", ""],
		algorithm: "leastconn" as const,
		healthPath: "/healthz",
	};
	const config = loadBalancerConfig(s);
	expect(config).toContain("balance leastconn");
	expect(config).toContain("option httpchk GET /healthz");
	expect(config).toContain(
		"server s1 web:3000 check resolvers docker init-addr libc,none",
	);
	expect(config).toContain("server s2 10.0.0.5:8080 check");
	expect(readLoadBalancer(config)).toEqual({
		...s,
		targets: ["web:3000", "10.0.0.5:8080"],
	});
});

test("no health path checks TCP only", () => {
	const config = loadBalancerConfig({ ...LB_DEFAULTS, healthPath: "" });
	expect(config).not.toContain("httpchk");
});

test("a hand-edited or foreign config has no form values", () => {
	const config = loadBalancerConfig({ ...LB_DEFAULTS, targets: ["web:80"] });
	expect(readLoadBalancer(`${config}    # tweak\n`)).toBeUndefined();
	expect(readLoadBalancer("global\n")).toBeUndefined();
	expect(readLoadBalancer("# logistack:lb {not json\n")).toBeUndefined();
	expect(readLoadBalancer(WEBSERVERS.haproxy.defaultConfig)).toEqual(
		LB_DEFAULTS,
	);
});

test("targets and health paths are validated", () => {
	expect(targetIssue("web:3000")).toBeUndefined();
	expect(targetIssue("api.internal.example.com:443")).toBeUndefined();
	expect(targetIssue("web")).toBeDefined();
	expect(targetIssue("web:0")).toBeDefined();
	expect(targetIssue("web:70000")).toBeDefined();
	expect(targetIssue("we b:80")).toBeDefined();
	expect(targetIssue("web;rm:80")).toBeDefined();
	expect(healthPathIssue("")).toBeUndefined();
	expect(healthPathIssue("/health?x=1")).toBeUndefined();
	expect(healthPathIssue("health")).toBeDefined();
	expect(healthPathIssue("/a b")).toBeDefined();
	expect(lbIssue(LB_DEFAULTS)).toBe("Add at least one target.");
	expect(lbIssue({ ...LB_DEFAULTS, targets: ["web:80", " "] })).toBeUndefined();
	expect(lbIssue({ ...LB_DEFAULTS, targets: ["web"] })).toContain("web:");
	expect(
		lbIssue({ ...LB_DEFAULTS, targets: ["web:80"], healthPath: "x" }),
	).toBeDefined();
});

test("presets mount their config, and a static volume unless they balance", () => {
	expect(webserverMounts("nginx", "x").map((m) => m.kind)).toEqual([
		"config",
		"volume",
	]);
	expect(webserverMounts("haproxy", "x").map((m) => m.kind)).toEqual([
		"config",
	]);
	expect(webserverKind("webserver:caddy")).toBe("caddy");
	expect(webserverKind("webserver:iis")).toBeUndefined();
	expect(webserverKind("template:x:y/z")).toBeUndefined();
	expect(webserverKind(null)).toBeUndefined();
});
