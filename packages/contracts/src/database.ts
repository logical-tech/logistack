import { z } from "zod";
import { IpRange } from "./access.ts";
import { DatabaseEngine } from "./enums.ts";

export const DbColumn = z.object({
	name: z.string(),
	type: z.string(),
	nullable: z.boolean(),
	default: z.string().nullable(),
	primaryKey: z.boolean(),
});
export type DbColumn = z.infer<typeof DbColumn>;

/** A foreign key; `columns[i]` references `refColumns[i]`. */
export const DbForeignKey = z.object({
	name: z.string(),
	columns: z.array(z.string()),
	refSchema: z.string(),
	refTable: z.string(),
	refColumns: z.array(z.string()),
});
export type DbForeignKey = z.infer<typeof DbForeignKey>;

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
	/** Postgres, MySQL and MariaDB. */
	foreignKeys: z.array(DbForeignKey).optional(),
});
export type DbTable = z.infer<typeof DbTable>;

/**
 * For MongoDB, `schemas` are the databases and `tables` their collections and views: `rows` is
 * the estimated document count and `columns` the top-level fields of a sample, typed by the
 * first value seen (`objectId`, `string`, `date`, `long`...).
 */
export const DbEnum = z.object({
	name: z.string(),
	values: z.array(z.string()),
});
export type DbEnum = z.infer<typeof DbEnum>;

export const DbSequence = z.object({ name: z.string() });
export type DbSequence = z.infer<typeof DbSequence>;

export const DbRoutine = z.object({
	name: z.string(),
	kind: z.enum(["function", "procedure"]),
	/** The argument list as the engine prints it, e.g. `a integer, b text`. */
	arguments: z.string(),
	/** The result type; null for a procedure. */
	returns: z.string().nullable(),
});
export type DbRoutine = z.infer<typeof DbRoutine>;

/**
 * A Postgres role, or a MySQL or MariaDB account (`name`@`host`). `grants` are the privileges it
 * holds on the browsed database, by schema: Postgres table privileges (SELECT, INSERT...) summed
 * over the schema's tables; MySQL schema-level grants, with `*` for global ones.
 */
export const DbRole = z.object({
	name: z.string(),
	/** MySQL and MariaDB: the account's host, `%` for any. */
	host: z.string().optional(),
	/** Postgres: false for a group role, which cannot log in. */
	login: z.boolean(),
	superuser: z.boolean(),
	/** Postgres. */
	createDb: z.boolean().optional(),
	/** Postgres. */
	createRole: z.boolean().optional(),
	/** Postgres: the roles it is a member of. */
	memberOf: z.array(z.string()).optional(),
	grants: z.array(
		z.object({ schema: z.string(), privileges: z.array(z.string()) }),
	),
});
export type DbRole = z.infer<typeof DbRole>;

export const DatabaseSchema = z.object({
	engine: DatabaseEngine,
	database: z.string(),
	/** Postgres: every database of the instance that takes connections, sorted. */
	databases: z.array(z.string()).optional(),
	/** The database the explorer logs into when none is asked for; it cannot be dropped. */
	defaultDatabase: z.string().optional(),
	/** Postgres, MySQL, MariaDB: the explorer's own login, which it never drops or re-passwords. */
	user: z.string().optional(),
	/** Postgres, MySQL, MariaDB, sorted. */
	roles: z.array(DbRole).optional(),
	schemas: z.array(
		z.object({
			name: z.string(),
			tables: z.array(DbTable),
			/** Redis: keys in this logical database (whose name is its index); it has no tables. */
			keys: z.number().optional(),
			/** Postgres, in sort order. Objects owned by extensions are left out. */
			enums: z.array(DbEnum).optional(),
			/** Postgres. */
			sequences: z.array(DbSequence).optional(),
			/** Postgres functions and procedures; MySQL and MariaDB stored routines. */
			routines: z.array(DbRoutine).optional(),
		}),
	),
});
export type DatabaseSchema = z.infer<typeof DatabaseSchema>;

export const DatabaseName = z
	.string()
	.regex(
		/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/,
		"Start with a letter or _, then use letters, digits, _ or -, up to 63 characters",
	);

export const CreateDatabase = z.object({ name: DatabaseName });
export type CreateDatabase = z.infer<typeof CreateDatabase>;

export const RoleName = z
	.string()
	.regex(
		/^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/,
		"Start with a letter or _, then use letters, digits, _, . or -, up to 63 characters",
	);
export const RoleHost = z
	.string()
	.regex(
		/^[A-Za-z0-9%_.:-]{1,255}$/,
		"A hostname, an IP or a pattern such as % or 10.0.%",
	);
export const RolePassword = z.string().min(8).max(256);

/**
 * Postgres sends only a SCRAM-SHA-256 verifier computed by the api, so the password never
 * reaches the engine or its logs; MySQL and MariaDB redact it from theirs. It is never audited.
 */
export const CreateRole = z.object({
	name: RoleName,
	/** MySQL and MariaDB; `%` when left out. */
	host: RoleHost.optional(),
	/** Without one, Postgres refuses password logins and a MySQL account logs in with none. */
	password: RolePassword.optional(),
	/** Postgres: false creates a group role. MySQL accounts always log in. */
	login: z.boolean().default(true),
});
export type CreateRole = z.infer<typeof CreateRole>;

export const SetRolePassword = z.object({
	host: RoleHost.optional(),
	password: RolePassword,
});
export type SetRolePassword = z.infer<typeof SetRolePassword>;

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

/**
 * Redis bytes (a key, field, member or value): the UTF-8 text when the bytes are valid UTF-8,
 * otherwise tagged base64, so binary data round-trips exactly. Writes take the same shapes.
 */
export const RedisBytes = z.union([
	z.string(),
	z.object({ type: z.literal("base64"), value: z.base64() }),
]);
export type RedisBytes = z.infer<typeof RedisBytes>;

export const RedisDb = z.number().int().min(0).max(255);

/** One key as SCAN found it. */
export const RedisKey = z.object({
	key: RedisBytes,
	/** string, hash, list, set, zset, stream, or a module's type name; "none" when it expired meanwhile. */
	type: z.string(),
	/** Milliseconds until it expires; null when it never does. */
	ttlMs: z.number().nullable(),
	/** MEMORY USAGE in bytes; null when the server did not report it. */
	bytes: z.number().nullable(),
});
export type RedisKey = z.infer<typeof RedisKey>;

export const REDIS_KEYS_LIMIT = 1000;

/**
 * One SCAN batch. Pass `cursor` back for more with the same `match`; null when the scan is done.
 * SCAN may repeat a key that moved during a rehash, so a client dedupes across batches.
 */
export const RedisKeysPage = z.object({
	keys: z.array(RedisKey),
	cursor: z.string().nullable(),
});
export type RedisKeysPage = z.infer<typeof RedisKeysPage>;

export const REDIS_STRING_MAX = 1024 * 1024;

const RedisPage = {
	/** Elements in the whole key (STRLEN, HLEN, LLEN, SCARD, ZCARD, XLEN). */
	length: z.number(),
	/** Pass back as `cursor` for the next page; null on the last one. */
	cursor: z.string().nullable(),
};

/** A key's value by type, one page at a time. */
export const RedisValue = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("string"),
		value: RedisBytes,
		/** Only the first REDIS_STRING_MAX bytes are in `value`. */
		truncated: z.boolean(),
		length: z.number(),
	}),
	z.object({
		type: z.literal("hash"),
		entries: z.array(z.object({ field: RedisBytes, value: RedisBytes })),
		...RedisPage,
	}),
	z.object({
		type: z.literal("list"),
		items: z.array(RedisBytes),
		...RedisPage,
	}),
	z.object({
		type: z.literal("set"),
		members: z.array(RedisBytes),
		...RedisPage,
	}),
	/** Ordered by score; scores are Redis's own text (`inf`, `1.5`). */
	z.object({
		type: z.literal("zset"),
		members: z.array(z.object({ member: RedisBytes, score: z.string() })),
		...RedisPage,
	}),
	z.object({
		type: z.literal("stream"),
		entries: z.array(
			z.object({
				id: z.string(),
				fields: z.array(z.object({ field: RedisBytes, value: RedisBytes })),
			}),
		),
		...RedisPage,
	}),
]);
export type RedisValue = z.infer<typeof RedisValue>;

const Ttl = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * One write per request, atomic: the key is WATCHed, its type checked, and the op runs in
 * MULTI/EXEC. Every op but `set` needs the key to exist with the op's type (`expire`, `persist`,
 * `delete` and `rename` take any type); otherwise, or when the key changes between the check
 * and EXEC, it fails with 409 `stale`. `set` creates or overwrites a string and is stale only
 * when the key holds another type.
 */
const W = { db: RedisDb, key: RedisBytes };
export const RedisWrite = z.discriminatedUnion("op", [
	z.object({
		...W,
		op: z.literal("set"),
		value: RedisBytes,
		/** Expire after this many ms; without it the key keeps no TTL. */
		ttlMs: Ttl.optional(),
	}),
	z.object({
		...W,
		op: z.literal("hset"),
		field: RedisBytes,
		value: RedisBytes,
	}),
	z.object({ ...W, op: z.literal("hdel"), field: RedisBytes }),
	z.object({ ...W, op: z.literal("sadd"), member: RedisBytes }),
	z.object({ ...W, op: z.literal("srem"), member: RedisBytes }),
	z.object({
		...W,
		op: z.literal("zadd"),
		member: RedisBytes,
		score: z.number(),
	}),
	z.object({ ...W, op: z.literal("zrem"), member: RedisBytes }),
	z.object({
		...W,
		op: z.literal("lset"),
		index: z.number().int(),
		value: RedisBytes,
	}),
	z.object({ ...W, op: z.literal("expire"), ttlMs: Ttl }),
	z.object({ ...W, op: z.literal("persist") }),
	z.object({ ...W, op: z.literal("delete") }),
	/** Fails with 409 when `to` already exists. */
	z.object({ ...W, op: z.literal("rename"), to: RedisBytes }),
]);
export type RedisWrite = z.infer<typeof RedisWrite>;

/** The key after the write (the new name after a rename); null once it is gone. */
export const RedisWritten = z.object({ key: RedisKey.nullable() });
export type RedisWritten = z.infer<typeof RedisWritten>;

export const RedisCommand = z.object({
	db: RedisDb.default(0),
	/** The command and its arguments, e.g. ["HGET", "user:1", "name"]; never a shell string. */
	argv: z.array(RedisBytes).min(1).max(1000),
});
export type RedisCommand = z.input<typeof RedisCommand>;

/** A RESP2 reply as a tree. An error reply is a value too, not a failed request. */
export type RespValue =
	| { type: "null" }
	| { type: "integer"; value: number }
	| { type: "string"; value: RedisBytes }
	| { type: "error"; value: string }
	| { type: "array"; items: RespValue[] };
// The id names it as one OpenAPI component, which is what lets the generator follow the recursion.
export const RespValue: z.ZodType<RespValue> = z
	.lazy(() =>
		z.discriminatedUnion("type", [
			z.object({ type: z.literal("null") }),
			z.object({ type: z.literal("integer"), value: z.number() }),
			z.object({ type: z.literal("string"), value: RedisBytes }),
			z.object({ type: z.literal("error"), value: z.string() }),
			z.object({ type: z.literal("array"), items: z.array(RespValue) }),
		]),
	)
	.meta({ id: "RespValue" });

export const RedisReply = z.object({
	reply: RespValue,
	durationMs: z.number(),
});
export type RedisReply = z.infer<typeof RedisReply>;

// Public access, port forwards and upgrades (docs/plans/database-ops.md).

const AllowedRanges = z
	.array(IpRange)
	.min(1)
	.max(100)
	.describe(
		"Addresses and CIDR ranges allowed to connect, e.g. 203.0.113.7 or 198.51.100.0/24",
	);

export const PublicAccessInput = z.object({
	/** Must resolve to the database's node; Caddy issues its certificate. */
	hostname: z
		.string()
		.trim()
		.toLowerCase()
		.max(253)
		.regex(
			/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
			"a hostname such as db.example.com",
		),
	port: z.int().min(1024).max(65535),
	allowedCidrs: AllowedRanges,
});
export type PublicAccessInput = z.infer<typeof PublicAccessInput>;

export const PortForwardInput = z.object({
	minutes: z.int().min(5).max(480),
	/** Defaults to the caller's own address. */
	allowedCidrs: AllowedRanges.max(10).optional(),
});
export type PortForwardInput = z.infer<typeof PortForwardInput>;

export const DatabaseAccessView = z.object({
	id: z.string(),
	kind: z.enum(["public", "forward"]),
	hostname: z.string().nullable(),
	port: z.number(),
	allowedCidrs: z.array(z.string()),
	tlsRequired: z.boolean(),
	expiresAt: z.string().nullable(),
	status: z.enum(["pending", "waiting_certificate", "active", "error"]),
	statusMessage: z.string().nullable(),
	createdAt: z.string(),
	/** Where clients connect: the hostname, or the node's address for a forward. */
	host: z.string().nullable(),
	/** A connection URI with the engine's TLS parameter and `PASSWORD` in place of the password. */
	uri: z.string().nullable(),
});
export type DatabaseAccessView = z.infer<typeof DatabaseAccessView>;

export const DatabaseAccessList = z.object({
	access: z.array(DatabaseAccessView),
	/** The address this request came from, as the wizard's default allowlist entry. */
	yourIp: z.string().nullable(),
	/** False for libSQL, which has no TLS of its own. */
	exposable: z.boolean(),
});
export type DatabaseAccessList = z.infer<typeof DatabaseAccessList>;

export const DatabaseUpgradeInput = z.object({
	version: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(
			/^[A-Za-z0-9][A-Za-z0-9._-]*$/,
			"an image tag such as 17 or 17-alpine",
		),
});
export type DatabaseUpgradeInput = z.infer<typeof DatabaseUpgradeInput>;

export const DatabaseUpgradeView = z.object({
	id: z.string(),
	fromVersion: z.string(),
	toVersion: z.string(),
	status: z.enum(["running", "succeeded", "rolled_back", "failed"]),
	step: z.string(),
	message: z.string().nullable(),
	tables: z.number().nullable(),
	createdAt: z.string(),
	finishedAt: z.string().nullable(),
});
export type DatabaseUpgradeView = z.infer<typeof DatabaseUpgradeView>;
