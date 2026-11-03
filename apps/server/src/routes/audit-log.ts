import { createRoute, z } from "@hono/zod-openapi";
import { AuditActorKind, AuditOutcome } from "@logistack/contracts";
import { apikey, auditLog, user } from "@logistack/db";
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gte,
	lte,
	type SQL,
	sql,
} from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import type { Env } from "../env.ts";
import { Failure } from "../errors.ts";
import { errors, json, router, security } from "../openapi.ts";
import { inOrganization, requirePermission } from "../scope.ts";

const AuditEntry = z
	.object({
		id: z.string(),
		organizationId: z.string(),
		actorKind: AuditActorKind,
		actorId: z.string(),
		/** The user's name, or the API key's; null for system actors and deleted subjects. */
		actorName: z.string().nullable(),
		action: z.string(),
		resourceType: z.string(),
		resourceId: z.string().nullable(),
		diff: z.unknown(),
		ip: z.string().nullable(),
		userAgent: z.string().nullable(),
		requestId: z.string().nullable(),
		outcome: AuditOutcome,
		at: z.string(),
	})
	.openapi("AuditEntry");

const Filters = z.object({
	action: z.string().optional(),
	actorId: z.string().optional(),
	resourceType: z.string().optional(),
	resourceId: z.string().optional(),
	outcome: AuditOutcome.optional(),
	from: z.iso.datetime({ offset: true }).optional(),
	to: z.iso.datetime({ offset: true }).optional(),
});
type Filters = z.infer<typeof Filters>;

const Query = Filters.extend({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});

const EXPORT_LIMIT = 10_000;

// The cursor carries Postgres' own microsecond timestamp text; a JS Date would lose precision.
const encodeCursor = (at: string, id: string) =>
	Buffer.from(JSON.stringify([at, id])).toString("base64url");

function decodeCursor(cursor: string): [string, string] {
	try {
		const v = JSON.parse(Buffer.from(cursor, "base64url").toString());
		if (
			Array.isArray(v) &&
			typeof v[0] === "string" &&
			typeof v[1] === "string"
		)
			return [v[0], v[1]];
	} catch {}
	throw new Failure("bad_request", "invalid cursor");
}

function entries(c: Context<Env>, q: Filters, after?: SQL) {
	return c.var.deps.db
		.select({
			...getTableColumns(auditLog),
			ip: sql<string | null>`host(${auditLog.ip})`,
			actorName: sql<string | null>`coalesce(${user.name}, ${apikey.name})`,
			cursorAt: sql<string>`${auditLog.at}::text`,
		})
		.from(auditLog)
		.leftJoin(user, eq(user.id, auditLog.actorId))
		.leftJoin(apikey, eq(apikey.id, auditLog.actorId))
		.where(
			and(
				eq(auditLog.organizationId, requireActor(c).organizationId),
				q.action ? eq(auditLog.action, q.action) : undefined,
				q.actorId ? eq(auditLog.actorId, q.actorId) : undefined,
				q.resourceType ? eq(auditLog.resourceType, q.resourceType) : undefined,
				q.resourceId ? eq(auditLog.resourceId, q.resourceId) : undefined,
				q.outcome ? eq(auditLog.outcome, q.outcome) : undefined,
				q.from ? gte(auditLog.at, new Date(q.from)) : undefined,
				q.to ? lte(auditLog.at, new Date(q.to)) : undefined,
				after,
			),
		)
		.orderBy(desc(auditLog.at), desc(auditLog.id));
}

const csvCell = (v: unknown) => {
	const s =
		v === null || v === undefined
			? ""
			: typeof v === "string"
				? v
				: JSON.stringify(v);
	// Quote everything; a leading = + - @ would otherwise run as a formula in spreadsheets.
	return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
};

const CSV_COLUMNS = [
	"at",
	"actorKind",
	"actorId",
	"actorName",
	"action",
	"resourceType",
	"resourceId",
	"outcome",
	"ip",
	"userAgent",
	"requestId",
	"diff",
] as const;

export const audit = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/audit-log",
			tags: ["audit"],
			security,
			summary: "Audit trail, newest first, cursor-paginated",
			middleware: [requirePermission("admin", inOrganization)],
			request: { query: Query },
			responses: {
				200: json(
					z.object({
						items: z.array(AuditEntry),
						nextCursor: z.string().nullable(),
					}),
					"A page of entries",
				),
				...errors,
			},
		}),
		async (c) => {
			const q = c.req.valid("query");
			const after = q.cursor ? decodeCursor(q.cursor) : undefined;
			const rows = await entries(
				c,
				q,
				after
					? sql`(${auditLog.at}, ${auditLog.id}) < (${after[0]}::timestamptz, ${after[1]})`
					: undefined,
			).limit(q.limit + 1);
			const page = rows.slice(0, q.limit);
			const last = page.at(-1);
			const items = page.map(({ cursorAt: _, ...entry }) => entry);
			return c.json(
				{
					items,
					nextCursor:
						rows.length > q.limit && last
							? encodeCursor(last.cursorAt, last.id)
							: null,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/audit-log/export",
			tags: ["audit"],
			security,
			summary: `Download the filtered trail as CSV or JSON (newest ${EXPORT_LIMIT} entries)`,
			middleware: [requirePermission("admin", inOrganization)],
			request: {
				query: Filters.extend({
					format: z.enum(["csv", "json"]).default("csv"),
				}),
			},
			responses: {
				200: {
					description: "The entries",
					content: {
						"text/csv": { schema: z.string() },
						"application/json": { schema: z.array(AuditEntry) },
					},
				},
				...errors,
			},
		}),
		async (c) => {
			const { format, ...q } = c.req.valid("query");
			const rows = (await entries(c, q).limit(EXPORT_LIMIT)).map(
				({ cursorAt: _, ...entry }) => entry,
			);
			const stamp = new Date().toISOString().slice(0, 10);
			c.header(
				"content-disposition",
				`attachment; filename="audit-log-${stamp}.${format}"`,
			);
			if (format === "json") return c.json(rows, 200);
			const lines = [
				CSV_COLUMNS.join(","),
				...rows.map((r) => CSV_COLUMNS.map((k) => csvCell(r[k])).join(",")),
			];
			return c.text(`${lines.join("\r\n")}\r\n`, 200, {
				"content-type": "text/csv; charset=utf-8",
			});
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/audit-log/facets",
			tags: ["audit"],
			security,
			summary:
				"Distinct actions, resource types and actors, for filter pickers",
			middleware: [requirePermission("admin", inOrganization)],
			responses: {
				200: json(
					z.object({
						actions: z.array(z.string()),
						resourceTypes: z.array(z.string()),
						actors: z.array(
							z.object({
								id: z.string(),
								kind: AuditActorKind,
								name: z.string().nullable(),
							}),
						),
					}),
					"Facets",
				),
				...errors,
			},
		}),
		async (c) => {
			const { db } = c.var.deps;
			const org = eq(auditLog.organizationId, requireActor(c).organizationId);
			const [actions, resourceTypes, actors] = await Promise.all([
				db
					.selectDistinct({ v: auditLog.action })
					.from(auditLog)
					.where(org)
					.orderBy(asc(auditLog.action)),
				db
					.selectDistinct({ v: auditLog.resourceType })
					.from(auditLog)
					.where(org)
					.orderBy(asc(auditLog.resourceType)),
				db
					.selectDistinct({
						id: auditLog.actorId,
						kind: auditLog.actorKind,
						name: sql<string | null>`coalesce(${user.name}, ${apikey.name})`,
					})
					.from(auditLog)
					.leftJoin(user, eq(user.id, auditLog.actorId))
					.leftJoin(apikey, eq(apikey.id, auditLog.actorId))
					.where(org),
			]);
			return c.json(
				{
					actions: actions.map((r) => r.v),
					resourceTypes: resourceTypes.map((r) => r.v),
					actors,
				},
				200,
			);
		},
	);
