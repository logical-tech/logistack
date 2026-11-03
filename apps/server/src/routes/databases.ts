import { createRoute, z } from "@hono/zod-openapi";
import {
	DatabaseSchema,
	QueryRequest,
	QueryResult,
	ROWS_LIMIT,
	RowFilter,
	RowSort,
	RowsPage,
	RowsWrite,
	RowsWritten,
} from "@logistack/contracts";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import {
	cancelRun,
	dumpResponse,
	dumpTarget,
	openDatabase,
	restoreFrom,
	runQuery,
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
const svc = byParam("service");

const RowsParams = z.object({
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
			request: { params: Id },
			responses: { 200: json(DatabaseSchema, "Schema"), ...errors },
		}),
		async (c) => {
			const db = await openDatabase(c, c.req.valid("param").id);
			return c.json(await db.client.introspect(), 200);
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
			const db = await openDatabase(c, id);
			return c.json(await db.client.rows({ schema, table }, query), 200);
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
				request: { params: TableParams, ...body(RowsWrite) },
				responses: { 200: json(RowsWritten, "Written rows"), ...errors },
			}),
		),
		async (c) => {
			const { id, schema, table } = c.req.valid("param");
			c.set("auditResourceId", id);
			const db = await openDatabase(c, id);
			return c.json(
				await db.client.mutate({ schema, table }, c.req.valid("json").ops),
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
				request: { params: Id, ...body(QueryRequest) },
				responses: { 200: json(QueryResult, "Results"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			c.set("auditResourceId", id);
			c.set("auditDiff", { sql: input.sql, readOnly: input.readOnly });
			const db = await openDatabase(c, id);
			const result = await runQuery(db, requireActor(c).id, input);
			if (result.error)
				c.set("auditDiff", {
					sql: input.sql,
					readOnly: input.readOnly,
					error: result.error,
				});
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
					"The raw request body (a file from the dump route, or the engine tool's own format) is piped into the engine's restore tool in the running replica, never buffered. Existing data is replaced. Needs `admin`. A non-zero exit is a 409 with `details.reason` `tool_failed`, its exit code and the tail of stderr. Redis is a 400: restore its volume from a backup instead.",
				middleware: [requirePermission("admin", svc)],
				request: { params: Id },
				responses: {
					200: json(z.object({ bytes: z.number() }), "Restored"),
					...errors,
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
	);
