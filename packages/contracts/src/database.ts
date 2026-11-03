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

/** A schema-qualified table or view. */
export const TableRef = z.object({ schema: z.string(), table: z.string() });
export type TableRef = z.infer<typeof TableRef>;

/**
 * One value as it crosses the api, JSON-safe and lossless. `null` is SQL NULL. booleans,
 * int2/int4/oid and finite float4/float8 are JSON booleans and numbers. bigint, numeric, bytea
 * and json/jsonb are tagged `{ type, value }` with the engine's own text form as `value`
 * (`\x`-prefixed hex for bytea, the exact document text for json). Every other type,
 * timestamps, dates, uuids, arrays and NaN/Infinity included, is the engine's text output as a
 * plain string. Writes take the same shapes; plain strings are parsed by the engine as the
 * column's type.
 */
export const Cell = z.union([
	z.null(),
	z.boolean(),
	z.number(),
	z.string(),
	z.object({
		type: z.enum(["bigint", "numeric", "bytea", "json"]),
		value: z.string(),
	}),
]);
export type Cell = z.infer<typeof Cell>;

export const rowFilterOps = [
	"eq",
	"neq",
	"lt",
	"gt",
	"lte",
	"gte",
	"contains",
	"starts_with",
	"is_null",
	"not_null",
] as const;

/** `contains` and `starts_with` match the column's text form, case-sensitive and literal. */
export const RowFilter = z.object({
	column: z.string(),
	op: z.enum(rowFilterOps),
	/** The engine parses it as the column's type; ignored by is_null and not_null. */
	value: z.string().optional(),
});
export type RowFilter = z.infer<typeof RowFilter>;

export const RowSort = z.object({
	column: z.string(),
	desc: z.boolean().default(false),
});
export type RowSort = z.infer<typeof RowSort>;

export const ROWS_LIMIT = 500;

/**
 * One page of rows. With no sort the primary key orders the page. Sorting by exactly the
 * primary key, in one direction, pages by keyset; any other sort pages by offset with the
 * primary key as tiebreaker. Either way the client only passes back the opaque `nextCursor`.
 */
export const RowsQuery = z.object({
	limit: z.number().int().min(1).max(ROWS_LIMIT).default(100),
	cursor: z.string().optional(),
	sort: z.array(RowSort).default([]),
	filter: z.array(RowFilter).default([]),
});
export type RowsQuery = z.infer<typeof RowsQuery>;

/** Rows are arrays aligned with `columns`. */
export const RowsPage = z.object({
	columns: z.array(DbColumn),
	editable: z.boolean(),
	rows: z.array(z.array(Cell)),
	nextCursor: z.string().nullable(),
});
export type RowsPage = z.infer<typeof RowsPage>;

const Values = z.record(z.string(), Cell);

/** `key` is the full primary key; an update or delete that does not hit exactly one row fails the batch. */
export const RowPatch = z.discriminatedUnion("op", [
	z.object({ op: z.literal("insert"), values: Values }),
	z.object({
		op: z.literal("update"),
		key: Values,
		values: Values.refine((v) => Object.keys(v).length > 0, "nothing to set"),
	}),
	z.object({ op: z.literal("delete"), key: Values }),
]);
export type RowPatch = z.infer<typeof RowPatch>;

/** Applied in order, in one transaction. */
export const RowsWrite = z.object({
	ops: z.array(RowPatch).min(1).max(ROWS_LIMIT),
});
export type RowsWrite = z.infer<typeof RowsWrite>;

/** Per op, the row as written (aligned with the table's columns), or null for a delete. */
export const RowsWritten = z.object({
	rows: z.array(z.array(Cell).nullable()),
});
export type RowsWritten = z.infer<typeof RowsWritten>;
