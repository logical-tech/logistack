import { expect, test } from "bun:test";
import type { CaddyConfig } from "@logistack/proxy";
import { allowList, gatewayOptions, isAllowed } from "../src/db-gateway.ts";
import { withAutomatedNames } from "../src/proxy.ts";

test("the allowlist matches addresses and ranges, IPv4-mapped clients included", () => {
	const list = allowList(["203.0.113.7", "198.51.100.0/24", "2001:db8::/32"]);
	expect(isAllowed(list, "203.0.113.7")).toBe(true);
	expect(isAllowed(list, "::ffff:203.0.113.7")).toBe(true);
	expect(isAllowed(list, "198.51.100.200")).toBe(true);
	expect(isAllowed(list, "2001:db8::1")).toBe(true);
	expect(isAllowed(list, "203.0.113.8")).toBe(false);
	expect(isAllowed(list, "127.0.0.1")).toBe(false);
	expect(isAllowed(allowList([]), "127.0.0.1")).toBe(false);
});

test("the gateway reads its compiled environment and refuses a bad mode", () => {
	expect(
		gatewayOptions({
			LS_GW_LISTEN: "15000",
			LS_GW_UPSTREAM: "ls-svc-ab12:5432",
			LS_GW_MODE: "postgres",
			LS_GW_ALLOW: "203.0.113.7,198.51.100.0/24",
			LS_GW_EXPIRES_AT: "2026-11-08T12:00:00.000Z",
		}),
	).toEqual({
		port: 15000,
		upstream: { host: "ls-svc-ab12", port: 5432 },
		mode: "postgres",
		allow: ["203.0.113.7", "198.51.100.0/24"],
		expiresAt: new Date("2026-11-08T12:00:00.000Z"),
	});
	expect(() =>
		gatewayOptions({
			LS_GW_LISTEN: "1",
			LS_GW_UPSTREAM: "h:1",
			LS_GW_MODE: "telnet",
		}),
	).toThrow();
});

test("public database hostnames are automated in Caddy unless the wildcard covers them", () => {
	const config = {
		apps: { tls: { automation: { policies: [] } } },
	} as unknown as CaddyConfig;
	const out = withAutomatedNames(
		config,
		["db.example.com", "pg.apps.example.com", "db.example.com"],
		"*.apps.example.com",
	);
	expect(
		(out.apps.tls as { certificates?: { automate?: string[] } }).certificates
			?.automate,
	).toEqual(["db.example.com"]);
	expect(withAutomatedNames(config, [])).toBe(config);
});
