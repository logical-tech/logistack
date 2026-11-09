import { expect, test } from "bun:test";
import { forwardAuthRefusal } from "../src/routes/domain-access.ts";
import { hostsOverlap } from "../src/routes/domains.ts";

test("hostnames overlap when equal or under a single-label wildcard, either way", () => {
	expect(hostsOverlap("app.a.com", "app.a.com")).toBe(true);
	expect(hostsOverlap("*.a.com", "x.a.com")).toBe(true);
	expect(hostsOverlap("x.a.com", "*.a.com")).toBe(true);
	expect(hostsOverlap("*.a.com", "*.a.com")).toBe(true);
	expect(hostsOverlap("*.a.com", "y.x.a.com")).toBe(false);
	expect(hostsOverlap("*.a.com", "a.com")).toBe(false);
	expect(hostsOverlap("x.a.com", "y.a.com")).toBe(false);
});

test("forward auth never targets the proxy's admin API or control-plane services", () => {
	const refused = (u: string) => forwardAuthRefusal(new URL(u));
	expect(refused("http://auth.example.com:2019/")).toContain("2019");
	expect(refused("http://localhost:2019/load")).toContain("2019");
	for (const host of [
		"postgres",
		"redis",
		"caddy",
		"logistack-api",
		"logistack-worker",
		"logistack_postgres",
		"tasks.logistack-api",
		"ls-svc-abc123",
		"LS-DB.",
	])
		expect(refused(`http://${host}:8080/verify`)).not.toBeNull();
	expect(refused("https://auth.example.com/verify")).toBeNull();
	expect(refused("http://authelia:9091/api/verify")).toBeNull();
	expect(refused("http://postgres.example.com/")).toBeNull();
});
