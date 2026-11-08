import { isIP } from "node:net";
import type { RouteConfig } from "@hono/zod-openapi";
import type { AuditOutcome } from "@logistack/contracts";
import type { Resource } from "@logistack/core";
import { auditLog } from "@logistack/db";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

export type AuditAction = `${string}.${string}`;

// `config` holds a whole channel config (webhook URLs carry tokens), so it goes wholesale.
const SECRET_KEY =
	/password|secret|token|credential|private|authkey|^value$|^config$/i;

/** Replaces every value under a secret-looking key with "[redacted]", at any depth. */
export function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [
				k,
				SECRET_KEY.test(k) ? "[redacted]" : redact(v),
			]),
		);
	return value;
}

function ownId(resource: Resource | undefined, type: string) {
	if (!resource || resource.type !== type) return null;
	switch (type) {
		case "organization":
			return resource.organizationId;
		case "folder":
			return resource.folderIds?.at(-1) ?? null;
		case "project":
			return resource.projectId ?? null;
		case "environment":
			return resource.environmentId ?? null;
		case "service":
			return resource.serviceId ?? null;
		default:
			return null;
	}
}

export function clientIp(c: Context<Env>): string | null {
	const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
	if (forwarded && isIP(forwarded)) return forwarded;
	try {
		const addr = c.env?.requestIP?.(c.req.raw)?.address;
		return addr && isIP(addr) ? addr : null;
	} catch {
		return null;
	}
}

async function requestInput(c: Context<Env>): Promise<unknown> {
	const valid = (c.req.valid as (t: string) => unknown)("json");
	if (valid !== undefined) return valid;
	if (!c.req.header("content-type")?.includes("json")) return undefined;
	return c.req.json().catch(() => undefined);
}

const auditHandlers = new WeakSet<object>();

function auditMiddleware(action: AuditAction): MiddlewareHandler<Env> {
	const resourceType = action.slice(0, action.indexOf("."));
	// A create's permission resource is the parent, not the new row.
	const isCreate = action.endsWith(".create");
	const mw: MiddlewareHandler<Env> = async (c, next) => {
		await next();
		// Unauthenticated requests have no organization to file the row under.
		const actor = c.get("actor");
		if (!actor) return;
		const status = c.res.status;
		const outcome: AuditOutcome =
			status === 403 ? "denied" : status >= 400 ? "error" : "success";
		const diff = c.get("auditDiff") ?? { input: await requestInput(c) };
		// shortcut: written after the mutation commits, not inside its transaction; a failed insert is logged, not retried.
		await recordAudit(c, {
			action,
			resourceId:
				c.get("auditResourceId") ??
				(isCreate ? null : ownId(c.get("resource"), resourceType)),
			diff,
			outcome,
		});
	};
	auditHandlers.add(mw);
	return mw;
}

/**
 * One audit row for the request's actor. `mutation()` calls it for every HTTP mutation;
 * long-lived sessions (a terminal's end) call it directly. Never throws.
 */
export async function recordAudit(
	c: Context<Env>,
	row: {
		action: AuditAction;
		resourceId: string | null;
		diff: unknown;
		outcome: AuditOutcome;
	},
) {
	const actor = c.get("actor");
	if (!actor) return;
	await c.var.deps.db
		.insert(auditLog)
		.values({
			organizationId: actor.organizationId,
			actorKind: actor.kind,
			actorId: actor.id,
			action: row.action,
			resourceType: row.action.slice(0, row.action.indexOf(".")),
			resourceId: row.resourceId,
			diff: redact(row.diff) ?? null,
			ip: clientIp(c),
			userAgent: c.req.header("user-agent") ?? null,
			requestId: c.get("requestId"),
			outcome: row.outcome,
		})
		.catch((error: unknown) =>
			log("error", "audit insert failed", {
				requestId: c.get("requestId"),
				action: row.action,
				error: String(error),
			}),
		);
}

/**
 * The only way to declare a mutating route: the audit middleware wraps the route's own
 * middleware (permission checks) and handler, so success, denial and failure are all recorded.
 */
export function mutation<R extends RouteConfig>(
	action: AuditAction,
	route: R,
): R {
	const own = route.middleware
		? Array.isArray(route.middleware)
			? route.middleware
			: [route.middleware]
		: [];
	return {
		// Published in the OpenAPI document; the MCP server names tools after it.
		"x-audit-action": action,
		...route,
		middleware: [auditMiddleware(action), ...own],
	};
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Boot-time guard: every mutating `/api` route outside better-auth must come from `mutation()`. */
export function assertMutationsAudited(app: Hono<Env>) {
	const audited = new Set(
		app.routes
			.filter((r) => auditHandlers.has(r.handler))
			.map((r) => `${r.method} ${r.path}`),
	);
	const missing = app.routes
		.filter(
			(r) =>
				MUTATING.has(r.method) &&
				r.path.startsWith("/api/") &&
				!r.path.startsWith("/api/auth/") &&
				!audited.has(`${r.method} ${r.path}`),
		)
		.map((r) => `${r.method} ${r.path}`);
	if (missing.length > 0)
		throw new Error(
			`mutating routes without audit: ${[...new Set(missing)].join(", ")}`,
		);
}
