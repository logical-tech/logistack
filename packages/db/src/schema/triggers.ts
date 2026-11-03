import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { timestamps } from "./columns.ts";
import { service } from "./hierarchy.ts";
import { registry } from "./integrations.ts";

/** Monorepo watch paths: a push deploys the service only when it touches one of them. No row means any push. */
export const serviceWatchPaths = pgTable("service_watch_paths", {
	serviceId: text("service_id")
		.primaryKey()
		.references(() => service.id, { onDelete: "cascade" }),
	paths: text("paths").array().notNull(),
	...timestamps,
});

/** Image retention for a registry: the newest `keep_tags` images of each service survive pruning. */
export const registryRetention = pgTable("registry_retention", {
	registryId: text("registry_id")
		.primaryKey()
		.references(() => registry.id, { onDelete: "cascade" }),
	keepTags: integer("keep_tags").notNull(),
	...timestamps,
});
