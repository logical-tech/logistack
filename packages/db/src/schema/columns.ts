import { type IdPrefix, newId } from "@logistack/core";
import { text, timestamp } from "drizzle-orm/pg-core";

export const id = (prefix: IdPrefix) =>
	text("id")
		.primaryKey()
		.$defaultFn(() => newId(prefix));

export const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const timestamps = {
	createdAt: tstz("created_at").defaultNow().notNull(),
	updatedAt: tstz("updated_at")
		.defaultNow()
		.notNull()
		.$onUpdate(() => new Date()),
};
