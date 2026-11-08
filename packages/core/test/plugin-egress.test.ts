import { describe, expect, test } from "bun:test";
import {
	compileEgressProxy,
	egressAllowed,
	egressClientEnv,
	egressPassword,
} from "../src/plugin-egress.ts";

describe("plugin egress", () => {
	test("matches exact hosts and wildcard subdomains only", () => {
		const rules = ["dns.hetzner.com", "*.slack.com", "203.0.113.9"];
		expect(egressAllowed(rules, "dns.hetzner.com")).toBe(true);
		expect(egressAllowed(rules, "DNS.Hetzner.com.")).toBe(true);
		expect(egressAllowed(rules, "hooks.slack.com")).toBe(true);
		expect(egressAllowed(rules, "a.b.slack.com")).toBe(true);
		expect(egressAllowed(rules, "slack.com")).toBe(false);
		expect(egressAllowed(rules, "evilslack.com")).toBe(false);
		expect(egressAllowed(rules, "hetzner.com")).toBe(false);
		expect(egressAllowed(rules, "dns.hetzner.com.evil.io")).toBe(false);
		expect(egressAllowed(rules, "203.0.113.9")).toBe(true);
		expect(egressAllowed(rules, "")).toBe(false);
		expect(egressAllowed([], "example.com")).toBe(false);
	});

	test("passwords differ per install and are stable", async () => {
		const a = await egressPassword("k", "plg_a");
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(await egressPassword("k", "plg_a")).toBe(a);
		expect(await egressPassword("k", "plg_b")).not.toBe(a);
	});

	test("client env points both spellings at the proxy and skips the API", () => {
		const env = egressClientEnv({
			installId: "plg_a",
			password: "pw",
			noProxy: ["logistack_logistack-api"],
		});
		expect(env.HTTPS_PROXY).toBe("http://plg_a:pw@ls-plugin-egress:3128");
		expect(env.https_proxy).toBe(env.HTTPS_PROXY);
		expect(env.NO_PROXY).toBe("logistack_logistack-api,localhost,127.0.0.1");
	});

	test("compiles the proxy service", () => {
		expect(
			compileEgressProxy({
				image: "ghcr.io/logical-tech/logistack:0.6.0",
				key: "k",
				rules: { plg_b: ["b.io", "a.io"], plg_a: ["x.io"] },
				networks: ["net-plugins", "net-egress"],
			}),
		).toMatchSnapshot();
	});
});
