import type {
	NodeJoinState,
	NodeJoinStep,
	PreflightCheck,
	ThresholdMetric,
} from "@logistack/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
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
import { sshKey } from "./integrations.ts";

// The raw samples and their 1m / 1h rollups (`metric_host_*`, `metric_container_*`) are
// range-partitioned by day, which Drizzle cannot declare; they live in 0004_metrics.sql and
// are read and written with plain SQL in apps/worker/src/metrics-store.ts.

/** Instance-wide retention; one row. */
export const monitoringSettings = pgTable(
	"monitoring_settings",
	{
		id: text("id").primaryKey().default("singleton"),
		rawRetentionHours: integer("raw_retention_hours").notNull().default(24),
		minuteRetentionDays: integer("minute_retention_days").notNull().default(7),
		hourRetentionDays: integer("hour_retention_days").notNull().default(90),
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
