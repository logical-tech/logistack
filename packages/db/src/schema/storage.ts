import { pgTable, text, unique } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { id, timestamps } from "./columns.ts";
import { storageKeyAccessEnum } from "./enums.ts";
import { service } from "./hierarchy.ts";

/**
 * A scoped access key LogiStack created in a storage engine. The secret is shown once and
 * never stored; the engine is the source of truth for the credential, this row for its scope.
 */
export const storageAccessKey = pgTable(
	"storage_access_key",
	{
		id: id("sak"),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		accessKeyId: text("access_key_id").notNull(),
		buckets: text("buckets").array().notNull(),
		access: storageKeyAccessEnum("access").notNull(),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		...timestamps,
	},
	(t) => [unique("storage_access_key_unique").on(t.serviceId, t.accessKeyId)],
);
