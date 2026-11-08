import { monitor } from "@logistack/db";
import type { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { hostPolicy } from "./ssrf.ts";
import { type CheckEnv, runCheck } from "./uptime-checks.ts";
import { type Publish, recordResult } from "./uptime-record.ts";

// Postgres holds each monitor's `next_check_at`; a BullMQ Job Scheduler fires `tick` every
// TICK_MS on any worker replica. The tick claims due monitors (skip locked, so replicas never
// share one) and queues one `check` job per monitor, its id the monitor's, so a monitor never
// runs twice at once.

export const UPTIME_TICK_MS = 5_000;
export const UPTIME_TICK_SCHEDULER = "uptime-tick";
const CLAIM_LIMIT = 500;

export type UptimeJob = { name: "tick" } | { name: "check"; monitorId: string };

/** Claims every due monitor and moves its `next_check_at` past the check's own timeout. */
export async function claimDue(
	ctx: Pick<Ctx, "db">,
	now = new Date(),
): Promise<{ id: string; kind: string }[]> {
	const rows = await ctx.db.execute<{ id: string; kind: string }>(sql`
		update monitor m set next_check_at = ${now.toISOString()}::timestamptz
			+ make_interval(secs => greatest(m.interval_sec, m.timeout_ms / 1000 + 5))
		where m.id in (
			select id from monitor
			where enabled and next_check_at <= ${now.toISOString()}::timestamptz
			order by next_check_at
			limit ${CLAIM_LIMIT}
			for update skip locked)
		returning m.id, m.kind`);
	return [...rows];
}

export async function enqueueDue(
	ctx: Pick<Ctx, "db">,
	queue: Pick<Queue, "addBulk">,
	now = new Date(),
) {
	const due = await claimDue(ctx, now);
	if (due.length)
		await queue.addBulk(
			due.map((m) => ({
				name: "check",
				data: { name: "check", monitorId: m.id } satisfies UptimeJob,
				opts: {
					jobId: `check:${m.id}`,
					removeOnComplete: true,
					removeOnFail: true,
				},
			})),
		);
	return due.length;
}

export const busPublish =
	(ctx: Pick<Ctx, "bus">): Publish =>
	(type, org, resource, payload) =>
		ctx.bus.publish(type, org, resource, payload);

export async function processCheck(
	ctx: Pick<Ctx, "db" | "bus">,
	monitorId: string,
	env?: CheckEnv,
) {
	const [m] = await ctx.db
		.select({
			config: monitor.config,
			timeoutMs: monitor.timeoutMs,
			enabled: monitor.enabled,
		})
		.from(monitor)
		.where(eq(monitor.id, monitorId));
	if (!m?.enabled) return;
	const result = await runCheck(
		m.config,
		m.timeoutMs,
		env ?? { policy: await hostPolicy(ctx.db) },
	);
	return recordResult(ctx.db, busPublish(ctx), monitorId, result);
}

/** Raw 48 h, hourly 30 days, daily 400 days. */
export async function applyUptimeRetention(ctx: Pick<Ctx, "db">) {
	await ctx.db.execute(
		sql`delete from monitor_check where at < now() - interval '48 hours'`,
	);
	await ctx.db.execute(
		sql`delete from monitor_hourly where hour < now() - interval '30 days'`,
	);
	await ctx.db.execute(
		sql`delete from monitor_daily where day < (now() - interval '400 days')::date`,
	);
}

export async function uptimeTick(ctx: Ctx) {
	const n = await enqueueDue(ctx, ctx.queues.uptime);
	if (n > 0) log("info", "uptime checks queued", { count: n });
	// Once an hour across replicas: the key is never released, it expires.
	const first = await ctx.bus.redis.send("SET", [
		"ls:uptime:retention",
		"1",
		"NX",
		"PX",
		"3600000",
	]);
	if (first === "OK")
		await applyUptimeRetention(ctx).catch((e: unknown) =>
			log("warn", "uptime retention failed", { error: String(e) }),
		);
}
