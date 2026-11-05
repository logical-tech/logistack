import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { id, timestamps } from "./columns.ts";
import {
	migrationItemStatus,
	migrationSource,
	migrationStatus,
} from "./enums.ts";

/**
 * What the cutover stopped on the source, so a rollback restores it: Swarm services with the
 * replicas they had, and containers that were running.
 */
export type MigrationSourceState = {
	services: Record<string, number>;
	containers: string[];
};

/**
 * The proxy switch (MIG-4): what Traefik was, which nodes were waiting for ingress, and how it went.
 * Saved before anything changes, so the fallback restores it after a crash too.
 */
export type ProxySwitchState = {
	traefik?:
		| { kind: "container"; id: string; restartPolicy: string; running: boolean }
		| { kind: "service"; name: string; replicas: number };
	nodes?: string[];
	certificates?: {
		imported: string[];
		skipped: { hostname: string; reason: string }[];
		error?: string;
	};
	result?:
		| {
				status: "switched";
				at: string;
				probes: { hostname: string; ok: boolean; detail: string }[];
		  }
		| { status: "fell_back"; at: string; error: string };
};

/** A migration from another platform into one organization; its items carry the work. */
export const migration = pgTable("migration", {
	id: id("mig"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	source: migrationSource("source").notNull(),
	status: migrationStatus("status").notNull().default("planned"),
	proxyState: jsonb("proxy_state").$type<ProxySwitchState>(),
	/** Where the source's data was archived on decommission (MIG-7). */
	archivePath: text("archive_path"),
	...timestamps,
});

export const migrationItem = pgTable(
	"migration_item",
	{
		id: id("mgi"),
		migrationId: text("migration_id")
			.notNull()
			.references(() => migration.id, { onDelete: "cascade" }),
		/** `registry`, `s3Destination`... or a service kind (`application`, `postgres`, `compose`). */
		kind: text("kind").notNull(),
		/** The source's own id, unique per kind. */
		sourceId: text("source_id").notNull(),
		name: text("name").notNull(),
		/** Import order: organization resources first, then databases, apps, composes. */
		position: integer("position").notNull(),
		status: migrationItemStatus("status").notNull(),
		/** The inventory item as planned, drafts and notes included (encrypted secrets live here until import). */
		planEncrypted: text("plan_encrypted").notNull(),
		/** What the import created: the resource id, or service ids by slug for a multi-service item. */
		targets: jsonb("targets")
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		/** Saved by the first cutover step, before anything is stopped; never overwritten. */
		sourceState: jsonb("source_state").$type<MigrationSourceState>(),
		lastError: text("last_error"),
		...timestamps,
	},
	(t) => [
		uniqueIndex("migration_item_source").on(t.migrationId, t.kind, t.sourceId),
		index("migration_item_order").on(t.migrationId, t.position),
	],
);
