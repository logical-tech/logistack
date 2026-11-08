import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	unique,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";
import { service } from "./hierarchy.ts";

// Public access, port forwards and major-version upgrades of database services
// (docs/plans/database-ops.md).

export type DatabaseAccessKind = "public" | "forward";
export type DatabaseAccessStatus =
	| "pending"
	| "waiting_certificate"
	| "active"
	| "error";

/** One gateway service (`ls-gw-<id>`) in front of a database. */
export const databaseAccess = pgTable(
	"database_access",
	{
		id: id("dba"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		kind: text("kind").$type<DatabaseAccessKind>().notNull(),
		/** Public access: the name the certificate is issued for, resolving to the database's node. */
		hostname: text("hostname"),
		/** Published in host mode on the database's node. */
		port: integer("port").notNull(),
		/** Addresses and CIDR ranges allowed to connect; anything else is dropped. */
		allowedCidrs: jsonb("allowed_cidrs").$type<string[]>().notNull(),
		/** The gateway refuses connections that do not open with a TLS request. */
		tlsRequired: boolean("tls_required").notNull(),
		/** Port forwards only: the gateway closes, and the worker removes it, at this time. */
		expiresAt: tstz("expires_at"),
		status: text("status")
			.$type<DatabaseAccessStatus>()
			.notNull()
			.default("pending"),
		statusMessage: text("status_message"),
		/** Expiry of the certificate the database was last deployed with; a newer one rolls it. */
		certNotAfter: tstz("cert_not_after"),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		...timestamps,
	},
	(t) => [
		unique("database_access_port").on(t.port),
		index("database_access_service_idx").on(t.serviceId),
	],
);

export type DatabaseUpgradeStatus =
	| "running"
	| "succeeded"
	| "rolled_back"
	| "failed";

export const databaseUpgrade = pgTable(
	"database_upgrade",
	{
		id: id("dbu"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		fromVersion: text("from_version").notNull(),
		toVersion: text("to_version").notNull(),
		status: text("status")
			.$type<DatabaseUpgradeStatus>()
			.notNull()
			.default("running"),
		/** The step running or last reached: check, instance, copy, verify, switch, reverify, rollback, done. */
		step: text("step").notNull().default("check"),
		message: text("message"),
		/** `service.data_volume_id` before the switch, put back by a rollback. */
		previousDataVolumeId: text("previous_data_volume_id"),
		/** Row counts per table (documents per collection) of the source, as verified. */
		counts: jsonb("counts").$type<Record<string, number>>(),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		finishedAt: tstz("finished_at"),
		...timestamps,
	},
	(t) => [index("database_upgrade_service_idx").on(t.serviceId)],
);
