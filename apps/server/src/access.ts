import { type PermissionAction, permissionActions } from "@logistack/contracts";
import {
	type BuiltinRole,
	can,
	type Grant,
	type Resource,
	type Scope,
} from "@logistack/core";
import {
	environment,
	folder,
	member,
	organizationRole,
	project,
	service,
} from "@logistack/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { type Actor, requireActor, roleFor } from "./actor.ts";
import type { Env } from "./env.ts";
import { Failure, notFound } from "./errors.ts";
import { actorCan, locate, organizationResource } from "./scope.ts";

/** Shared rules for members, grants, roles and keys. */

export const builtinRoleNames: BuiltinRole[] = [
	"owner",
	"admin",
	"developer",
	"viewer",
	"manager",
	"guest",
];

/** The guest role only makes sense on one project: refuse it on wider scopes. */
export function assertGuestScope(role: string, scopeKind: Scope["kind"]) {
	if (role === "guest" && scopeKind !== "project")
		throw new Failure(
			"bad_request",
			"the guest role can only be granted on a project",
		);
}

/** Actions a role allows below the organization, asked of `can` itself. */
export const actionsOf = (role: Grant["role"]): PermissionAction[] =>
	permissionActions.filter((a) =>
		can({ id: "_" }, a, { type: "project", organizationId: "_" }, [
			{ subjectId: "_", scope: { kind: "organization", id: "_" }, role },
		]),
	);

/** Owner-only (deleting the organization) is the action that tells owners apart, keys' scopes included. */
export const isOwner = (actor: Actor) =>
	actorCan(actor, "delete", organizationResource(actor.organizationId));

export async function resolveRole(
	c: Context<Env>,
	name: string,
): Promise<Grant["role"]> {
	const role = await roleFor(
		c.var.deps.db,
		requireActor(c).organizationId,
		name,
	);
	if (!role || name === "member")
		throw new Failure("bad_request", `unknown role '${name}'`);
	return role;
}

/** The resource a grant's scope names, checked to exist in the actor's organization. */
export async function scopeResource(
	c: Context<Env>,
	scope: Scope,
): Promise<Resource> {
	const orgId = requireActor(c).organizationId;
	if (scope.kind === "organization") {
		if (scope.id !== orgId) throw notFound("organization");
		return organizationResource(orgId);
	}
	return locate(c.var.deps.db, orgId, scope.kind, scope.id);
}

/** A human-readable name for a grant's scope: "Clients", "Shop · production". */
export async function scopeLabel(
	c: Context<Env>,
	scope: Scope,
): Promise<string> {
	const { db } = c.var.deps;
	switch (scope.kind) {
		case "organization":
			return "Organization";
		case "folder": {
			const [r] = await db
				.select({ name: folder.name })
				.from(folder)
				.where(eq(folder.id, scope.id));
			return r?.name ?? "Deleted folder";
		}
		case "project": {
			const [r] = await db
				.select({ name: project.name })
				.from(project)
				.where(eq(project.id, scope.id));
			return r?.name ?? "Deleted project";
		}
		case "environment": {
			const [r] = await db
				.select({ p: project.name, e: environment.name })
				.from(environment)
				.innerJoin(project, eq(project.id, environment.projectId))
				.where(eq(environment.id, scope.id));
			return r ? `${r.p} · ${r.e}` : "Deleted environment";
		}
		case "service": {
			const [r] = await db
				.select({ p: project.name, e: environment.name, s: service.name })
				.from(service)
				.innerJoin(environment, eq(environment.id, service.environmentId))
				.innerJoin(project, eq(project.id, environment.projectId))
				.where(eq(service.id, scope.id));
			return r ? `${r.p} · ${r.e} · ${r.s}` : "Deleted service";
		}
	}
}

/** Only owners hand out or take away ownership, and the last owner stays. */
export async function assertOwnershipChange(
	c: Context<Env>,
	from: string | undefined,
	to: string | undefined,
) {
	const actor = requireActor(c);
	if (from !== "owner" && to !== "owner") return;
	if (!isOwner(actor))
		throw new Failure("forbidden", "only an owner can change ownership");
	if (from === "owner" && to !== "owner") {
		const owners = await c.var.deps.db.$count(
			member,
			and(
				eq(member.organizationId, actor.organizationId),
				eq(member.role, "owner"),
			),
		);
		if (owners <= 1)
			throw new Failure("conflict", "the last owner cannot be removed");
	}
}

export async function customRoleRow(c: Context<Env>, name: string) {
	const [row] = await c.var.deps.db
		.select()
		.from(organizationRole)
		.where(
			and(
				eq(organizationRole.organizationId, requireActor(c).organizationId),
				eq(organizationRole.role, name),
			),
		);
	if (!row) throw notFound("role");
	return row;
}
