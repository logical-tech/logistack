import { createRoute, z } from "@hono/zod-openapi";
import { EnvVar, EnvVarInput, EnvVarScope } from "@logistack/contracts";
import { decrypt, encrypt, type Resource } from "@logistack/core";
import { type Db, envVar } from "@logistack/db";
import { and, asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Actor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { notFound, one, parseInput, rejectReservedEnvKeys } from "../errors.ts";
import {
	body,
	errors,
	IdParam,
	json,
	patchOf,
	reservedEnvKey,
	router,
	security,
} from "../openapi.ts";
import {
	actorCan,
	locate,
	organizationResource,
	type ResolveResource,
	requirePermission,
} from "../scope.ts";

const ScopeRef = z.object({ scope: EnvVarScope, scopeId: z.string() });

async function scopeResource(
	db: Db,
	actor: Actor,
	{ scope, scopeId }: z.infer<typeof ScopeRef>,
): Promise<Resource> {
	if (scope !== "organization")
		return locate(db, actor.organizationId, scope, scopeId);
	if (scopeId !== actor.organizationId) throw notFound("organization");
	return organizationResource(scopeId);
}

const fromQuery: ResolveResource = (c, actor) =>
	scopeResource(c.var.deps.db, actor, parseInput(ScopeRef, c.req.query()));

const fromBody: ResolveResource = async (c, actor) =>
	scopeResource(
		c.var.deps.db,
		actor,
		parseInput(ScopeRef, await c.req.json().catch(() => undefined)),
	);

const fromRow: ResolveResource = async (c, actor) => {
	const { db } = c.var.deps;
	const [row] = await db
		.select({ scope: envVar.scope, scopeId: envVar.scopeId })
		.from(envVar)
		.where(eq(envVar.id, c.req.param("id") ?? ""));
	if (!row) throw notFound("env var");
	return scopeResource(db, actor, row);
};

/** Secret values are masked (null) unless the actor holds `read:secrets` on the scope. */
async function present(c: Context<Env>, row: typeof envVar.$inferSelect) {
	const actor = c.get("actor") as Actor;
	const resource = c.get("resource") as Resource;
	const reveal = !row.isSecret || actorCan(actor, "read:secrets", resource);
	const { valueEncrypted, ...rest } = row;
	return {
		...rest,
		value: reveal ? await decrypt(c.var.deps.masterKey, valueEncrypted) : null,
	};
}

const tags = ["env-vars"];

export const envVars = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/env-vars",
			tags,
			security,
			summary: "Variables defined at one scope",
			middleware: [requirePermission("read", fromQuery)],
			request: { query: ScopeRef },
			responses: { 200: json(z.array(EnvVar), "Variables"), ...errors },
		}),
		async (c) => {
			const { scope, scopeId } = c.req.valid("query");
			const rows = await c.var.deps.db
				.select()
				.from(envVar)
				.where(and(eq(envVar.scope, scope), eq(envVar.scopeId, scopeId)))
				.orderBy(asc(envVar.key));
			return c.json(await Promise.all(rows.map((r) => present(c, r))), 200);
		},
	)
	.openapi(
		mutation(
			"env_var.create",
			createRoute({
				method: "post",
				path: "/env-vars",
				tags,
				security,
				middleware: [requirePermission("write", fromBody)],
				request: body(ScopeRef.extend(EnvVarInput.shape)),
				responses: {
					201: json(EnvVar, "Created"),
					...errors,
					...reservedEnvKey,
				},
			}),
		),
		async (c) => {
			const { value, ...input } = c.req.valid("json");
			rejectReservedEnvKeys([input.key]);
			const row = one(
				await c.var.deps.db
					.insert(envVar)
					.values({
						...input,
						valueEncrypted: await encrypt(c.var.deps.masterKey, value),
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			return c.json(await present(c, row), 201);
		},
	)
	.openapi(
		mutation(
			"env_var.update",
			createRoute({
				method: "patch",
				path: "/env-vars/{id}",
				tags,
				security,
				middleware: [requirePermission("write", fromRow)],
				request: {
					params: IdParam,
					...body(patchOf(EnvVarInput.omit({ key: true }))),
				},
				responses: { 200: json(EnvVar, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { value, ...input } = c.req.valid("json");
			const row = one(
				await c.var.deps.db
					.update(envVar)
					.set({
						...input,
						...(value !== undefined && {
							valueEncrypted: await encrypt(c.var.deps.masterKey, value),
						}),
					})
					.where(eq(envVar.id, id))
					.returning(),
			);
			c.set("auditResourceId", id);
			return c.json(await present(c, row), 200);
		},
	)
	.openapi(
		mutation(
			"env_var.delete",
			createRoute({
				method: "delete",
				path: "/env-vars/{id}",
				tags,
				security,
				middleware: [requirePermission("write", fromRow)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			await c.var.deps.db.delete(envVar).where(eq(envVar.id, id));
			c.set("auditResourceId", id);
			return c.body(null, 204);
		},
	);
