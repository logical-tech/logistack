import type {
	IncidentImpact,
	IncidentStatus,
	MaintenanceRepeat,
	MonitorConfig,
	MonitorKind,
	MonitorStatus,
	StatusPageSection,
	StatusPageTheme,
} from "@logistack/contracts";
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";
import { project, service } from "./hierarchy.ts";
import { domain } from "./networking.ts";

/**
 * One uptime check. The worker's tick claims rows whose `next_check_at` is due; the check
 * result moves `status` through `pending -> up/down` once `down_after` / `up_after`
 * consecutive results agree (packages/core/src/uptime.ts).
 */
export const monitor = pgTable(
	"monitor",
	{
		id: id("mon"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => project.id, {
			onDelete: "set null",
		}),
		serviceId: text("service_id").references(() => service.id, {
			onDelete: "set null",
		}),
		/** The domain it was suggested for; suggestions skip domains that have one. */
		domainId: text("domain_id").references(() => domain.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		kind: text("kind").$type<MonitorKind>().notNull(),
		config: jsonb("config").$type<MonitorConfig>().notNull(),
		intervalSec: integer("interval_sec").notNull().default(60),
		retryIntervalSec: integer("retry_interval_sec").notNull().default(20),
		timeoutMs: integer("timeout_ms").notNull().default(10_000),
		downAfter: integer("down_after").notNull().default(3),
		upAfter: integer("up_after").notNull().default(1),
		resendMinutes: integer("resend_minutes").notNull().default(0),
		/** Opens an incident on `down` and resolves it on `up`. */
		autoIncident: boolean("auto_incident").notNull().default(true),
		enabled: boolean("enabled").notNull().default(true),
		/** SHA-256 of the push token, hex; push monitors only. */
		pushTokenHash: text("push_token_hash").unique(),
		status: text("status").$type<MonitorStatus>().notNull().default("pending"),
		/** Consecutive results equal to the last one (negative: failures). */
		streak: integer("streak").notNull().default(0),
		nextCheckAt: tstz("next_check_at").notNull().defaultNow(),
		lastCheckAt: tstz("last_check_at"),
		lastPingAt: tstz("last_ping_at"),
		lastLatencyMs: integer("last_latency_ms"),
		lastError: text("last_error"),
		statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
		lastNotifiedAt: tstz("last_notified_at"),
		certExpiresAt: tstz("cert_expires_at"),
		/** Smallest `warnDays` already announced for the current certificate. */
		certWarnedDays: integer("cert_warned_days"),
		...timestamps,
	},
	(t) => [
		index("monitor_organization_idx").on(t.organizationId),
		index("monitor_due_idx").on(t.nextCheckAt).where(sql`${t.enabled}`),
		check(
			"monitor_confirm_check",
			sql`${t.downAfter} >= 1 and ${t.upAfter} >= 1 and ${t.intervalSec} >= 20`,
		),
	],
);

/** Raw results, kept 48 hours. `region` is where the check ran (`worker` today). */
export const monitorCheck = pgTable(
	"monitor_check",
	{
		monitorId: text("monitor_id")
			.notNull()
			.references(() => monitor.id, { onDelete: "cascade" }),
		at: tstz("at").notNull().defaultNow(),
		ok: boolean("ok").notNull(),
		/** Ran during a maintenance window: kept, but left out of uptime. */
		maintenance: boolean("maintenance").notNull().default(false),
		latencyMs: integer("latency_ms"),
		error: text("error"),
		region: text("region").notNull().default("worker"),
	},
	(t) => [
		primaryKey({ columns: [t.monitorId, t.at] }),
		index("monitor_check_at_idx").on(t.at),
	],
);

const rollupColumns = {
	monitorId: text("monitor_id")
		.notNull()
		.references(() => monitor.id, { onDelete: "cascade" }),
	checks: integer("checks").notNull().default(0),
	failures: integer("failures").notNull().default(0),
	maintenance: integer("maintenance").notNull().default(0),
	latencySum: bigint("latency_sum", { mode: "number" }).notNull().default(0),
	latencyMax: integer("latency_max").notNull().default(0),
};

/** Incremented by every check; kept 30 days. */
export const monitorHourly = pgTable(
	"monitor_hourly",
	{ ...rollupColumns, hour: tstz("hour").notNull() },
	(t) => [primaryKey({ columns: [t.monitorId, t.hour] })],
);

/** Incremented by every check (UTC days); kept 400 days, read by the 90-day bars. */
export const monitorDaily = pgTable(
	"monitor_daily",
	{ ...rollupColumns, day: date("day").notNull() },
	(t) => [primaryKey({ columns: [t.monitorId, t.day] })],
);

export const incident = pgTable(
	"incident",
	{
		id: id("inc"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		status: text("status").$type<IncidentStatus>().notNull(),
		impact: text("impact").$type<IncidentImpact>().notNull().default("major"),
		/** Affected monitors; status pages show an incident when they list one of them. */
		monitorIds: jsonb("monitor_ids").$type<string[]>().notNull().default([]),
		/** Opened by a monitor going down; null for one written by hand. */
		openedByMonitorId: text("opened_by_monitor_id").references(
			() => monitor.id,
			{ onDelete: "set null" },
		),
		startedAt: tstz("started_at").notNull().defaultNow(),
		resolvedAt: tstz("resolved_at"),
		...timestamps,
	},
	(t) => [
		index("incident_organization_idx").on(t.organizationId, t.startedAt),
		// At most one open auto incident per monitor, so a flapping monitor reuses it.
		uniqueIndex("incident_open_monitor_idx")
			.on(t.openedByMonitorId)
			.where(sql`${t.resolvedAt} is null`),
	],
);

export const incidentUpdate = pgTable(
	"incident_update",
	{
		id: id("inu"),
		incidentId: text("incident_id")
			.notNull()
			.references(() => incident.id, { onDelete: "cascade" }),
		status: text("status").$type<IncidentStatus>().notNull(),
		message: text("message").notNull(),
		/** null when written by LogiStack itself. */
		authorId: text("author_id").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: tstz("created_at").notNull().defaultNow(),
	},
	(t) => [index("incident_update_incident_idx").on(t.incidentId)],
);

/**
 * A planned window: listed monitors show `maintenance` and send no alerts while it is active.
 * `repeat` re-runs the same UTC span every day or week after `startsAt`.
 */
export const maintenanceWindow = pgTable("maintenance_window", {
	id: id("mtw"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	title: text("title").notNull(),
	description: text("description").notNull().default(""),
	monitorIds: jsonb("monitor_ids").$type<string[]>().notNull().default([]),
	startsAt: tstz("starts_at").notNull(),
	endsAt: tstz("ends_at").notNull(),
	repeat: text("repeat").$type<MaintenanceRepeat>().notNull().default("none"),
	...timestamps,
});

/** Public page at `/status/<slug>` and, when set, at `https://<hostname>/` through Caddy. */
export const statusPage = pgTable("status_page", {
	id: id("stp"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	projectId: text("project_id").references(() => project.id, {
		onDelete: "set null",
	}),
	slug: text("slug").notNull().unique(),
	title: text("title").notNull(),
	description: text("description").notNull().default(""),
	/** Custom domain served by Caddy; its DNS must point at this instance. */
	hostname: text("hostname").unique(),
	sections: jsonb("sections")
		.$type<StatusPageSection[]>()
		.notNull()
		.default([]),
	theme: jsonb("theme").$type<StatusPageTheme>().notNull(),
	/** Days of history shown in the bars. */
	historyDays: integer("history_days").notNull().default(90),
	published: boolean("published").notNull().default(true),
	...timestamps,
});
