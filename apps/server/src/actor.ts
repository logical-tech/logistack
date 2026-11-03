import { z } from "@hono/zod-openapi";
import {
	type AuditActorKind,
	type PermissionAction,
	permissionActions,
} from "@logistack/contracts";
import type { BuiltinRole, Grant, ScopeKind } from "@logistack/core";
import {
	apiKeyUsage,
	type Db,
	member,
	organizationRole,
	roleGrant,
	user,
} from "@logistack/db";
import { and, asc, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { clientIp } from "./audit.ts";
import { apiKeyFrom } from "./auth.ts";
import type { Deps, Env } from "./env.ts";
import { Failure } from "./errors.ts";
import { log } from "./log.ts";

/** Whoever is making the request, already bound to one organization. */
export type Actor = {
	kind: AuditActorKind;
	/** Subject of `grants`: the user id, or the API key id for `apikey`. */
	id: string;
	/** The human or machine user behind the credential; for `system`, the owner it acts for. */
	userId: string;
	organizationId: string;
	grants: Grant[];
	/**
	 * Set for API keys created with explicit scopes: an action is allowed only when
	 * both `grants` (the owner's) and these allow it, the intersection of the two.
	 */
	keyScopes?: Grant[];
	/** The API key used, when the credential is one. */
	keyId?: string;
};

export const scopeKinds = [
	"organization",
	"folder",
	"project",
	"environment",
	"service",
] as const satisfies readonly ScopeKind[];

export const KeyScope = z.object({
	role: z.string().min(1),
	scope: z.object({ kind: z.enum(scopeKinds), id: z.string().min(1) }),
});
export type KeyScope = z.infer<typeof KeyScope>;

/** What LogiStack stores in better-auth's `apikey.metadata`. */
export const KeyMetadata = z.object({
	organizationId: z.string(),
	/** Absent: the key carries all of its owner's grants. */
	scopes: z.array(KeyScope).optional(),
});
export type KeyMetadata = z.infer<typeof KeyMetadata>;

export const builtinRoles: Record<string, BuiltinRole> = {
	owner: "owner",
	admin: "admin",
	developer: "developer",
	viewer: "viewer",
	// better-auth's default invitation role.
	member: "viewer",
};

/** Custom roles live in better-auth's `organization_role` with `permission = {"logistack": [actions]}`. */
export async function roleFor(
	db: Db,
	organizationId: string,
	name: string,
): Promise<Grant["role"] | undefined> {
	const builtin = builtinRoles[name];
	if (builtin) return builtin;
	const [row] = await db
		.select({ permission: organizationRole.permission })
		.from(organizationRole)
		.where(
			and(
				eq(organizationRole.organizationId, organizationId),
				eq(organizationRole.role, name),
			),
		);
	if (!row) return undefined;
	return { id: name, actions: customActions(row.permission) };
}

/** The LogiStack actions declared in an `organization_role.permission` document. */
export function customActions(permission: string): PermissionAction[] {
	let declared: unknown;
	try {
		declared = JSON.parse(permission)?.logistack;
	} catch {
		return [];
	}
	return Array.isArray(declared)
		? permissionActions.filter((a: PermissionAction) => declared.includes(a))
		: [];
}

async function toGrants(
	db: Db,
	organizationId: string,
	subjectId: string,
	bindings: readonly KeyScope[],
): Promise<Grant[]> {
	const grants: Grant[] = [];
	for (const b of bindings) {
		const role = await roleFor(db, organizationId, b.role);
		if (role) grants.push({ subjectId, scope: b.scope, role });
	}
	return grants;
}

/**
 * The membership role (organization-wide) plus every `role_grant` row of the user in
 * this organization. Undefined when the user is not a member.
 */
export async function grantsFor(
	db: Db,
	subjectId: string,
	userId: string,
	organizationId: string,
): Promise<Grant[] | undefined> {
	const [m] = await db
		.select({ role: member.role })
		.from(member)
		.where(
			and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
		);
	if (!m) return undefined;
	const scoped = await db
		.select({
			role: roleGrant.role,
			kind: roleGrant.scopeKind,
			id: roleGrant.scopeId,
		})
		.from(roleGrant)
		.where(
			and(
				eq(roleGrant.userId, userId),
				eq(roleGrant.organizationId, organizationId),
			),
		);
	return toGrants(db, organizationId, subjectId, [
		...m.role.split(",").map((name) => ({
			role: name.trim(),
			scope: { kind: "organization" as const, id: organizationId },
		})),
		...scoped.map((g) => ({ role: g.role, scope: { kind: g.kind, id: g.id } })),
	]);
}

async function firstOrganization(db: Db, userId: string) {
	const [m] = await db
		.select({ organizationId: member.organizationId })
		.from(member)
		.where(eq(member.userId, userId))
		.orderBy(asc(member.createdAt))
		.limit(1);
	return m?.organizationId;
}

/** Parses `apikey.metadata`, which better-auth hands back as an object or a JSON string. */
export function keyMetadata(raw: unknown): KeyMetadata | undefined {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	const parsed = KeyMetadata.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** Session cookie or API key to an Actor; undefined when neither authenticates. */
export async function resolveActor(
	{ auth, db }: Pick<Deps, "auth" | "db">,
	headers: Headers,
	ip: string | null = null,
): Promise<Actor | undefined> {
	const key = apiKeyFrom(headers);
	if (key) {
		const res = await auth.api.verifyApiKey({ body: { key } });
		if (!res.valid || !res.key) return undefined;
		const meta = keyMetadata(res.key.metadata);
		if (!meta) return undefined;
		const { organizationId } = meta;
		const userId = res.key.referenceId;
		const [u] = await db
			.select({ kind: user.kind })
			.from(user)
			.where(eq(user.id, userId));
		if (!u) return undefined;
		const keyId = res.key.id;
		await db
			.insert(apiKeyUsage)
			.values({ keyId, lastIp: ip, lastUsedAt: new Date() })
			.onConflictDoUpdate({
				target: apiKeyUsage.keyId,
				set: { lastIp: ip, lastUsedAt: new Date() },
			})
			.catch((error: unknown) =>
				log("error", "api key usage update failed", { error: String(error) }),
			);
		const kind = u.kind === "machine" ? "machine" : "apikey";
		const id = kind === "machine" ? userId : keyId;
		const grants = await grantsFor(db, id, userId, organizationId);
		if (!grants) return undefined;
		const keyScopes = meta.scopes
			? await toGrants(db, organizationId, id, meta.scopes)
			: undefined;
		return { kind, id, userId, organizationId, grants, keyScopes, keyId };
	}
	const session = await auth.api.getSession({ headers });
	if (!session) return undefined;
	const userId = session.user.id;
	const organizationId =
		session.session.activeOrganizationId ??
		(await firstOrganization(db, userId));
	if (!organizationId) return undefined;
	const grants = await grantsFor(db, userId, userId, organizationId);
	return grants && { kind: "user", id: userId, userId, organizationId, grants };
}

/**
 * An in-process job (`id` names it, e.g. `import-dokploy`) acting with the organization
 * owner's grants, never more. Undefined when the organization has no owner.
 */
export async function systemActor(
	db: Db,
	organizationId: string,
	id: string,
): Promise<Actor | undefined> {
	const members = await db
		.select({ userId: member.userId, role: member.role })
		.from(member)
		.where(eq(member.organizationId, organizationId))
		.orderBy(asc(member.createdAt));
	const owner = members.find((m) =>
		m.role.split(",").some((r) => r.trim() === "owner"),
	);
	if (!owner) return undefined;
	const grants = await grantsFor(db, id, owner.userId, organizationId);
	return (
		grants && {
			kind: "system",
			id,
			userId: owner.userId,
			organizationId,
			grants,
		}
	);
}

/** Resolves the actor once per request; routes that need one call `requireActor`. */
export const authenticate: MiddlewareHandler<Env> = async (c, next) => {
	c.set(
		"actor",
		await resolveActor(c.var.deps, c.req.raw.headers, clientIp(c)),
	);
	await next();
};

export function requireActor(c: { get(key: "actor"): Actor | undefined }) {
	const actor = c.get("actor");
	if (!actor) throw new Failure("unauthorized", "authentication required");
	return actor;
}
