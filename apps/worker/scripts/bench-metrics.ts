/**
 * Insert throughput of the metrics pipeline for a cluster of NODES nodes x CONTAINERS containers
 * sampled every 10s. Fills `ls:metrics` with TICKS ticks, then times the consumer draining it into
 * real Postgres 17, then one rollup pass. Run: `bun apps/worker/scripts/bench-metrics.ts`.
 */
import { RedisClient } from "bun";
import { createMetricsConsumer } from "../src/metrics-consumer.ts";
import { rollup } from "../src/metrics-store.ts";
import { startMonInfra } from "../test/monitoring-harness.ts";

const NODES = Number(process.env.NODES ?? 10);
const CONTAINERS = Number(process.env.CONTAINERS ?? 50);
const TICKS = Number(process.env.TICKS ?? 360);

const infra = await startMonInfra();
const redis = new RedisClient(infra.redisUrl);
try {
	const start = Date.now() - TICKS * 10_000;
	for (let t = 0; t < TICKS; t++)
		for (let n = 0; n < NODES; n++) {
			const at = start + t * 10_000;
			const data = {
				type: "metrics",
				at,
				host: {
					cpuPercent: Math.random() * 100,
					load: [1, 1, 1],
					memory: { totalBytes: 8e9, availableBytes: 4e9, usedBytes: 4e9 },
					swap: { totalBytes: 0, usedBytes: 0 },
					disks: [
						{
							mount: "/",
							device: "/dev/sda1",
							fsType: "ext4",
							totalBytes: 1e11,
							usedBytes: 4e10,
							availableBytes: 6e10,
						},
					],
					network: { rxBytes: t * 1e6, txBytes: t * 5e5 },
					uptimeSec: t * 10,
				},
				containers: Array.from({ length: CONTAINERS }, (_, c) => ({
					containerId: `n${n}-c${c}-0123456789abcdef0123456789abcdef0123456789abcdef`,
					name: `ls-svc-${c}.${n}.task`,
					taskId: `task-${n}-${c}`,
					serviceId: `swarm-svc-${c}`,
					serviceName: `ls-svc-${c}`,
					resourceId: `svc_${c}`,
					cpuPercent: Math.random() * 200,
					memoryBytes: 2e8,
					memoryLimitBytes: 5e8,
					network: { rxBytes: t * 1e4, txBytes: t * 1e4 },
					blockIo: { readBytes: t * 100, writeBytes: t * 100 },
				})),
			};
			await redis.send("XADD", [
				"ls:metrics",
				"*",
				"node",
				`node-${n}`,
				"at",
				String(at),
				"data",
				JSON.stringify(data),
			]);
		}

	const consumer = createMetricsConsumer({
		sql: infra.sql,
		redisUrl: infra.redisUrl,
		blockMs: 10,
	});
	const t0 = performance.now();
	let entries = 0;
	for (let got = await consumer.poll(); got > 0; got = await consumer.poll())
		entries += got;
	const drainMs = performance.now() - t0;
	consumer.close();

	const [{ host, ctr }] = (await infra.sql`select
		(select count(*)::int from metric_host_raw) as host,
		(select count(*)::int from metric_container_raw) as ctr`) as unknown as [
		{ host: number; ctr: number },
	];
	const rows = host + ctr;
	const t1 = performance.now();
	await rollup(infra.sql);
	const rollupMs = performance.now() - t1;
	const needed = (NODES * (CONTAINERS + 1)) / 10;
	console.log(
		JSON.stringify(
			{
				nodes: NODES,
				containers: CONTAINERS,
				ticks: TICKS,
				entries,
				rows,
				drainMs: Math.round(drainMs),
				rowsPerSec: Math.round(rows / (drainMs / 1000)),
				entriesPerSec: Math.round(entries / (drainMs / 1000)),
				neededRowsPerSec: needed,
				headroom: Math.round(rows / (drainMs / 1000) / needed),
				rollupMs: Math.round(rollupMs),
			},
			null,
			2,
		),
	);
} finally {
	redis.close();
	await infra.stop();
}
