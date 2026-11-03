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
	"collection",
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

/**
 * For MongoDB, `schemas` are the databases and `tables` their collections and views: `rows` is
 * the estimated document count and `columns` the top-level fields of a sample, typed by the
 * first value seen (`objectId`, `string`, `date`, `long`...).
 */
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

export const QUERY_ROWS_LIMIT = 1000;

export const QueryRequest = z.object({
	/** One or more statements separated by semicolons; they run in order, in one transaction. */
	sql: z.string().min(1).max(100_000),
	/** Read-only runs need `read` and run in a READ ONLY transaction; writes need `write`. */
	readOnly: z.boolean().default(true),
	/** Names the run, so `DELETE /databases/{id}/query/{runId}` can cancel it. */
	runId: z.uuid().optional(),
});
export type QueryRequest = z.input<typeof QueryRequest>;

export const QueryColumn = z.object({ name: z.string(), type: z.string() });
export type QueryColumn = z.infer<typeof QueryColumn>;

/** One statement's outcome. Rows are arrays aligned with `columns`; names may repeat. */
export const StatementResult = z.object({
	/** The statement's offsets in the request's `sql`. */
	from: z.number().int(),
	to: z.number().int(),
	/** The command tag's verb: SELECT, UPDATE, CREATE TABLE. */
	command: z.string(),
	columns: z.array(QueryColumn),
	rows: z.array(z.array(Cell)),
	/** More than QUERY_ROWS_LIMIT rows came back; only the first ones are here. */
	truncated: z.boolean(),
	/** Rows returned or affected; null when the command reports none or the rows were cut. */
	affected: z.number().nullable(),
	durationMs: z.number(),
});
export type StatementResult = z.infer<typeof StatementResult>;

export const QueryError = z.object({
	/** Index of the failing statement; the ones before it are in `results`. */
	statement: z.number().int(),
	message: z.string(),
	/** The SQLSTATE, e.g. 42601 for a syntax error or 57014 for a timeout or cancel. */
	code: z.string().optional(),
	/** 0-based offset of the error in the request's `sql`, when the engine reports one. */
	position: z.number().int().optional(),
});
export type QueryError = z.infer<typeof QueryError>;

/** On an error the whole transaction rolls back, so nothing a write run did persists. */
export const QueryResult = z.object({
	results: z.array(StatementResult),
	error: QueryError.nullable(),
});
export type QueryResult = z.infer<typeof QueryResult>;

/** A MongoDB collection or view. */
export const CollectionRef = z.object({
	database: z.string(),
	collection: z.string(),
});
export type CollectionRef = z.infer<typeof CollectionRef>;

/**
 * A document in canonical Extended JSON v2 (`{"$oid": ...}`, `{"$numberLong": ...}`,
 * `{"$date": {"$numberLong": ...}}`), so every BSON type round-trips exactly. Writes take any
 * Extended JSON; a plain JSON number is an int32 when it fits, else a long or a double.
 */
export const EjsonDocument = z.record(z.string(), z.unknown());
export type EjsonDocument = z.infer<typeof EjsonDocument>;

/**
 * One page of documents. `filter`, `sort` and `projection` are Extended JSON objects passed to
 * `find`; `$where`, `$function` and `$accumulator` are rejected anywhere in them. With no sort, or
 * a sort on `_id` alone, pages follow `_id`; any other sort pages by offset with `_id` as
 * tiebreaker. `_id` is always returned, so every document stays addressable.
 */
export const DocumentsQuery = z.object({
	limit: z.number().int().min(1).max(ROWS_LIMIT).default(100),
	cursor: z.string().optional(),
	filter: z.string().optional(),
	sort: z.string().optional(),
	projection: z.string().optional(),
});
export type DocumentsQuery = z.infer<typeof DocumentsQuery>;

export const DocumentsPage = z.object({
	documents: z.array(EjsonDocument),
	nextCursor: z.string().nullable(),
});
export type DocumentsPage = z.infer<typeof DocumentsPage>;

/** An `_id` as Extended JSON: `{"$oid": ...}`, a string, a number... */
const DocumentId = z.unknown().refine((v) => v !== undefined, "id is required");

/** One write per request, so it is atomic on a standalone server too. */
export const DocumentWrite = z.discriminatedUnion("op", [
	z.object({ op: z.literal("insert"), document: EjsonDocument }),
	z.object({
		op: z.literal("replace"),
		id: DocumentId,
		document: EjsonDocument,
	}),
	z.object({ op: z.literal("delete"), id: DocumentId }),
]);
export type DocumentWrite = z.infer<typeof DocumentWrite>;

/** The document as stored after an insert or replace; null after a delete. */
export const DocumentWritten = z.object({
	document: EjsonDocument.nullable(),
});
export type DocumentWritten = z.infer<typeof DocumentWritten>;
