import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TrafficMinute } from "@logistack/contracts";
import { hllDecode, hllEstimate, quantiles } from "@logistack/core/traffic";
import { RedisClient } from "bun";
import { TrafficAggregator } from "../../agent/src/traffic.ts";
import { createMetricsConsumer, field } from "../src/metrics-consumer.ts";
import { applyRetention, ensurePartitions } from "../src/metrics-store.ts";
import {
	insertTraffic,
	rollupTraffic,
	TrafficEntry,
	trafficSignal,
} from "../src/traffic-store.ts";
import { hasDocker, startMonInfra } from "./monitoring-harness.ts";

const STREAM = "ls:test:traffic";

/** What one node's agent ships for `n` requests from `ips` distinct clients in the current minute. */
function minutes(n: number, ips: number, ipOffset = 0): TrafficMinute[] {
	const a = new TrafficAggregator();
	a.configure({
		routes: [
			{
				hostname: "shop.example.com",
				domainId: "dom_t",
				serviceId: "svc_t",
				organizationId: "org_t",
				script: false,
			},
		],
		salts: { [new Date().toISOString().slice(0, 10)]: "f".repeat(32) },
	});
	const now = Date.now();
	for (let i = 1; i <= n; i++)
		a.ingest(
			JSON.stringify({
				ts: now / 1000,
				logger: "http.log.access.ls-access",
				request: {
					client_ip: `198.51.100.${(i % ips) + ipOffset}`,
					method: "GET",
					host: "shop.example.com",
					uri: `/item/${i % 5}`,
					headers: {
						"User-Agent": ["Mozilla/5.0 Firefox/140.0"],
						Accept: ["text/html"],
					},
				},
				duration: i / 1000,
				size: 100,
				status: i % 20 === 0 ? 500 : 200,
			}),
			now,
		);
	return a.close(now, true);
}

describe.skipIf(!hasDocker)("traffic store", () => {
	let infra: Awaited<ReturnType<typeof startMonInfra>>;
	beforeAll(async () => {
		infra = await startMonInfra();
		await ensurePartitions(infra.sql);
	}, 120_000);
	afterAll(async () => {
		await infra?.stop();
	});

	test("stream to rollups: counts, percentiles and visitors merge across nodes; resends are no-ops", async () => {
		const redis = new RedisClient(infra.redisUrl);
		const a = minutes(600, 40);
		const b = minutes(400, 40, 20); // 20 clients overlap with node a
		const add = (node: string, m: TrafficMinute[]) =>
			redis.send("XADD", [
				STREAM,
				"*",
				"node",
				node,
				"data",
				JSON.stringify(m),
			]);
		await add("node-a", a);
		await add("node-b", b);
		await add("node-a", a); // a lost ack: the agent sends the same minute again
		const consumer = createMetricsConsumer({
			sql: infra.sql,
			redisUrl: infra.redisUrl,
			stream: STREAM,
			handle: async (entries) => {
				const rows = entries.flatMap(([, f]) =>
					TrafficEntry.parse(JSON.parse(field(f, "data") ?? "[]")).map(
						(minute) => ({
							nodeId: field(f, "node") as string,
							minute,
						}),
					),
				);
				await insertTraffic(infra.sql, rows);
			},
		});
		expect(await consumer.poll()).toBe(3);
		consumer.close();

		const [m] = await infra.sql<
			{ n: number; requests: number }[]
		>`select count(*)::int as n, sum(requests)::int as requests from traffic_1m`;
		expect(m).toEqual({ n: 2, requests: 1000 });

		await rollupTraffic(infra.sql);
		await rollupTraffic(infra.sql); // idempotent
		const [h] = await infra.sql<
			{
				requests: number;
				s2: number;
				s5: number;
				latency: Record<string, number>;
				paths: Record<string, number>;
				visitors: Uint8Array;
			}[]
		>`select requests, s2, s5, latency, paths, visitors from traffic_1h where domain_id = 'dom_t'`;
		expect(h?.requests).toBe(1000);
		expect(h?.s5).toBe(30 + 20);
		expect(h?.paths["/item/0"]).toBe(200);
		expect(
			Math.abs(hllEstimate(hllDecode(h?.visitors as Uint8Array)) - 60),
		).toBeLessThanOrEqual(3);
		const [p50, p99] = quantiles(h?.latency ?? {}, [0.5, 0.99]) as number[];
		// Node a: 1..600 ms, node b: 1..400 ms; the true p50 is 250 and p99 is 590.
		expect(Math.abs((p50 as number) - 250) / 250).toBeLessThan(0.05);
		expect(Math.abs((p99 as number) - 590) / 590).toBeLessThan(0.05);

		const signal = await trafficSignal(infra.sql)("svc_t", 300);
		expect(signal?.requestsPerSec).toBeCloseTo(1000 / 300, 5);
		expect(signal?.errorRate).toBeCloseTo(0.05, 5);

		// Nothing that looks like an address reaches Postgres.
		const dump = JSON.stringify(
			await infra.sql`select row_to_json(t) from traffic_1m t union all select row_to_json(t) from traffic_1h t`,
		);
		expect(dump).not.toContain("198.51.100");
		expect(dump).not.toContain("Firefox");

		await applyRetention(
			infra.sql,
			{ rawHours: 1, minuteDays: 1, hourDays: 0 },
			new Date(Date.now() + 86_400_000),
		);
		const [left] = await infra.sql<
			{ n: number }[]
		>`select count(*)::int as n from traffic_1h`;
		expect(left?.n).toBe(0);
		redis.close();
	}, 60_000);
});
