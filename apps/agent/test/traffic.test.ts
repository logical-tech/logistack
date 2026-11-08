import { describe, expect, test } from "bun:test";
import { hllDecode, hllEstimate, quantiles } from "@logistack/core/traffic";
import {
	DEFAULT_TRAFFIC_LIMITS,
	TrafficAggregator,
	TrafficOutbox,
} from "../src/traffic.ts";

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const route = (
	o: Partial<{ hostname: string; domainId: string; script: boolean }> = {},
) => ({
	hostname: "shop.example.com",
	domainId: "dom_1",
	serviceId: "svc_1",
	organizationId: "org_1",
	script: false,
	...o,
});

function line(o: {
	at?: number;
	host?: string;
	uri?: string;
	status?: number;
	ms?: number;
	ip?: string;
	ua?: string;
	accept?: string;
	referer?: string;
	method?: string;
}) {
	return JSON.stringify({
		level: "info",
		ts: (o.at ?? T0 + 1_000) / 1000,
		logger: "http.log.access.ls-access",
		msg: "handled request",
		request: {
			remote_ip: o.ip ?? "203.0.113.7",
			client_ip: o.ip ?? "203.0.113.7",
			method: o.method ?? "GET",
			host: o.host ?? "shop.example.com",
			uri: o.uri ?? "/",
			headers: {
				"User-Agent": [o.ua ?? "Mozilla/5.0 (Macintosh) Safari/605.1.15"],
				Accept: [o.accept ?? "text/html"],
				...(o.referer ? { Referer: [o.referer] } : {}),
			},
		},
		bytes_read: 10,
		duration: (o.ms ?? 5) / 1000,
		size: 1000,
		status: o.status ?? 200,
	});
}

function aggregator() {
	const a = new TrafficAggregator(DEFAULT_TRAFFIC_LIMITS, (ip) =>
		ip.startsWith("203.") ? "IT" : undefined,
	);
	a.configure({
		routes: [
			route(),
			route({ hostname: "s.example.com", domainId: "dom_2", script: true }),
		],
		salts: { "2026-11-08": "a".repeat(32) },
	});
	return a;
}

describe("TrafficAggregator", () => {
	test("counts, status classes, percentiles, visitors; no IP or user agent leaves", () => {
		const a = aggregator();
		const now = T0 + 30_000;
		for (let i = 1; i <= 1000; i++)
			a.ingest(
				line({
					ms: i,
					status: i % 10 === 0 ? 503 : 200,
					ip: `203.0.113.${i % 50}`,
					uri: `/p/${i % 3}?token=x`,
				}),
				now,
			);
		a.ingest(line({ ua: "Googlebot/2.1", accept: "text/html" }), now);
		a.ingest(
			line({
				referer: "https://news.ycombinator.com/item?id=1",
				uri: "/?utm_source=HN",
			}),
			now,
		);
		a.ingest(line({ host: "unknown.example.org" }), now);
		const [m, ...rest] = a.close(T0 + 120_000);
		expect(rest).toHaveLength(0);
		if (!m) throw new Error("no minute");
		expect(m.requests).toBe(1002);
		expect(m.status).toEqual([0, 902, 0, 0, 100]);
		expect(m.bots).toBe(1);
		expect(m.pageviews).toBe(901); // 503s are not pageviews
		expect(m.bytesOut).toBe(1_002_000);
		expect(m.paths["/p/0"]).toBe(333);
		expect(Object.keys(m.paths).some((p) => p.includes("token"))).toBe(false);
		expect(m.referrers).toEqual({ "news.ycombinator.com": 1 });
		expect(m.utmSources).toEqual({ hn: 1 });
		expect(m.countries.IT).toBe(1001);
		expect(
			Math.abs(hllEstimate(hllDecode(Buffer.from(m.visitors, "base64"))) - 50),
		).toBeLessThanOrEqual(2);
		const [p50, p95, p99] = quantiles(m.latency, [0.5, 0.95, 0.99]) as number[];
		expect(Math.abs((p50 as number) - 500) / 500).toBeLessThan(0.05);
		expect(Math.abs((p95 as number) - 950) / 950).toBeLessThan(0.05);
		expect(Math.abs((p99 as number) - 990) / 990).toBeLessThan(0.05);
		const json = JSON.stringify(m);
		expect(json).not.toContain("203.0.113");
		expect(json).not.toContain("Safari");
		expect(a.stats.unmatched).toBe(1);
	});

	test("script domains count pageviews and referrers from beacons only", () => {
		const a = aggregator();
		const now = T0 + 30_000;
		const host = "s.example.com";
		a.ingest(line({ host, uri: "/" }), now);
		a.ingest(line({ host, uri: "/_ls/a.js", accept: "*/*" }), now);
		const page = encodeURIComponent("/pricing?utm_source=Newsletter");
		a.ingest(
			line({
				host,
				uri: `/_ls/e?n=pageview&u=${page}&r=${encodeURIComponent("https://google.com/")}`,
				status: 204,
			}),
			now,
		);
		a.ingest(line({ host, uri: "/_ls/e?n=signup&u=%2F", status: 204 }), now);
		const [m] = a.close(T0 + 120_000);
		expect(m?.requests).toBe(1);
		expect(m?.pageviews).toBe(1);
		expect(m?.referrers).toEqual({ "google.com": 1 });
		expect(m?.utmSources).toEqual({ newsletter: 1 });
		expect(m?.events).toEqual({ signup: 1 });
	});

	test("bounded: open minutes and keys are capped, late lines dropped", () => {
		const a = new TrafficAggregator({
			...DEFAULT_TRAFFIC_LIMITS,
			maxOpen: 3,
			maxKeys: 10,
		});
		a.configure({ routes: [route()], salts: {} });
		for (let i = 0; i < 100; i++)
			a.ingest(line({ at: T0 + i * 60_000, uri: `/x/${i}` }), T0 + i * 60_000);
		expect(a.openCount).toBe(3);
		const b = new TrafficAggregator({ ...DEFAULT_TRAFFIC_LIMITS, maxKeys: 10 });
		b.configure({ routes: [route()], salts: {} });
		for (let i = 0; i < 100; i++) b.ingest(line({ uri: `/x/${i}` }), T0 + 1000);
		b.ingest(line({ at: T0 - 10 * 60_000 }), T0 + 1000);
		const [m] = b.close(T0 + 120_000);
		expect(Object.keys(m?.paths ?? {})).toHaveLength(11);
		expect(m?.paths["(other)"]).toBe(90);
		expect(b.stats.dropped).toBe(1);
	});
});

describe("TrafficOutbox", () => {
	const minute = (ts: number) => ({
		ts,
		domainId: "dom_1",
		serviceId: "svc_1",
		organizationId: "org_1",
		requests: 1,
		status: [0, 1, 0, 0, 0] as [number, number, number, number, number],
		bytesIn: 0,
		bytesOut: 0,
		latency: { "10": 1 },
		pageviews: 0,
		bots: 0,
		paths: { ["/".repeat(150)]: 1 },
		referrers: {},
		countries: {},
		utmSources: {},
		events: {},
		visitors: "",
	});

	test("stays under its byte cap while nothing is acked", () => {
		const limits = { ...DEFAULT_TRAFFIC_LIMITS, maxOutboxBytes: 64 * 1024 };
		const o = new TrafficOutbox(limits);
		for (let i = 0; i < 10_000; i++) {
			o.push([minute(T0 + i * 60_000)]);
			o.next(T0 + i * 1000);
		}
		expect(o.heldBytes).toBeLessThanOrEqual(64 * 1024);
		expect(o.dropped).toBeGreaterThan(9000);
	});

	test("acks remove what was sent; a lost ack resends after the timeout", () => {
		const o = new TrafficOutbox();
		o.push([minute(T0), minute(T0 + 60_000)]);
		const b1 = o.next(T0);
		expect(b1?.minutes).toHaveLength(2);
		expect(o.next(T0 + 1000)).toBeUndefined();
		const b2 = o.next(T0 + 31_000);
		expect(b2?.seq).toBe((b1?.seq ?? 0) + 1);
		o.ack(b1?.seq ?? 0);
		expect(o.length).toBe(2);
		o.ack(b2?.seq ?? 0);
		expect(o.length).toBe(0);
	});
});
