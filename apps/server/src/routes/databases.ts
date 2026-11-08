import { createRoute, z } from "@hono/zod-openapi";
import {
	ApiError,
	CreateDatabase,
	CreateRole,
	DatabaseSchema,
	DocumentsPage,
	DocumentWrite,
	DocumentWritten,
	QueryRequest,
	QueryResult,
	REDIS_KEYS_LIMIT,
	RedisCommand,
	RedisDb,
	RedisKeysPage,
	RedisReply,
	RedisValue,
	RedisWrite,
	RedisWritten,
	ROWS_LIMIT,
	RowFilter,
	RowSort,
	RowsPage,
	RowsWrite,
	RowsWritten,
	SetRolePassword,
} from "@logistack/contracts";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import {
	cancelRun,
	closeDatabase,
	documentClient,
	dumpResponse,
	dumpTarget,
	keyValueClient,
	openDatabase,
	restoreFrom,
	runQuery,
	sqlClient,
} from "../database.ts";
import { Failure, notFound, parseInput } from "../errors.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { byParam, requirePermission } from "../scope.ts";

const Id = z.object({ id: z.string() });
const TableParams = z.object({
	id: z.string(),
	schema: z.string().min(1),
	table: z.string().min(1),
});
const CollectionParams = z.object({
	id: z.string(),
	database: z.string().min(1),
	collection: z.string().min(1),
});
const svc = byParam("service");

const DatabaseParam = z.object({
	database: z
		.string()
		.min(1)
		.max(128)
		.optional()
		.describe(
			"Postgres, MySQL, MariaDB: the database to open instead of the service's default one",
		),
});

const DocumentsParams = z.object({
	limit: z.coerce.number().int().min(1).max(ROWS_LIMIT).default(100),
	cursor: z.string().optional(),
	filter: z
		.string()
		.optional()
		.describe('Extended JSON query, e.g. {"qty":{"$gt":5}}'),
	sort: z.string().optional().describe('Extended JSON sort, e.g. {"at":-1}'),
	projection: z
		.string()
		.optional()
		.describe('Extended JSON projection, e.g. {"name":1}'),
});

const RowsParams = DatabaseParam.extend({
	limit: z.coerce.number().int().min(1).max(ROWS_LIMIT).default(100),
	cursor: z.string().optional(),
	sort: z
		.string()
		.optional()
		.describe('JSON array of RowSort, e.g. [{"column":"id","desc":true}]'),
	filter: z
		.string()
		.optional()
		.describe(
			'JSON array of RowFilter, e.g. [{"column":"name","op":"contains","value":"x"}]',
		),
});

const KeysParams = z.object({
	db: z.coerce.number().pipe(RedisDb).default(0),
	match: z
		.string()
		.min(1)
		.max(1024)
		.default("*")
		.describe("SCAN MATCH glob, e.g. session:*"),
	cursor: z.string().regex(/^\d+$/).optional(),
	count: z.coerce.number().int().min(1).max(REDIS_KEYS_LIMIT).default(200),
});

const ValueParams = z.object({
	db: z.coerce.number().pipe(RedisDb).default(0),
	key: z
		.string()
		.describe("The key as UTF-8, or base64 with `encoding=base64`"),
	encoding: z.enum(["utf8", "base64"]).default("utf8"),
	cursor: z.string().max(64).optional(),
	count: z.coerce.number().int().min(1).max(REDIS_KEYS_LIMIT).default(200),
});

function jsonParam(raw: string | undefined, name: string): unknown {
	if (raw === undefined) return [];
	try {
		return JSON.parse(raw);
	} catch {
		throw new Failure("validation_failed", `${name} is not valid JSON`);
	}
}

export const databases = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/databases/{id}/schema",
			tags: ["databases"],
			security,
			summary: "Schemas, tables, views and columns of a database service",
			description:
				"A database deployed before the explorer existed is not on its network yet: the call fails with 409 and `details.reason` `unreachable` until the service is redeployed.",
			middleware: [requirePermission("read", svc)],
			request: { params: Id, query: DatabaseParam },
			responses: { 200: json(DatabaseSchema, "Schema"), ...errors },
		}),
		async (c) => {
			const db = await openDatabase(
				c,
				c.req.valid("param").id,
				c.req.valid("query").database,
			);
			const schema = await db.client.introspect();
			return c.json(
				db.client.kind === "sql" && db.defaultDatabase
					? { ...schema, defaultDatabase: db.defaultDatabase }
					: schema,
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/databases/{id}/tables/{schema}/{table}/rows",
			tags: ["databases"],
			security,
			summary: "One page of a table's or view's rows, sorted and filtered",
			description:
				"Pass `nextCursor` back as `cursor` for the next page, with the same sort and filter.",
			middleware: [requirePermission("read", svc)],
			request: { params: TableParams, query: RowsParams },
			responses: { 200: json(RowsPage, "Rows"), ...errors },
		}),
		async (c) => {
			const { id, schema, table } = c.req.valid("param");
			const q = c.req.valid("query");
			const query = {
				limit: q.limit,
				cursor: q.cursor,
				sort: parseInput(z.array(RowSort), jsonParam(q.sort, "sort")),
				filter: parseInput(z.array(RowFilter), jsonParam(q.filter, "filter")),
			};
			const db = await openDatabase(c, id, q.database);
			return c.json(await sqlClient(db).rows({ schema, table }, query), 200);
		},
	)
	.openapi(
		mutation(
			"database.rows_write",
			createRoute({
				method: "post",
				path: "/databases/{id}/tables/{schema}/{table}/rows",
				tags: ["databases"],
				security,
				summary: "Insert, update and delete rows in one transaction",
				description:
					"Updates and deletes address a row by its full primary key. When one of them does not hit exactly one row the whole batch rolls back with 409 and `details.reason` `stale`. Tables without a primary key and views are rejected with 400.",
				middleware: [requirePermission("write", svc)],
				request: {
					params: TableParams,
					query: DatabaseParam,
					...body(RowsWrite),
				},
				responses: { 200: json(RowsWritten, "Written rows"), ...errors },
			}),
		),
		async (c) => {
			const { id, schema, table } = c.req.valid("param");
			c.set("auditResourceId", id);
			const db = await openDatabase(c, id, c.req.valid("query").database);
			return c.json(
				await sqlClient(db).mutate({ schema, table }, c.req.valid("json").ops),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/databases/{id}/collections/{database}/{collection}/documents",
			tags: ["databases"],
			security,
			summary: "One page of a MongoDB collection's documents",
			description:
				"Documents come back as canonical Extended JSON v2, so ObjectId, dates, int32/long/double, Decimal128 and binary keep their exact type. `filter`, `sort` and `projection` are Extended JSON objects given to `find`, never shell code: `$where`, `$function` and `$accumulator` are rejected with 400 wherever they appear. `_id` is always returned. Pass `nextCursor` back as `cursor` with the same filter and sort. Each find runs under a 30 s maxTimeMS.",
			middleware: [requirePermission("read", svc)],
			request: { params: CollectionParams, query: DocumentsParams },
			responses: { 200: json(DocumentsPage, "Documents"), ...errors },
		}),
		async (c) => {
			const { id, database, collection } = c.req.valid("param");
			const db = await openDatabase(c, id);
			return c.json(
				await documentClient(db).find(
					{ database, collection },
					c.req.valid("query"),
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"database.document_write",
			createRoute({
				method: "post",
				path: "/databases/{id}/collections/{database}/{collection}/documents",
				tags: ["databases"],
				security,
				summary: "Insert, replace or delete one MongoDB document",
				description:
					"One operation per request, so it is atomic on a standalone server, which has no multi-document transactions. Documents and `_id`s are Extended JSON. A replace or delete whose `_id` matches nothing is a 409 with `details.reason` `stale`. A replace stores the whole document it is given: send every field, not a projection.",
				middleware: [requirePermission("write", svc)],
				request: { params: CollectionParams, ...body(DocumentWrite) },
				responses: {
					200: json(DocumentWritten, "Written document"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id, database, collection } = c.req.valid("param");
			const op = c.req.valid("json");
			c.set("auditResourceId", id);
			c.set("auditDiff", {
				database,
				collection,
				op: op.op,
				...(op.op === "insert" ? {} : { id: op.id }),
			});
			const db = await openDatabase(c, id);
			return c.json(
				await documentClient(db).write({ database, collection }, op),
				200,
			);
		},
	)
	.openapi(
		// A route that only reads still records who ran which SQL, with the readOnly flag.
		mutation(
			"database.query",
			createRoute({
				method: "post",
				path: "/databases/{id}/query",
				tags: ["databases"],
				security,
				summary: "Run SQL against a database service",
				description:
					"Statements run in order in one transaction, each under a 30 s statement timeout. Needs `write` even when `readOnly` (the default): the explorer connects as the database superuser, and READ ONLY does not stop superuser side effects such as `COPY ... TO PROGRAM`. `readOnly` runs the transaction READ ONLY as a guard against mistakes, not as a privilege boundary. Each statement returns at most 1000 rows. A failing statement rolls the run back and is reported in `error` with a 200; earlier statements' results are still returned. Every run is audited with its SQL text. Pass a `runId` to cancel the run with `DELETE /databases/{id}/query/{runId}`.",
				middleware: [requirePermission("write", svc)],
				request: { params: Id, query: DatabaseParam, ...body(QueryRequest) },
				responses: { 200: json(QueryResult, "Results"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { database } = c.req.valid("query");
			const diff = {
				sql: input.sql,
				readOnly: input.readOnly,
				...(database && { database }),
			};
			c.set("auditResourceId", id);
			c.set("auditDiff", diff);
			const db = await openDatabase(c, id, database);
			const result = await runQuery(db, requireActor(c).id, input);
			if (result.error) c.set("auditDiff", { ...diff, error: result.error });
			return c.json(result, 200);
		},
	)
	.openapi(
		mutation(
			"database.query_cancel",
			createRoute({
				method: "delete",
				path: "/databases/{id}/query/{runId}",
				tags: ["databases"],
				security,
				summary: "Cancel a running query",
				description:
					"Cancels the caller's own run; the run's request then returns with error code 57014 and nothing it did persists. 404 when the run already finished or belongs to someone else.",
				middleware: [requirePermission("read", svc)],
				request: { params: z.object({ id: z.string(), runId: z.string() }) },
				responses: { 204: { description: "Cancelled" }, ...errors },
			}),
		),
		async (c) => {
			const { id, runId } = c.req.valid("param");
			c.set("auditResourceId", id);
			if (!cancelRun(id, requireActor(c).id, runId)) throw notFound("run");
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"database.create",
			createRoute({
				method: "post",
				path: "/databases/{id}/databases",
				tags: ["databases"],
				security,
				summary: "Create a database in a Postgres, MySQL or MariaDB service",
				description:
					"Postgres: a new database owned by the service's superuser. MySQL and MariaDB: a new schema. 400 when one with that name exists.",
				middleware: [requirePermission("write", svc)],
				request: { params: Id, ...body(CreateDatabase) },
				responses: {
					201: json(CreateDatabase, "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { name } = c.req.valid("json");
			c.set("auditResourceId", id);
			c.set("auditDiff", { name });
			await sqlClient(await openDatabase(c, id)).createDatabase(name);
			return c.json({ name }, 201);
		},
	)
	.openapi(
		mutation(
			"database.drop",
			createRoute({
				method: "delete",
				path: "/databases/{id}/databases/{name}",
				tags: ["databases"],
				security,
				summary: "Drop a database of a Postgres, MySQL or MariaDB service",
				description:
					"Deletes the database and everything in it; Postgres ends the sessions open on it first. Needs `admin`. The service's default database (the one the explorer logs into) is a 400, as are MySQL's system schemas. 404 when there is no such database.",
				middleware: [requirePermission("admin", svc)],
				request: {
					params: z.object({ id: z.string(), name: z.string().min(1) }),
				},
				responses: { 204: { description: "Dropped" }, ...errors },
			}),
		),
		async (c) => {
			const { id, name } = c.req.valid("param");
			c.set("auditResourceId", id);
			c.set("auditDiff", { name });
			const db = await openDatabase(c, id);
			const client = sqlClient(db);
			if (name === db.defaultDatabase)
				throw new Failure(
					"bad_request",
					`${name} is the service's default database and cannot be dropped`,
				);
			await closeDatabase(id, name);
			await client.dropDatabase(name);
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"database.role.create",
			createRoute({
				method: "post",
				path: "/databases/{id}/roles",
				tags: ["databases"],
				security,
				summary: "Create a role in Postgres, or an account in MySQL or MariaDB",
				description:
					"Needs `admin`. The password never reaches the audit log, and Postgres only receives a SCRAM-SHA-256 verifier of it. Attributes, memberships and grants are SQL: run them through `POST /databases/{id}/query`. 400 when the role exists.",
				middleware: [requirePermission("admin", svc)],
				request: { params: Id, ...body(CreateRole) },
				responses: {
					201: json(z.object({ name: z.string() }), "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const role = c.req.valid("json");
			c.set("auditResourceId", id);
			c.set("auditDiff", {
				name: role.name,
				host: role.host,
				login: role.login,
			});
			await sqlClient(await openDatabase(c, id)).createRole(role);
			return c.json({ name: role.name }, 201);
		},
	)
	.openapi(
		mutation(
			"database.role.password",
			createRoute({
				method: "put",
				path: "/databases/{id}/roles/{name}/password",
				tags: ["databases"],
				security,
				summary: "Set the password of a database role or account",
				description:
					"Needs `admin`; never audited with the password. The explorer's own login is a 400: change it in the service's env and redeploy.",
				middleware: [requirePermission("admin", svc)],
				request: {
					params: z.object({ id: z.string(), name: z.string().min(1) }),
					...body(SetRolePassword),
				},
				responses: { 204: { description: "Set" }, ...errors },
			}),
		),
		async (c) => {
			const { id, name } = c.req.valid("param");
			const { host, password } = c.req.valid("json");
			c.set("auditResourceId", id);
			c.set("auditDiff", { name, host });
			await sqlClient(await openDatabase(c, id)).setPassword(
				name,
				host,
				password,
			);
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/databases/{id}/dump",
			tags: ["databases"],
			security,
			summary: "Download a full dump of a database service",
			description:
				"Streams the engine's own dump tool from the running replica as an attachment `<slug>-<YYYYMMDD-HHmmss>.<ext>`: Postgres `.dump` (pg_dump custom format), MySQL and MariaDB `.sql`, MongoDB `.archive`, Redis `.rdb`. Needs `read:secrets`, because a dump holds every row. A tool that fails before its first byte is a 409 with `details.reason` `tool_failed`, its exit code and stderr; one that fails later aborts the response, so the download fails instead of ending clean. HEAD runs the same checks without dumping. Every dump is audited as `database.dump` with its size when it ends.",
			middleware: [requirePermission("read:secrets", svc)],
			request: { params: Id },
			responses: { 200: { description: "The dump bytes" }, ...errors },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			// Hono answers HEAD with this GET handler; a probe must not start a dump.
			if (c.req.method === "HEAD") {
				await dumpTarget(c, id);
				return c.body(null, 200);
			}
			return dumpResponse(c, id);
		},
	)
	.openapi(
		mutation(
			"database.restore",
			createRoute({
				method: "post",
				path: "/databases/{id}/restore",
				tags: ["databases"],
				security,
				summary: "Restore a dump into a database service, replacing its data",
				description:
					"The raw request body (a file from the dump route, or the engine tool's own format) is piped into the engine's restore tool in the running replica, never buffered. It must carry a `Content-Length` no larger than the instance's limit (`MAX_RESTORE_BYTES`, default 20 GiB), checked before any byte reaches the tool: otherwise a 413 with `details.reason` `length_required` or `too_large` and `details.maxBytes`. Existing data is replaced. Needs `admin`. A non-zero exit is a 409 with `details.reason` `tool_failed`, its exit code and the tail of stderr. Redis is a 400: restore its volume from a backup instead.",
				middleware: [requirePermission("admin", svc)],
				request: { params: Id },
				responses: {
					200: json(z.object({ bytes: z.number() }), "Restored"),
					...errors,
					413: json(ApiError, "No Content-Length, or above the limit"),
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			c.set("auditDiff", {
				size: Number(c.req.header("content-length") ?? 0) || null,
			});
			const body = c.req.raw.body;
			if (!body) throw new Failure("bad_request", "empty body");
			return c.json(await restoreFrom(c, id, body), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/databases/{id}/keys",
			tags: ["databases"],
			security,
			summary: "One SCAN batch of a Redis logical database's keys",
			description:
				'Walks `SCAN` with `MATCH`, never `KEYS`, for up to about `count` keys, each with its type, TTL (`PTTL`) and `MEMORY USAGE`. Keys that are valid UTF-8 come back as strings, others as `{type: "base64", value}`. Pass `cursor` back with the same `match` for more; null means the scan is done. SCAN can repeat a key across batches.',
			middleware: [requirePermission("read", svc)],
			request: { params: Id, query: KeysParams },
			responses: { 200: json(RedisKeysPage, "Keys"), ...errors },
		}),
		async (c) => {
			const { db, ...q } = c.req.valid("query");
			const client = keyValueClient(
				await openDatabase(c, c.req.valid("param").id),
			);
			return c.json(await client.keys(db, q), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/databases/{id}/keys/value",
			tags: ["databases"],
			security,
			summary: "One page of a Redis key's value, by type",
			description:
				"A string returns its first MiB with `truncated`. A hash pages with `HSCAN`, a set with `SSCAN`, a list with `LRANGE` windows, a sorted set with `ZRANGE` windows in score order, a stream with `XRANGE`. Pass `cursor` back for the next page. 404 when the key is gone.",
			middleware: [requirePermission("read", svc)],
			request: { params: Id, query: ValueParams },
			responses: { 200: json(RedisValue, "Value"), ...errors },
		}),
		async (c) => {
			const { db, key, encoding, ...q } = c.req.valid("query");
			const client = keyValueClient(
				await openDatabase(c, c.req.valid("param").id),
			);
			return c.json(
				await client.value(
					db,
					encoding === "base64" ? { type: "base64", value: key } : key,
					q,
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"database.key_write",
			createRoute({
				method: "post",
				path: "/databases/{id}/keys",
				tags: ["databases"],
				security,
				summary: "Change one Redis key",
				description:
					"One op per request: set a string (an optional TTL; without one the key keeps its TTL), set or delete a hash field, add or remove a set or sorted-set member, set a list index, expire, persist, delete or rename (RENAMENX) the key. The key is WATCHed and its type checked before the op runs in MULTI/EXEC. When the key is gone, holds another type, or changes before EXEC, nothing is written and the answer is 409 with `details.reason` `stale`.",
				middleware: [requirePermission("write", svc)],
				request: { params: Id, ...body(RedisWrite) },
				responses: {
					200: json(RedisWritten, "The key after the write"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const op = c.req.valid("json");
			c.set("auditResourceId", id);
			c.set("auditDiff", { db: op.db, op: op.op, key: op.key });
			const client = keyValueClient(await openDatabase(c, id));
			return c.json(await client.write(op), 200);
		},
	)
	.openapi(
		mutation(
			"database.command",
			createRoute({
				method: "post",
				path: "/databases/{id}/command",
				tags: ["databases"],
				security,
				summary: "Run one Redis command",
				description:
					'`argv` is the command and its arguments as separate strings, never a command line. Only reads and key data commands are allowed; FLUSHALL, FLUSHDB, CONFIG, DEBUG, SHUTDOWN, MONITOR, KEYS, scripting (EVAL, FUNCTION, FCALL), replication, ACL, CLIENT, SELECT, MULTI, pub/sub, blocking commands and anything else off the allowlist are a 400. Needs `write`, and every run is audited with its argv. An error reply from Redis is a 200 whose `reply` has `type: "error"`.',
				middleware: [requirePermission("write", svc)],
				request: { params: Id, ...body(RedisCommand) },
				responses: { 200: json(RedisReply, "Reply"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db, argv } = c.req.valid("json");
			c.set("auditResourceId", id);
			c.set("auditDiff", { db, argv });
			const client = keyValueClient(await openDatabase(c, id));
			const result = await client.command(db, argv);
			if (result.reply.type === "error")
				c.set("auditDiff", { db, argv, error: result.reply.value });
			return c.json(result, 200);
		},
	);
