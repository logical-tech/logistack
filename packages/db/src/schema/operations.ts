import type {
	BackupRetention,
	EventType,
	LogDrainKind,
	NotificationRuleScope,
	ScheduleTarget,
} from "@logistack/contracts";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	index,
	inet,
	integer,
	jsonb,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";
import {
	auditActorKind,
	auditOutcome,
	backupRunKind,
	backupTarget,
	notificationChannelKind,
	runStatus,
	scheduleConcurrency,
} from "./enums.ts";
import { project, service } from "./hierarchy.ts";
import { s3Destination } from "./integrations.ts";
import { pluginInstall } from "./plugins.ts";

const org = () =>
	text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" });

export const backupPolicy = pgTable("backup_policy", {
	id: id("bkp"),
	serviceId: text("service_id")
		.notNull()
		.references(() => service.id, { onDelete: "cascade" }),
	target: backupTarget("target").notNull(),
	volumeName: text("volume_name"),
	s3DestinationId: text("s3_destination_id")
		.notNull()
		.references(() => s3Destination.id, { onDelete: "restrict" }),
	cron: text("cron").notNull(),
	timezone: text("timezone").notNull().default("UTC"),
	retention: jsonb("retention").$type<BackupRetention>().notNull(),
	verifyCron: text("verify_cron"),
	/** Volume backups only: scale the service to zero while the volume is read. */
	pauseService: boolean("pause_service").notNull().default(false),
	/** An age X25519 identity (`AGE-SECRET-KEY-1…`) sealed with the master key; null = plaintext backups. */
	encryptionKeyEncrypted: text("encryption_key_encrypted"),
	enabled: boolean("enabled").notNull().default(true),
	...timestamps,
});

export const backupRun = pgTable(
	"backup_run",
	{
		id: id("bkr"),
		policyId: text("policy_id")
			.notNull()
			.references(() => backupPolicy.id, { onDelete: "cascade" }),
		kind: backupRunKind("kind").notNull(),
		status: runStatus("status").notNull().default("running"),
		sizeBytes: bigint("size_bytes", { mode: "number" }),
		objectKey: text("object_key"),
		checksum: text("checksum"),
		startedAt: tstz("started_at").notNull().defaultNow(),
		finishedAt: tstz("finished_at"),
		error: text("error"),
		/** Verify: what the sanity query found. Restore: where the data went. */
		detail: text("detail"),
		/** Verify and restore: the backup they read. */
		sourceRunId: text("source_run_id").references(
			(): AnyPgColumn => backupRun.id,
			{ onDelete: "set null" },
		),
		/** Restore: the service written to. */
		targetServiceId: text("target_service_id").references(() => service.id, {
			onDelete: "set null",
		}),
		/** Retention deleted the object; the row stays as history. */
		prunedAt: tstz("pruned_at"),
		...timestamps,
	},
	(t) => [
		index("backup_run_policy_started_idx").on(t.policyId, t.startedAt.desc()),
	],
);

export const schedule = pgTable("schedule", {
	id: id("sch"),
	organizationId: org(),
	projectId: text("project_id").references(() => project.id, {
		onDelete: "cascade",
	}),
	name: text("name").notNull(),
	cron: text("cron").notNull(),
	timezone: text("timezone").notNull().default("UTC"),
	script: text("script").notNull(),
	target: jsonb("target").$type<ScheduleTarget>().notNull(),
	timeoutS: integer("timeout_s").notNull(),
	concurrency: scheduleConcurrency("concurrency").notNull().default("forbid"),
	/** Publish `schedule.failed` for notification rules when a run fails. */
	notifyOnFailure: boolean("notify_on_failure").notNull().default(true),
	enabled: boolean("enabled").notNull().default(true),
	...timestamps,
});

export const scheduleRun = pgTable(
	"schedule_run",
	{
		id: id("scr"),
		scheduleId: text("schedule_id")
			.notNull()
			.references(() => schedule.id, { onDelete: "cascade" }),
		status: runStatus("status").notNull().default("running"),
		trigger: text("trigger")
			.$type<"cron" | "manual">()
			.notNull()
			.default("cron"),
		exitCode: integer("exit_code"),
		/** Capped at the worker's output limit; `output_bytes` counts everything the script wrote. */
		output: text("output"),
		outputBytes: bigint("output_bytes", { mode: "number" }),
		/** Why the run could not start or finish (node offline, timeout), apart from its output. */
		error: text("error"),
		startedAt: tstz("started_at").notNull().defaultNow(),
		finishedAt: tstz("finished_at"),
		...timestamps,
	},
	(t) => [
		index("schedule_run_schedule_started_idx").on(
			t.scheduleId,
			t.startedAt.desc(),
		),
	],
);

export const notificationChannel = pgTable("notification_channel", {
	id: id("nch"),
	organizationId: org(),
	kind: notificationChannelKind("kind").notNull(),
	name: text("name").notNull(),
	// Encrypted JSON document (v1:<iv>:<ct>), not jsonb: webhook URLs and tokens are secrets.
	configEncrypted: text("config_encrypted").notNull(),
	/** Kind `plugin`: the install contributing it and the channel's name in its manifest. */
	pluginInstallId: text("plugin_install_id").references(() => pluginInstall.id),
	pluginProvider: text("plugin_provider"),
	...timestamps,
});

export const notificationRule = pgTable("notification_rule", {
	id: id("nrl"),
	organizationId: org(),
	events: text("events").array().$type<EventType[]>().notNull(),
	scope: jsonb("scope").$type<NotificationRuleScope>().notNull().default({}),
	channelId: text("channel_id")
		.notNull()
		.references(() => notificationChannel.id, { onDelete: "cascade" }),
	enabled: boolean("enabled").notNull().default(true),
	...timestamps,
});

export const logDrain = pgTable("log_drain", {
	id: id("lgd"),
	organizationId: org(),
	name: text("name").notNull(),
	kind: text("kind").$type<LogDrainKind>().notNull(),
	/** Where it ships, without credentials, for lists. */
	target: text("target").notNull(),
	// Encrypted JSON `LogDrainConfig`: URLs, API keys and passwords are secrets.
	configEncrypted: text("config_encrypted").notNull(),
	enabled: boolean("enabled").notNull().default(true),
	/** Every service in these projects ships here. Ids of deleted ones are ignored. */
	projectIds: text("project_ids").array().notNull().default([]),
	serviceIds: text("service_ids").array().notNull().default([]),
	...timestamps,
});

// Append-only (UPDATE blocked by trigger). No FK on organization_id: the trail outlives the org.
// shortcut: no partitions yet, add when table > 10M rows
export const auditLog = pgTable(
	"audit_log",
	{
		id: id("aud"),
		organizationId: text("organization_id").notNull(),
		actorKind: auditActorKind("actor_kind").notNull(),
		actorId: text("actor_id").notNull(),
		action: text("action").notNull(),
		resourceType: text("resource_type").notNull(),
		resourceId: text("resource_id"),
		// Secrets must be redacted before insert.
		diff: jsonb("diff"),
		ip: inet("ip"),
		userAgent: text("user_agent"),
		requestId: text("request_id"),
		outcome: auditOutcome("outcome").notNull(),
		at: tstz("at").notNull().defaultNow(),
	},
	(t) => [index("audit_log_org_at_idx").on(t.organizationId, t.at)],
);
