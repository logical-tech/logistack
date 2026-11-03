import { z } from "zod";
import { DatabaseEngine } from "./enums.ts";

export const DbColumn = z.object({
	name: z.string(),
	type: z.string(),
	nullable: z.boolean(),
	default: z.string().nullable(),
	primaryKey: z.boolean(),
});
export type DbColumn = z.infer<typeof DbColumn>;

export const dbTableKinds = [
	"table",
	"view",
	"materialized_view",
	"foreign_table",
] as const;

export const DbTable = z.object({
	name: z.string(),
	kind: z.enum(dbTableKinds),
	/** The planner's estimate; null when the table was never analyzed. */
	rows: z.number().nullable(),
	/** Rows can be edited in place: a table with a primary key. */
	editable: z.boolean(),
	columns: z.array(DbColumn),
});
export type DbTable = z.infer<typeof DbTable>;

export const DatabaseSchema = z.object({
	engine: DatabaseEngine,
	database: z.string(),
	schemas: z.array(z.object({ name: z.string(), tables: z.array(DbTable) })),
});
export type DatabaseSchema = z.infer<typeof DatabaseSchema>;
