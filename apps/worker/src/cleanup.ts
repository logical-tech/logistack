import {
	type Cleanup,
	type CleanupRun,
	DEFAULT_CLEANUP,
} from "@logistack/contracts";
import { monitoringSettings, node } from "@logistack/db";
import { eq } from "drizzle-orm";
import { inspectService } from "./apply.ts";
import { buildkitAddr, buildkitName, run } from "./build.ts";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";

export async function loadCleanup(db: Ctx["db"]): Promise<Cleanup> {
	const [row] = await db
		.select()
		.from(monitoringSettings)
		.where(eq(monitoringSettings.id, "singleton"));
	return row
		? {
				enabled: row.cleanupEnabled,
				cron: row.cleanupCron,
				timezone: row.cleanupTimezone,
				targets: row.cleanupTargets,
				untilHours: row.cleanupUntilHours,
			}
		: DEFAULT_CLEANUP;
}

/** The scheduled prune: every ready node through its agent, then LogiStack's own BuildKit cache. */
export async function runCleanup(ctx: Ctx): Promise<CleanupRun> {
	const c = await loadCleanup(ctx.db);
	const nodes = await ctx.db
		.select({
			id: node.id,
			swarmNodeId: node.swarmNodeId,
			hostname: node.hostname,
		})
		.from(node)
		.where(eq(node.status, "ready"));
	const result: CleanupRun = {
		at: Date.now(),
		nodes: await Promise.all(
			nodes.map(async (n) => {
				try {
					const { report } = await ctx.nodes.disk(n.swarmNodeId, {
						op: "prune",
						targets: c.targets,
						untilHours: c.untilHours,
					});
					const r = report ?? [];
					return {
						nodeId: n.id,
						hostname: n.hostname,
						reclaimedBytes: r.reduce((a, x) => a + x.reclaimedBytes, 0),
						report: r,
						error: null,
					};
				} catch (e) {
					return {
						nodeId: n.id,
						hostname: n.hostname,
						reclaimedBytes: 0,
						report: [],
						error: e instanceof Error ? e.message : String(e),
					};
				}
			}),
		),
	};
	if (
		c.targets.includes("buildCache") &&
		(await inspectService(ctx, buildkitName(ctx)))
	)
		await run(
			[
				"buildctl",
				"--addr",
				buildkitAddr(ctx),
				"prune",
				"--keep-duration",
				`${c.untilHours}h`,
			],
			{ log: () => {}, signal: AbortSignal.timeout(10 * 60_000) },
		).catch((e) =>
			log("warn", "buildkit cache prune failed", { error: String(e) }),
		);
	await ctx.db
		.insert(monitoringSettings)
		.values({ lastCleanup: result })
		.onConflictDoUpdate({
			target: monitoringSettings.id,
			set: { lastCleanup: result },
		});
	log("info", "node cleanup finished", {
		nodes: result.nodes.length,
		reclaimedBytes: result.nodes.reduce((a, n) => a + n.reclaimedBytes, 0),
		failed: result.nodes.filter((n) => n.error).length,
	});
	return result;
}
