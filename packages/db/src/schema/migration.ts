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

/** A migration from another platform into one organization; its items carry the work. */
export const migration = pgTable("migration", {
	id: id("mig"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	source: migrationSource("source").notNull(),
	status: migrationStatus("status").notNull().default("planned"),
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
