import type { PermissionAction } from "@logistack/contracts";
import { can, type Resource } from "@logistack/core";
import {
	type Db,
	deployment,
	domain,
	environment,
	folder,
	project,
	service,
	stack,
} from "@logistack/db";
import { and, eq, type SQL } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { type Actor, requireActor } from "./actor.ts";
import type { Env } from "./env.ts";
import { Failure, notFound } from "./errors.ts";

export type Locatable =
	| "folder"
	| "project"
	| "environment"
	| "service"
	| "stack"
	| "deployment"
	| "domain";

export const organizationResource = (organizationId: string): Resource => ({
	type: "organization",
	organizationId,
});

async function projectChain(
	db: Db,
	organizationId: string,
	where: SQL,
	type: "project" | "environment" | "service",
): Promise<Resource> {
	const [row] = await db
		.select({
			projectId: project.id,
			folderId: project.folderId,
			parentFolderId: folder.parentId,
			environmentId: environment.id,
			serviceId: service.id,
		})
		.from(project)
		.leftJoin(folder, eq(folder.id, project.folderId))
		.leftJoin(environment, eq(environment.projectId, project.id))
		.leftJoin(service, eq(service.environmentId, environment.id))
		.where(and(eq(project.organizationId, organizationId), where))
		.limit(1);
	if (!row) throw notFound(type);
	const folderIds = [row.parentFolderId, row.folderId].filter(
		(id): id is string => id !== null,
	);
	return {
		type,
		organizationId,
		folderIds,
		projectId: row.projectId,
		...(type !== "project" && {
			environmentId: row.environmentId ?? undefined,
		}),
		...(type === "service" && { serviceId: row.serviceId ?? undefined }),
	};
}

/**
 * The full scope chain (folders, project, environment, service) of a resource in the
 * actor's organization. Rows of other organizations are reported as not found.
 */
export async function locate(
	db: Db,
	organizationId: string,
	kind: Locatable,
	id: string,
): Promise<Resource> {
	switch (kind) {
		case "folder": {
			const [row] = await db
				.select({ parentId: folder.parentId })
				.from(folder)
				.where(
					and(eq(folder.id, id), eq(folder.organizationId, organizationId)),
				);
			if (!row) throw notFound("folder");
			return {
				type: "folder",
				organizationId,
				folderIds: row.parentId ? [row.parentId, id] : [id],
			};
		}
		case "project":
			return projectChain(db, organizationId, eq(project.id, id), "project");
		case "environment":
			return projectChain(
				db,
				organizationId,
				eq(environment.id, id),
				"environment",
			);
		case "service":
			return projectChain(db, organizationId, eq(service.id, id), "service");
		case "stack": {
			// A stack is guarded as its environment: its services are what permissions name.
			const [row] = await db
				.select({ environmentId: stack.environmentId })
				.from(stack)
				.where(eq(stack.id, id));
			if (!row) throw notFound("stack");
			return locate(db, organizationId, "environment", row.environmentId).catch(
				() => {
					throw notFound("stack");
				},
			);
		}
		case "deployment":
		case "domain": {
			const table = kind === "deployment" ? deployment : domain;
			const [row] = await db
				.select({ serviceId: table.serviceId })
				.from(table)
				.where(eq(table.id, id));
			if (!row) throw notFound(kind);
			const svc = await locate(
				db,
				organizationId,
				"service",
				row.serviceId,
			).catch(() => {
				throw notFound(kind);
			});
			return { ...svc, type: kind };
		}
	}
}

/** Pure check on an already-resolved actor; a scoped API key also needs its own scopes to allow it. */
export function actorCan(
	actor: Actor,
	action: PermissionAction,
	resource: Resource,
): boolean {
	return (
		can(actor, action, resource, actor.grants) &&
		(actor.keyScopes === undefined ||
			can(actor, action, resource, actor.keyScopes))
	);
}

/** Throws 403 unless the actor may `action` on `resource`; records the resource for the audit row first. */
export function check(
	c: Context<Env>,
	action: PermissionAction,
	resource: Resource,
): Actor {
	const actor = requireActor(c);
	// The first check names the audited resource; later ones (a move's destination) do not.
	if (!c.get("resource")) c.set("resource", resource);
	if (!actorCan(actor, action, resource))
		throw new Failure(
			"forbidden",
			`missing permission '${action}' on ${resource.type}`,
		);
	return actor;
}

export type ResolveResource = (
	c: Context<Env>,
	actor: Actor,
) => Resource | Promise<Resource>;

/** Route middleware: authenticate, resolve the target's scope chain, check `action`. */
export function requirePermission(
	action: PermissionAction,
	resolve: ResolveResource,
): MiddlewareHandler<Env> {
	return async (c, next) => {
		check(c, action, await resolve(c, requireActor(c)));
		await next();
	};
}

/**
 * Throws 409 when the project this request resolved (via `requirePermission` or `check`) is
 * archived: an archived project takes no deploys and starts nothing.
 */
export async function refuseArchived(c: Context<Env>) {
	const projectId = c.get("resource")?.projectId;
	if (!projectId) throw new Error("refuseArchived needs a resolved project");
	const [row] = await c.var.deps.db
		.select({ archivedAt: project.archivedAt })
		.from(project)
		.where(eq(project.id, projectId));
	if (row?.archivedAt)
		throw new Failure(
			"conflict",
			"the project is archived; unarchive it to deploy",
		);
}

/** Resolver for the actor's own organization. */
export const inOrganization: ResolveResource = (_c, actor) =>
	organizationResource(actor.organizationId);

/** Resolver for `kind` identified by the path parameter `param` (default `id`). */
export const byParam =
	(kind: Locatable, param = "id"): ResolveResource =>
	(c, actor) =>
		locate(c.var.deps.db, actor.organizationId, kind, c.req.param(param) ?? "");
