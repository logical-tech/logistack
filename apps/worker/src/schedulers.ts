import {
	BACKUP_QUEUE,
	type BackupJob,
	backupSchedulerId,
	DBOPS_QUEUE,
	type DbOpsJob,
	MIGRATION_QUEUE,
	type MigrationJob,
	type PatchPolicy,
	patchWindowSchedulerId,
	SCAN_QUEUE,
	SCHEDULE_QUEUE,
	type ScanJob,
	type ScheduleJob,
} from "@logistack/contracts";
import { Queue } from "bullmq";
import { redisConnection } from "./queues.ts";

// BullMQ Job Schedulers for backup policies, schedules and the node cleanup. Postgres holds the desired state;
// the api upserts after each change and every worker converges all of them at boot, so a
// tick fires once per iteration however many workers run. The api imports this file too.

export type RunQueues = {
	backup: Queue<BackupJob>;
	schedule: Queue<ScheduleJob>;
	maintenance: Queue;
	migration: Queue<MigrationJob>;
	scan: Queue<ScanJob & { force?: boolean }>;
	dbops: Queue<DbOpsJob>;
	/** Work background jobs (imports). */
	work: Queue;
};

const keep = { removeOnComplete: { count: 200 }, removeOnFail: { count: 500 } };

export function openRunQueues(redisUrl: string): RunQueues {
	const connection = redisConnection(redisUrl);
	return {
		backup: new Queue<BackupJob>(BACKUP_QUEUE, { connection }),
		schedule: new Queue<ScheduleJob>(SCHEDULE_QUEUE, { connection }),
		maintenance: new Queue("maintenance", { connection }),
		migration: new Queue<MigrationJob>(MIGRATION_QUEUE, { connection }),
		scan: new Queue<ScanJob & { force?: boolean }>(SCAN_QUEUE, { connection }),
		dbops: new Queue<DbOpsJob>(DBOPS_QUEUE, { connection }),
		work: new Queue("work", { connection }),
	};
}

export type PolicyTimes = {
	id: string;
	cron: string;
	timezone: string;
	verifyCron: string | null;
	enabled: boolean;
};

export type ScheduleTimes = {
	id: string;
	cron: string;
	timezone: string;
	enabled: boolean;
};

export async function syncPolicySchedulers(q: RunQueues, p: PolicyTimes) {
	for (const kind of ["backup", "verify"] as const) {
		const id = backupSchedulerId(p.id, kind);
		const pattern = kind === "backup" ? p.cron : p.verifyCron;
		if (p.enabled && pattern)
			await q.backup.upsertJobScheduler(
				id,
				{ pattern, tz: p.timezone },
				{ name: "tick", data: { policyId: p.id, kind }, opts: keep },
			);
		else await q.backup.removeJobScheduler(id);
	}
}

export const dropPolicySchedulers = (q: RunQueues, policyId: string) =>
	Promise.all(
		(["backup", "verify"] as const).map((k) =>
			q.backup.removeJobScheduler(backupSchedulerId(policyId, k)),
		),
	);

export async function syncScheduleScheduler(q: RunQueues, s: ScheduleTimes) {
	if (s.enabled)
		await q.schedule.upsertJobScheduler(
			s.id,
			{ pattern: s.cron, tz: s.timezone },
			{ name: "tick", data: { scheduleId: s.id }, opts: keep },
		);
	else await q.schedule.removeJobScheduler(s.id);
}

export const CLEANUP_SCHEDULER = "node-cleanup";

export async function syncCleanupScheduler(
	q: Pick<RunQueues, "maintenance">,
	c: { enabled: boolean; cron: string; timezone: string },
) {
	if (c.enabled)
		await q.maintenance.upsertJobScheduler(
			CLEANUP_SCHEDULER,
			{ pattern: c.cron, tz: c.timezone },
			{ name: "cleanup", opts: keep },
		);
	else await q.maintenance.removeJobScheduler(CLEANUP_SCHEDULER);
}

/** Converges every Job Scheduler to the rows: upserts the wanted ones, removes the rest. */
export async function syncAllSchedulers(
	q: RunQueues,
	policies: PolicyTimes[],
	schedules: ScheduleTimes[],
) {
	for (const p of policies) await syncPolicySchedulers(q, p);
	for (const s of schedules) await syncScheduleScheduler(q, s);
	const wantedBackup = new Set(
		policies.flatMap((p) =>
			!p.enabled
				? []
				: [
						backupSchedulerId(p.id, "backup"),
						...(p.verifyCron ? [backupSchedulerId(p.id, "verify")] : []),
					],
		),
	);
	const wantedSchedule = new Set(
		schedules.filter((s) => s.enabled).map((s) => s.id),
	);
	for (const [queue, wanted] of [
		[q.backup, wantedBackup],
		[q.schedule, wantedSchedule],
	] as const)
		for (const js of await queue.getJobSchedulers(0, -1))
			if (!wanted.has(js.key)) await queue.removeJobScheduler(js.key);
}

/** An organization's patch window as a maintenance-queue Job Scheduler; removed when disabled. */
export async function syncPatchWindow(
	q: Pick<RunQueues, "maintenance">,
	organizationId: string,
	p: Pick<PatchPolicy, "enabled" | "cron" | "timezone">,
) {
	const id = patchWindowSchedulerId(organizationId);
	if (p.enabled)
		await q.maintenance.upsertJobScheduler(
			id,
			{ pattern: p.cron, tz: p.timezone },
			{ name: "patch-window", data: { organizationId }, opts: keep },
		);
	else await q.maintenance.removeJobScheduler(id);
}
