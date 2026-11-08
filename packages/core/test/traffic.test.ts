import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	cleanPath,
	hllAdd,
	hllDecode,
	hllEncode,
	hllEstimate,
	hllMerge,
	hllNew,
	isBot,
	isPageview,
	latencyBucket,
	matchRoute,
	quantiles,
	referrerHost,
	routeTable,
} from "../src/traffic.ts";

const h = (s: string) =>
	new Uint8Array(createHash("sha256").update(s).digest());

describe("hll", () => {
	test("estimates within 5% and round-trips both encodings", () => {
		for (const n of [1, 50, 1000, 100_000]) {
			const r = hllNew();
			for (let i = 0; i < n; i++) hllAdd(r, h(`v${i}`));
			const est = hllEstimate(r);
			expect(Math.abs(est - n) / n).toBeLessThan(0.05);
			expect(hllDecode(hllEncode(r))).toEqual(r);
		}
	});

	test("merge is idempotent and counts the union", () => {
		const a = hllNew();
		const b = hllNew();
		for (let i = 0; i < 2000; i++) hllAdd(a, h(`v${i}`));
		for (let i = 1000; i < 3000; i++) hllAdd(b, h(`v${i}`));
		const u = hllMerge(hllMerge(hllNew(), a), b);
		hllMerge(u, b);
		expect(Math.abs(hllEstimate(u) - 3000) / 3000).toBeLessThan(0.05);
	});

	test("rejects garbage", () => {
		expect(() => hllDecode(new Uint8Array([0, 1, 2]))).toThrow();
		expect(() => hllDecode(new Uint8Array([1, 0xff, 0xff, 3]))).toThrow();
	});
});

describe("latency", () => {
	test("quantiles land within one bucket of the truth", () => {
		const hist: Record<string, number> = {};
		for (let ms = 1; ms <= 1000; ms++) {
			const b = String(latencyBucket(ms));
			hist[b] = (hist[b] ?? 0) + 1;
		}
		const [p50, p95, p99] = quantiles(hist, [0.5, 0.95, 0.99]) as number[];
		expect(Math.abs((p50 as number) - 500) / 500).toBeLessThan(0.05);
		expect(Math.abs((p95 as number) - 950) / 950).toBeLessThan(0.05);
		expect(Math.abs((p99 as number) - 990) / 990).toBeLessThan(0.05);
		expect(quantiles({}, [0.5])).toEqual([null]);
		expect(latencyBucket(0.2)).toBe(0);
	});
});

describe("routes", () => {
	const base = { serviceId: "s", organizationId: "o", script: false };
	const t = routeTable([
		{ ...base, hostname: "a.example.com", domainId: "root" },
		{ ...base, hostname: "a.example.com", pathPrefix: "/api", domainId: "api" },
		{ ...base, hostname: "*.example.com", domainId: "wild" },
	]);

	test("exact before wildcard, longest prefix first", () => {
		expect(matchRoute(t, "A.example.com:443", "/api/x")?.domainId).toBe("api");
		expect(matchRoute(t, "a.example.com", "/api")?.domainId).toBe("api");
		expect(matchRoute(t, "a.example.com", "/apix")?.domainId).toBe("root");
		expect(matchRoute(t, "b.example.com", "/")?.domainId).toBe("wild");
		expect(matchRoute(t, "x.b.example.com", "/")).toBeUndefined();
		expect(matchRoute(t, "other.org", "/")).toBeUndefined();
	});
});

describe("classify", () => {
	test("bots, pageviews, referrers, paths", () => {
		expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
		expect(isBot("curl/8.4.0")).toBe(true);
		expect(isBot(undefined)).toBe(true);
		expect(isBot("Mozilla/5.0 (Macintosh) Safari/605.1.15")).toBe(false);
		expect(isPageview("GET", 200, "text/html,*/*")).toBe(true);
		expect(isPageview("GET", 404, "text/html")).toBe(false);
		expect(isPageview("GET", 200, "image/webp")).toBe(false);
		expect(referrerHost("https://www.google.com/search?q=x", "a.com")).toBe(
			"google.com",
		);
		expect(referrerHost("https://a.com/x", "a.com:443")).toBeUndefined();
		expect(referrerHost("not a url", "a.com")).toBeUndefined();
		expect(cleanPath("/x/y?token=secret#h")).toBe("/x/y");
	});
});
