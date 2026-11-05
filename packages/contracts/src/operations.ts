import { z } from "zod";

export const BackupRetention = z.object({
	count: z.int().positive().optional(),
	days: z.int().positive().optional(),
});
export type BackupRetention = z.infer<typeof BackupRetention>;

export const ScheduleTarget = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("ephemeral"), image: z.string().min(1) }),
	z.object({ kind: z.literal("service"), serviceId: z.string() }),
	z.object({ kind: z.literal("host"), nodeId: z.string() }),
]);
export type ScheduleTarget = z.infer<typeof ScheduleTarget>;

export const NotificationRuleScope = z.object({
	projectId: z.string().optional(),
	serviceId: z.string().optional(),
});
export type NotificationRuleScope = z.infer<typeof NotificationRuleScope>;

// BullMQ queues shared by the api (run now, scheduler upserts) and the worker (processors).
export const BACKUP_QUEUE = "backup";
/** Migration cutovers and rollbacks, one job per item at a time (job id = item id). */
export const MIGRATION_QUEUE = "migration";
export type MigrationJob =
	| { itemId: string; action: "cutover" | "rollback" }
	/** Hands 80/443 from the source's proxy to Caddy (MIG-4). */
	| { migrationId: string; action: "switch_proxy" }
	/** Archives the source and removes it (MIG-7). */
	| { migrationId: string; action: "decommission" };
export const SCHEDULE_QUEUE = "schedule";

/** Job Scheduler ids: one per policy and kind, one per schedule. */
export const backupSchedulerId = (
	policyId: string,
	kind: "backup" | "verify",
) => `${policyId}-${kind}`;

export const backupRunChannel = (runId: string) => `backup-run:${runId}`;
export const scheduleRunChannel = (runId: string) => `schedule-run:${runId}`;

/**
 * One backup, verify or restore. Scheduler ticks carry no `runId` (the worker creates the row);
 * the api passes the id of the row it answers with, which is also the BullMQ job id.
 */
export const BackupJob = z.object({
	policyId: z.string(),
	kind: z.enum(["backup", "verify", "restore"]),
	runId: z.string().optional(),
	/** The backup a verify or restore reads; a verify defaults to the newest good one. */
	sourceRunId: z.string().optional(),
	/** Restore only: the service the dump goes into. */
	targetServiceId: z.string().optional(),
	/** Volume restore only: into a fresh volume beside the original instead of over it. */
	newVolume: z.boolean().optional(),
});
export type BackupJob = z.infer<typeof BackupJob>;

export const ScheduleJob = z.object({
	scheduleId: z.string(),
	runId: z.string().optional(),
	trigger: z.enum(["cron", "manual"]).default("cron"),
});
export type ScheduleJob = z.input<typeof ScheduleJob>;

/** Where a restore writes: back into the policy's own service, or a new one beside it. */
export const RestoreTarget = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("same") }),
	z.object({ kind: z.literal("new"), name: z.string().trim().min(1).max(100) }),
]);
export type RestoreTarget = z.infer<typeof RestoreTarget>;
