import { node } from "@logistack/db";
import { autoscalePass } from "./autoscale.ts";
import { log, withLock } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { startQueuedUpdates } from "./instance-update.ts";
import { createMetricsConsumer, type NodeRef } from "./metrics-consumer.ts";
import {
	applyRetention,
	ensurePartitions,
	loadRetention,
	rollup,
} from "./metrics-store.ts";
import { claimJoin, runJoinStep } from "./node-join.ts";
import { onNodeOps, syncNodes } from "./nodes.ts";
import { claimRun, clusterDeps, processRun } from "./patching.ts";
import { evaluateServiceThresholds, evaluateThresholds } from "./thresholds.ts";

/** Matches the agent's scrape cadence closely enough; decisions use 1- and 5-minute windows. */
const AUTOSCALE_INTERVAL_MS = 30_000;

/** Repeats `fn` every `ms` (and on `kick()`), one run at a time, logging failures. */
function every(name: string, ms: number, fn: () => Promise<void>) {
	let running = false;
	let again = false;
	const tick = async () => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			do {
				again = false;
				await fn();
			} while (again);
		} catch (e) {
			log("error", `${name} failed`, { error: String(e) });
		} finally {
			running = false;
		}
	};
	const timer = ms > 0 ? setInterval(tick, ms) : undefined;
	void tick();
	return { kick: tick, stop: () => clearInterval(timer) };
}

/**
 * Metrics ingestion (consumer group, every replica), rollups, retention and thresholds (one
 * replica per pass through a Redis lock), node sync and the Add-server wizard steps.
 */
export async function startMonitoring(ctx: Ctx): Promise<() => Promise<void>> {
	const sql = ctx.db.$client;
	const { redis } = ctx.bus;
	await ensurePartitions(sql);

	let refs = new Map<string, NodeRef>();
	let refsAt = 0;
	const resolveNode = async (swarmNodeId: string) => {
		if (!refs.has(swarmNodeId) && Date.now() - refsAt > 30_000) {
			refsAt = Date.now();
			const rows = await ctx.db
				.select({
					id: node.id,
					organizationId: node.organizationId,
					swarmNodeId: node.swarmNodeId,
				})
				.from(node);
			refs = new Map(rows.map((r) => [r.swarmNodeId, r]));
		}
		return refs.get(swarmNodeId);
	};
	const consumer = createMetricsConsumer({
		sql,
		redisUrl: ctx.cfg.REDIS_URL,
		resolveNode,
	});
	const ingest = new AbortController();
	const consuming = consumer.run(ingest.signal);

	let lastRetention = 0;
	const maintenance = every(
		"metrics maintenance",
		ctx.cfg.LS_METRICS_INTERVAL_MS,
		async () => {
			await withLock(redis, "ls:lock:metrics", 300_000, async () => {
				await ensurePartitions(sql);
				await rollup(sql);
				await evaluateThresholds(sql, ctx.bus);
				await evaluateServiceThresholds(sql, ctx.bus);
				if (Date.now() - lastRetention > 600_000) {
					lastRetention = Date.now();
					const dropped = await applyRetention(sql, await loadRetention(sql));
					if (dropped.length)
						log("info", "metric partitions dropped", { dropped });
				}
			});
		},
	);

	const autoscale = every("autoscale", AUTOSCALE_INTERVAL_MS, async () => {
		await withLock(redis, "ls:lock:autoscale", 60_000, async () => {
			await autoscalePass(ctx);
		});
	});

	const nodes = every(
		"node sync",
		ctx.cfg.LS_NODE_SYNC_INTERVAL_MS,
		async () => {
			await withLock(redis, "ls:lock:nodes", 120_000, () => syncNodes(ctx));
		},
	);
	const joins = every(
		"node join",
		ctx.cfg.LS_NODE_SYNC_INTERVAL_MS,
		async () => {
			for (let row = await claimJoin(ctx); row; row = await claimJoin(ctx))
				void runJoinStep(ctx, row);
		},
	);
	// Patch runs are queued like node operations; a claimed run runs to its end in the background.
	const patches = every(
		"patch runs",
		ctx.cfg.LS_NODE_SYNC_INTERVAL_MS,
		async () => {
			for (let run = await claimRun(ctx.db); run; run = await claimRun(ctx.db))
				void processRun(ctx, clusterDeps(ctx), run).catch((e) =>
					log("error", "patch run failed", { run: run?.id, error: String(e) }),
				);
		},
	);
	// Instance updates are queued like node operations and poked over the same channel.
	const updates = every(
		"instance update",
		ctx.cfg.LS_NODE_SYNC_INTERVAL_MS,
		() => startQueuedUpdates(ctx),
	);
	const unsubscribe = await onNodeOps(ctx.cfg.REDIS_URL, () => {
		void nodes.kick();
		void joins.kick();
		void updates.kick();
		void patches.kick();
	});

	return async () => {
		unsubscribe();
		maintenance.stop();
		autoscale.stop();
		nodes.stop();
		joins.stop();
		updates.stop();
		patches.stop();
		ingest.abort();
		consumer.close();
		await consuming.catch(() => {});
	};
}
