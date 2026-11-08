import type { Template } from "@logistack/contracts";
import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { tstz } from "./columns.ts";

/**
 * The last verified copy of a community template index (docs/plans/plugins.md, phase 0).
 * Written only by an explicit Refresh, never on a timer; one row per index URL.
 */
export const communityTemplateIndex = pgTable("community_template_index", {
	url: text("url").primaryKey(),
	/** The key that signed this copy. */
	keyId: text("key_id").notNull(),
	/** Valid templates whose ids do not shadow a built-in one. */
	templates: jsonb("templates").$type<Template[]>().notNull(),
	/** Entries the index carried that failed the template schema. */
	skipped: integer("skipped").notNull().default(0),
	fetchedAt: tstz("fetched_at").notNull(),
});
