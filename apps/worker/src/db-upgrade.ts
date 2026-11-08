import type { DatabaseEngine } from "@logistack/contracts";
import {
	compareRowCounts,
	databaseDataDir,
	databaseImage,
	dockerName,
	parseRowCounts,
	rowCountScript,
	upgradeDumpScript,
	upgradeRestoreScript,
} from "@logistack/core";
import { databaseUpgrade, service } from "@logistack/db";
import { managedLabels } from "@logistack/docker";
import { eq } from "drizzle-orm";
import { readyScript } from "./backup-scripts.ts";
import { locateTask, script, withHelper } from "./backups.ts";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";
import { loadService } from "./load.ts";
import { deploy } from "./migration.ts";
import { feed, STDIN_WINDOW_BYTES, tail } from "./node-runner.ts";

// Major-version upgrade of a database (docs/plans/database-ops.md §3): copy into a new instance
// on a new volume, verify, switch, verify again, roll back on any failure after the switch.

const JOB_TIMEOUT_S = 6 * 3600;
/** Dump bytes the agent may run ahead of the restore. */
const ACK_WINDOW_BYTES = 8 * 1024 * 1024;

type Step =
	| "check"
	| "instance"
	| "copy"
	| "verify"
	| "switch"
	| "reverify"
	| "rollback"
	| "done";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Row counts of a running task or helper; throws with the script's stderr on failure. */
async function counts(
	ctx: Ctx,
	nodeId: string,
	target:
		| { kind: "task"; taskId: string }
		| { kind: "service"; serviceId: string },
	engine: DatabaseEngine,
) {
	return parseRowCounts(
		await script(ctx, nodeId, target, rowCountScript(engine), 1800),
	);
}

/** Swarm removes a service before its container has stopped; the volume is free only after. */
async function waitForContainersGone(ctx: Ctx, swarmServiceId: string) {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const left = await ctx.docker.containers.list(
			{ label: [`com.docker.swarm.service.id=${swarmServiceId}`] },
			true,
		);
		if (!left.length) return;
		await Bun.sleep(500);
	}
	throw new Error("the upgrade instance did not stop within 120s");
}

export async function runUpgrade(ctx: Ctx, upgradeId: string) {
	const [u] = await ctx.db
		.select()
		.from(databaseUpgrade)
		.where(eq(databaseUpgrade.id, upgradeId));
	if (u?.status !== "running") return;
	const step = async (s: Step, message: string | null = null) => {
		log("info", "database upgrade", { upgradeId, step: s, message });
		await ctx.db
			.update(databaseUpgrade)
			.set({ step: s, message })
			.where(eq(databaseUpgrade.id, upgradeId));
	};
	const finish = (
		status: "succeeded" | "rolled_back" | "failed",
		message: string | null,
	) =>
		ctx.db
			.update(databaseUpgrade)
			.set({ status, message, finishedAt: new Date() })
			.where(eq(databaseUpgrade.id, upgradeId));

	let switched = false;
	try {
		await step("check");
		const sc = await loadService(ctx, u.serviceId);
		const spec = sc?.service.spec;
		if (!sc || spec?.kind !== "database")
			throw new Error("the service is gone or is not a database");
		const engine = spec.engine;
		const src = await locateTask(ctx, u.serviceId);
		if (!src) throw new Error("the database has no running replica");
		const source = await counts(
			ctx,
			src.nodeId,
			{ kind: "task", taskId: src.taskId },
			engine,
		);
		await ctx.db
			.update(databaseUpgrade)
			.set({ counts: source })
			.where(eq(databaseUpgrade.id, upgradeId));

		await step("instance", `starting ${engine} ${u.toVersion}`);
		const volume = `${ctx.cfg.LS_NAME_PREFIX}${dockerName("vol", u.id)}`;
		let helperId = "";
		try {
			await withHelper(
				ctx,
				{
					runId: u.id,
					orgId: sc.organizationId,
					kind: "upg",
					nodeId: src.nodeId,
					image: databaseImage(engine, u.toVersion),
					env: Object.entries(sc.env).map(([k, v]) => `${k}=${v.value}`),
					mounts: [
						{
							Type: "volume",
							Source: volume,
							Target: databaseDataDir({ engine, version: u.toVersion }),
							// Owned by the service, so the orphan sweep counts it as the service's data.
							VolumeOptions: {
								Labels: {
									...managedLabels({
										resource: u.serviceId,
										kind: "volume",
										org: sc.organizationId,
									}),
									...scope(ctx).labels,
								},
							},
						},
					],
				},
				async (id) => {
					helperId = id;
					const helper = { kind: "service" as const, serviceId: id };
					await script(ctx, src.nodeId, helper, readyScript(engine, 300), 320);

					await step("copy", `copying from ${u.fromVersion}`);
					const dump = ctx.nodes.runJob(src.nodeId, {
						kind: "exec",
						target: { kind: "task", taskId: src.taskId },
						cmd: ["sh"],
						script: upgradeDumpScript(engine),
						timeoutSec: JOB_TIMEOUT_S,
						outputLimitBytes: Number.MAX_SAFE_INTEGER,
						ackWindowBytes: ACK_WINDOW_BYTES,
					});
					let dumpErr = "";
					const dec = new TextDecoder();
					async function* stdout() {
						for await (const c of dump)
							if (c.stream === "stdout") yield c.data;
							else
								dumpErr = tail(
									dumpErr + dec.decode(c.data, { stream: true }),
									2000,
								);
						const r = await dump.result;
						if (r.exitCode !== 0)
							throw new Error(
								`the dump failed (exit ${r.exitCode}): ${dumpErr.trim()}`,
							);
					}
					const restore = ctx.nodes.exec(
						src.nodeId,
						{
							target: helper,
							cmd: ["sh", "-c", upgradeRestoreScript(engine)],
							stdin: true,
						},
						{
							timeoutMs: JOB_TIMEOUT_S * 1000,
							stdinWindowBytes: STDIN_WINDOW_BYTES,
						},
					);
					await feed(restore, stdout());

					await step("verify");
					const copy = await counts(ctx, src.nodeId, helper, engine);
					const diff = compareRowCounts(source, copy);
					if (diff.length)
						throw new Error(
							`the copy does not match: ${diff.slice(0, 5).join("; ")}`,
						);
				},
			);
			await waitForContainersGone(ctx, helperId);
		} catch (e) {
			// Nothing switched yet: the old instance never stopped, so drop the half copy.
			if (helperId) await waitForContainersGone(ctx, helperId).catch(() => {});
			await ctx.docker.volumes.remove(volume).catch(() => {});
			throw e;
		}

		await step("switch", `deploying ${engine} ${u.toVersion}`);
		switched = true;
		await ctx.db
			.update(service)
			.set({ spec: { ...spec, version: u.toVersion }, dataVolumeId: u.id })
			.where(eq(service.id, u.serviceId));
		await deploy(ctx, u.serviceId);

		await step("reverify");
		const now = await locateTask(ctx, u.serviceId);
		if (!now) throw new Error("the upgraded database has no running replica");
		const after = await counts(
			ctx,
			now.nodeId,
			{ kind: "task", taskId: now.taskId },
			engine,
		);
		const diff = compareRowCounts(source, after);
		if (diff.length)
			throw new Error(
				`the upgraded database does not match: ${diff.slice(0, 5).join("; ")}`,
			);
		await step("done");
		await finish(
			"succeeded",
			`${Object.keys(source).length} tables verified on ${u.toVersion}`,
		);
	} catch (e) {
		const error = errMsg(e);
		log("error", "database upgrade failed", { upgradeId, error, switched });
		if (!switched) return void (await finish("failed", error));
		await step("rollback", error);
		try {
			const [row] = await ctx.db
				.select({ spec: service.spec })
				.from(service)
				.where(eq(service.id, u.serviceId));
			if (row?.spec.kind === "database")
				await ctx.db
					.update(service)
					.set({
						spec: { ...row.spec, version: u.fromVersion },
						dataVolumeId: u.previousDataVolumeId,
					})
					.where(eq(service.id, u.serviceId));
			await deploy(ctx, u.serviceId);
			await finish(
				"rolled_back",
				`${error}. Rolled back to ${u.fromVersion}; the old data was never changed.`,
			);
		} catch (re) {
			await finish(
				"failed",
				`${error}. The rollback failed too: ${errMsg(re)}. The service is set back to ${u.fromVersion} on its old volume; deploy it again.`,
			);
		}
	}
}
