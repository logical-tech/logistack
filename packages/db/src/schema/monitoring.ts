import type {
	AutoscaleBehavior,
	CleanupRun,
	NodeJoinState,
	NodeJoinStep,
	PreflightCheck,
	PruneTarget,
	ServiceThresholdMetric,
	ThresholdMetric,
} from "@logistack/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	real,
	text,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";
import { nodeRole } from "./enums.ts";
import { service } from "./hierarchy.ts";
import { sshKey } from "./integrations.ts";

// The raw samples and their 1m / 1h rollups (`metric_host_*`, `metric_container_*`) are
// range-partitioned by day, which Drizzle cannot declare; they live in 0004_metrics.sql and
// are read and written with plain SQL in apps/worker/src/metrics-store.ts.

/** Instance-wide retention and node cleanup schedule; one row. */
export const monitoringSettings = pgTable(
	"monitoring_settings",
	{
		id: text("id").primaryKey().default("singleton"),
		rawRetentionHours: integer("raw_retention_hours").notNull().default(24),
		minuteRetentionDays: integer("minute_retention_days").notNull().default(7),
		hourRetentionDays: integer("hour_retention_days").notNull().default(90),
		cleanupEnabled: boolean("cleanup_enabled").notNull().default(true),
		cleanupCron: text("cleanup_cron").notNull().default("0 3 * * *"),
		cleanupTimezone: text("cleanup_timezone").notNull().default("UTC"),
		cleanupTargets: jsonb("cleanup_targets")
			.$type<PruneTarget[]>()
			.notNull()
			.default(["containers", "images", "buildCache"]),
		cleanupUntilHours: integer("cleanup_until_hours").notNull().default(24),
		lastCleanup: jsonb("last_cleanup").$type<CleanupRun>(),
		...timestamps,
	},
	(t) => [
		check("monitoring_settings_singleton_check", sql`${t.id} = 'singleton'`),
	],
);

export const metricThreshold = pgTable("metric_threshold", {
	id: id("thr"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	metric: text("metric").$type<ThresholdMetric>().notNull(),
	/** `node.id`; null applies to every node of the organization. */
	nodeId: text("node_id"),
	percent: real("percent").notNull(),
	forSec: integer("for_sec").notNull(),
	enabled: boolean("enabled").notNull().default(true),
	...timestamps,
});

/** Last evaluated state per threshold and node, so each crossing emits one event. */
export const metricAlert = pgTable(
	"metric_alert",
	{
		thresholdId: text("threshold_id")
			.notNull()
			.references(() => metricThreshold.id, { onDelete: "cascade" }),
		swarmNodeId: text("swarm_node_id").notNull(),
		firing: boolean("firing").notNull(),
		value: real("value").notNull(),
		changedAt: tstz("changed_at").notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.thresholdId, t.swarmNodeId] })],
);

/** A CPU or memory limit on one service; it carries its own last state, one service per row. */
export const serviceThreshold = pgTable(
	"service_threshold",
	{
		id: id("sth"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		metric: text("metric").$type<ServiceThresholdMetric>().notNull(),
		above: real("above").notNull(),
		forSec: integer("for_sec").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		/** null until first evaluated. */
		firing: boolean("firing"),
		value: real("value"),
		...timestamps,
	},
	(t) => [index("service_threshold_service_idx").on(t.serviceId)],
);

/**
 * Autoscaling of one application service. While enabled, `replicas` replaces `spec.replicas`
 * as the desired count; the reconciler converges Swarm to it like any other drift.
 */
export const serviceAutoscale = pgTable(
	"service_autoscale",
	{
		serviceId: text("service_id")
			.primaryKey()
			.references(() => service.id, { onDelete: "cascade" }),
		enabled: boolean("enabled").notNull().default(true),
		minReplicas: integer("min_replicas").notNull(),
		maxReplicas: integer("max_replicas").notNull(),
		behavior: text("behavior").$type<AutoscaleBehavior>().notNull(),
		targetCpu: integer("target_cpu").notNull(),
		targetMemory: integer("target_memory"),
		/** The autoscaler's last decision; null until its first pass. */
		replicas: integer("replicas"),
		lastScaledAt: tstz("last_scaled_at"),
		lastReason: text("last_reason"),
		...timestamps,
	},
	(t) => [
		check(
			"service_autoscale_range_check",
			sql`${t.minReplicas} >= 1 and ${t.minReplicas} <= ${t.maxReplicas}`,
		),
	],
);

/** Rollup watermarks: buckets before `through` are final. */
export const metricRollupState = pgTable("metric_rollup_state", {
	name: text("name").primaryKey(),
	through: tstz("through").notNull(),
});

/**
 * One "Add server" wizard run. The server queues a step (`state = queued`); a worker claims it
 * (`queued -> running`), runs it over SSH and records the outcome.
 */
export const nodeJoin = pgTable("node_join", {
	id: id("njn"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	host: text("host").notNull(),
	port: integer("port").notNull().default(22),
	sshUser: text("ssh_user").notNull(),
	sshKeyId: text("ssh_key_id")
		.notNull()
		.references(() => sshKey.id, { onDelete: "cascade" }),
	role: nodeRole("role").notNull().default("worker"),
	labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
	step: text("step").$type<NodeJoinStep>().notNull().default("test"),
	state: text("state").$type<NodeJoinState>().notNull().default("queued"),
	error: text("error"),
	checks: jsonb("checks").$type<PreflightCheck[]>().notNull().default([]),
	log: jsonb("log").$type<string[]>().notNull().default([]),
	swarmNodeId: text("swarm_node_id"),
	nodeId: text("node_id"),
	/** known_hosts line pinned by the first successful connection. */
	hostKey: text("host_key"),
	claimedAt: tstz("claimed_at"),
	...timestamps,
});
