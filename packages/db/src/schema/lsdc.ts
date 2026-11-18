import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { timestamps } from "./columns.ts";
import { stack } from "./hierarchy.ts";

/**
 * What LogiStack knows about an LSDC instance beyond its stack: who it is sold to and for
 * how much. Limits are not here: they live on the service (spec resources, LSDC_* env).
 */
export const lsdcInstance = pgTable("lsdc_instance", {
	stackId: text("stack_id")
		.primaryKey()
		.references(() => stack.id, { onDelete: "cascade" }),
	customer: text("customer"),
	/** Monthly price in cents; null when not sold. */
	priceCents: integer("price_cents"),
	currency: text("currency").notNull().default("EUR"),
	...timestamps,
});
