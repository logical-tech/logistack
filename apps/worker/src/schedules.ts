import {
	type JobSpecInput,
	type ScheduleJob,
	scheduleRunChannel,
} from "@logistack/contracts";
import { newId } from "@logistack/core";
import { node, schedule, scheduleRun } from "@logistack/db";
import {
	LABEL_KIND,
	LABEL_MANAGED,
	LABEL_ORG,
	LABEL_RESOURCE,
} from "@logistack/docker";
import { RedisClient } from "bun";
import { and, eq, ne, sql } from "drizzle-orm";
import { locateTask, publishLive } from "./backups.ts";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { NodeRunnerError } from "./node-runner.ts";

// Schedule runs: a script in a fresh container, inside a service's task, or chrooted on a host.

/** Workers listen here; whichever holds the run aborts it (concurrency `replace`). */
export const SCHEDULE_CANCEL_CHANNEL = "ls:schedule:cancel";

type Schedule = typeof schedule.$inferSelect;
type Run = typeof scheduleRun.$inferSelect;

const body = (id: string) => id.slice(id.indexOf("_") + 1);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ScheduleRunner = {
	process(
		job: ScheduleJob,
		updateData?: (d: ScheduleJob) => Promise<void>,
	): Promise<Run | undefined>;
	close(): void;
};

let localNode: Promise<string> | undefined;
const workerNode = (ctx: Ctx) => {
	localNode ??= ctx.docker.info().then((i) => i.Swarm.NodeID);
	return localNode;
};

/** Where and how the script runs. */
async function plan(
	ctx: Ctx,
	s: Schedule,
	runId: string,
): Promise<{ nodeId: string; spec: JobSpecInput }> {
	const common = {
		script: s.script,
		timeoutSec: s.timeoutS,
		outputLimitBytes: ctx.cfg.LS_SCHEDULE_OUTPUT_LIMIT,
	};
	const container = {
		kind: "container" as const,
		containerName: `${ctx.cfg.LS_NAME_PREFIX}ls-sch-${body(runId)}`,
		labels: {
			[LABEL_MANAGED]: "true",
			[LABEL_RESOURCE]: runId,
			[LABEL_KIND]: "schedule",
			[LABEL_ORG]: s.organizationId,
			...ctx.cfg.LS_SCOPE_LABELS,
		},
	};
	const t = s.target;
	switch (t.kind) {
		case "ephemeral":
			return {
				nodeId: await workerNode(ctx),
				spec: { ...container, ...common, image: t.image, cmd: ["sh"] },
			};
		case "service": {
			const task = await locateTask(ctx, t.serviceId);
			if (!task) throw new Error("the target service has no running task");
			return {
				nodeId: task.nodeId,
				spec: {
					kind: "exec",
					target: { kind: "task", taskId: task.taskId },
					cmd: ["sh"],
					...common,
				},
			};
		}
		case "host": {
			const [n] = await ctx.db
				.select({ swarm: node.swarmNodeId })
				.from(node)
				.where(
					and(eq(node.id, t.nodeId), eq(node.organizationId, s.organizationId)),
				);
			if (!n) throw new Error("the target node is gone");
			return {
				nodeId: n.swarm,
				spec: {
					...container,
					...common,
					image: ctx.cfg.LS_HOST_JOB_IMAGE,
					cmd: ["chroot", "/host", "sh"],
					mounts: [{ type: "bind", source: "/", target: "/host" }],
					network: "host",
				},
			};
		}
	}
}

type Claim = { run: Run; go: boolean; cancelled: string[] };

/**
 * Applies the concurrency policy and records the run, under a per-schedule advisory lock so
 * two workers (or a tick and a Run now) cannot both see "nothing running".
 */
async function claim(
	ctx: Ctx,
	s: Schedule,
	job: ScheduleJob & { runId: string },
): Promise<Claim> {
	return ctx.db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${s.id}))`);
		const others = await tx
			.select({ id: scheduleRun.id })
			.from(scheduleRun)
			.where(
				and(
					eq(scheduleRun.scheduleId, s.id),
					eq(scheduleRun.status, "running"),
					ne(scheduleRun.id, job.runId),
				),
			);
		const skip = s.concurrency === "forbid" && others.length > 0;
		const now = new Date();
		const cancelled: string[] = [];
		if (s.concurrency === "replace" && others.length) {
			for (const o of others) cancelled.push(o.id);
			await tx
				.update(scheduleRun)
				.set({
					status: "cancelled",
					finishedAt: now,
					error: `replaced by run ${job.runId}`,
				})
				.where(
					and(
						eq(scheduleRun.scheduleId, s.id),
						eq(scheduleRun.status, "running"),
						ne(scheduleRun.id, job.runId),
					),
				);
		}
		const values = skip
			? {
					status: "skipped" as const,
					finishedAt: now,
					error: `run ${others[0]?.id} was still going (concurrency: forbid)`,
				}
			: {};
		const [inserted] = await tx
			.insert(scheduleRun)
			.values({
				id: job.runId,
				scheduleId: s.id,
				trigger: job.trigger ?? "cron",
				...values,
			})
			.onConflictDoUpdate({
				target: scheduleRun.id,
				set: values.status ? values : { updatedAt: now },
			})
			.returning();
		if (!inserted) throw new Error("schedule run row vanished");
		return {
			run: inserted,
			go: !skip && inserted.status === "running",
			cancelled,
		};
	});
}

export async function createScheduleRunner(ctx: Ctx): Promise<ScheduleRunner> {
	const active = new Map<string, AbortController>();
	const sub = new RedisClient(ctx.cfg.REDIS_URL);
	await sub.connect();
	await sub.subscribe(SCHEDULE_CANCEL_CHANNEL, (runId: string) => {
		active.get(runId)?.abort();
	});

	async function process(
		data: ScheduleJob,
		updateData?: (d: ScheduleJob) => Promise<void>,
	): Promise<Run | undefined> {
		const [s] = await ctx.db
			.select()
			.from(schedule)
			.where(eq(schedule.id, data.scheduleId));
		if (!s) return;
		const trigger = data.trigger ?? "cron";
		if (trigger === "cron" && !s.enabled) return;
		let runId = data.runId;
		if (!runId) {
			runId = newId("scr");
			// A stalled tick that runs again then finds its row instead of starting a second run.
			await updateData?.({ ...data, runId });
		}
		const c = await claim(ctx, s, { ...data, runId, trigger });
		for (const id of c.cancelled)
			await ctx.bus.redis.publish(SCHEDULE_CANCEL_CHANNEL, id);
		if (!c.go) return c.run;

		const ac = new AbortController();
		active.set(runId, ac);
		const limit = ctx.cfg.LS_SCHEDULE_OUTPUT_LIMIT;
		const kept: Uint8Array[] = [];
		let keptBytes = 0;
		const dec = new TextDecoder();
		const channel = scheduleRunChannel(runId);
		let patch: Partial<Run>;
		try {
			const { nodeId, spec } = await plan(ctx, s, runId);
			const job = ctx.nodes.runJob(nodeId, spec, { signal: ac.signal });
			for await (const chunk of job) {
				const room = limit - keptBytes;
				if (room <= 0) continue;
				const piece = chunk.data.subarray(0, room);
				kept.push(piece);
				keptBytes += piece.byteLength;
				void publishLive(ctx, {
					kind: "output",
					channel,
					stream: chunk.stream,
					data: dec.decode(piece, { stream: true }),
				}).catch(() => {});
			}
			const r = await job.result;
			patch = {
				status: r.exitCode === 0 ? "succeeded" : "failed",
				exitCode: r.exitCode,
				outputBytes: r.bytes,
				...(r.exitCode === null
					? { error: "the process left no exit code" }
					: {}),
			};
		} catch (e) {
			const cancelled = e instanceof NodeRunnerError && e.code === "cancelled";
			patch = {
				status: cancelled ? "cancelled" : "failed",
				error:
					e instanceof NodeRunnerError && e.code === "timeout"
						? `timed out after ${s.timeoutS}s`
						: errMsg(e),
				outputBytes: keptBytes,
			};
		} finally {
			active.delete(runId);
		}
		const output = new TextDecoder().decode(Buffer.concat(kept));
		// A run another worker already marked cancelled keeps that status.
		const [done] = await ctx.db
			.update(scheduleRun)
			.set({ ...patch, output, finishedAt: new Date() })
			.where(and(eq(scheduleRun.id, runId), eq(scheduleRun.status, "running")))
			.returning();
		if (!done) return c.run;
		const failed = done.status === "failed";
		if (done.status === "succeeded" || (failed && s.notifyOnFailure))
			await ctx.bus
				.publish(
					failed ? "schedule.failed" : "schedule.succeeded",
					s.organizationId,
					{ type: "schedule_run", id: runId },
					{
						scheduleId: s.id,
						scheduleName: s.name,
						projectId: s.projectId,
						exitCode: done.exitCode,
						error: done.error,
					},
				)
				.catch(() => {});
		log(failed ? "warn" : "info", `schedule run ${done.status}`, {
			scheduleId: s.id,
			runId,
			exitCode: done.exitCode,
		});
		return done;
	}

	return {
		process,
		close() {
			for (const ac of active.values()) ac.abort();
			sub.close();
		},
	};
}
