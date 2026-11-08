import { createRoute, z } from "@hono/zod-openapi";
import { type PermissionAction, permissionActions } from "@logistack/contracts";
import { can, type Resource } from "@logistack/core";
import { apiKeyUsage, apikey, member, user } from "@logistack/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
	assertOwnershipChange,
	resolveRole,
	scopeLabel,
	scopeResource,
} from "../access.ts";
import {
	type Actor,
	grantsFor,
	KeyScope,
	keyMetadata,
	requireActor,
} from "../actor.ts";
import { auditInTx, mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import {
	actorCan,
	check,
	inOrganization,
	organizationResource,
	requirePermission,
} from "../scope.ts";

const Owner = z.object({
	id: z.string(),
	name: z.string(),
	kind: z.enum(["human", "machine"]),
});

const LabelledScope = KeyScope.extend({ scopeLabel: z.string() });

const ApiKey = z
	.object({
		id: z.string(),
		name: z.string().nullable(),
		start: z.string().nullable(),
		enabled: z.boolean().nullable(),
		expiresAt: z.string().nullable(),
		createdAt: z.string(),
		lastUsedAt: z.string().nullable(),
		lastIp: z.string().nullable(),
		owner: Owner,
		/** null: the key carries all of its owner's grants. */
		scopes: z.array(LabelledScope).nullable(),
	})
	.openapi("ApiKey");

const CreatedKey = ApiKey.extend({
	/** `lsk_...`, returned only here. */
	key: z.string(),
}).openapi("CreatedApiKey");

const ServiceAccount = z
	.object({
		id: z.string(),
		name: z.string(),
		role: z.string(),
		keyCount: z.int(),
		createdAt: z.string(),
	})
	.openapi("ServiceAccount");

const isAdmin = (actor: Actor) =>
	actorCan(actor, "admin", organizationResource(actor.organizationId));

async function serviceAccountIds(c: Context<Env>) {
	const rows = await c.var.deps.db
		.select({ id: user.id })
		.from(user)
		.innerJoin(member, eq(member.userId, user.id))
		.where(
			and(
				eq(member.organizationId, requireActor(c).organizationId),
				eq(user.kind, "machine"),
			),
		);
	return rows.map((r) => r.id);
}

/** Keys the actor may see and manage: their own, plus service accounts' for admins. */
async function manageableOwners(c: Context<Env>) {
	const actor = requireActor(c);
	return [actor.userId, ...(isAdmin(actor) ? await serviceAccountIds(c) : [])];
}

async function listKeys(c: Context<Env>, ids?: string[]) {
	const actor = requireActor(c);
	const rows = await c.var.deps.db
		.select({
			id: apikey.id,
			name: apikey.name,
			start: apikey.start,
			enabled: apikey.enabled,
			expiresAt: apikey.expiresAt,
			createdAt: apikey.createdAt,
			metadata: apikey.metadata,
			lastUsedAt: apiKeyUsage.lastUsedAt,
			lastIp: sql<string | null>`host(${apiKeyUsage.lastIp})`,
			owner: { id: user.id, name: user.name, kind: user.kind },
		})
		.from(apikey)
		.innerJoin(user, eq(user.id, apikey.referenceId))
		.leftJoin(apiKeyUsage, eq(apiKeyUsage.keyId, apikey.id))
		.where(
			and(
				inArray(apikey.referenceId, await manageableOwners(c)),
				sql`${apikey.metadata}::jsonb->>'organizationId' = ${actor.organizationId}`,
				ids ? inArray(apikey.id, ids) : undefined,
			),
		)
		.orderBy(desc(apikey.createdAt));
	return Promise.all(
		rows.map(async ({ metadata, ...k }) => {
			const scopes = keyMetadata(metadata)?.scopes;
			return {
				...k,
				expiresAt: k.expiresAt?.toISOString() ?? null,
				createdAt: k.createdAt.toISOString(),
				lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
				scopes: scopes
					? await Promise.all(
							scopes.map(async (s) => ({
								...s,
								scopeLabel: await scopeLabel(c, s.scope),
							})),
						)
					: null,
			};
		}),
	);
}

async function keyOf(c: Context<Env>, id: string) {
	const [k] = await listKeys(c, [id]);
	if (!k) throw notFound("api key");
	return k;
}

/**
 * Every requested scope must stay within what the owner may do there: a key can
 * narrow its owner's access, never widen it. Runtime enforcement intersects anyway.
 */
async function assertWithinOwner(
	c: Context<Env>,
	ownerId: string,
	scopes: KeyScope[],
) {
	const actor = requireActor(c);
	// A service account's own grants; for the caller, the actor (whose key may itself be scoped).
	const grants =
		ownerId === actor.userId
			? null
			: ((await grantsFor(
					c.var.deps.db,
					ownerId,
					ownerId,
					actor.organizationId,
				)) ?? []);
	const ownerCan = (a: PermissionAction, r: Resource) =>
		grants ? can({ id: ownerId }, a, r, grants) : actorCan(actor, a, r);
	for (const s of scopes) {
		const resource = await scopeResource(c, s.scope);
		const role = await resolveRole(c, s.role);
		const grant = [{ subjectId: "_", scope: s.scope, role }];
		const exceeding = permissionActions.filter(
			(a) => can({ id: "_" }, a, resource, grant) && !ownerCan(a, resource),
		);
		if (exceeding.length > 0)
			throw new Failure(
				"forbidden",
				`the key's owner lacks ${exceeding.join(", ")} on that ${s.scope.kind}`,
				{ scope: s.scope, role: s.role, missing: exceeding },
			);
	}
}

/** The key's owner: the caller, or one of the organization's service accounts (admins only). */
async function ownerFor(c: Context<Env>, ownerId: string | undefined) {
	const actor = requireActor(c);
	if (!ownerId || ownerId === actor.userId) return actor.userId;
	check(c, "admin", organizationResource(actor.organizationId));
	if (!(await serviceAccountIds(c)).includes(ownerId))
		throw notFound("service account");
	return ownerId;
}

async function createKey(
	c: Context<Env>,
	input: {
		name: string;
		ownerId: string;
		scopes: KeyScope[] | undefined;
		expiresIn: number | null;
	},
) {
	const actor = requireActor(c);
	const created = await c.var.deps.auth.api.createApiKey({
		body: {
			userId: input.ownerId,
			name: input.name,
			expiresIn: input.expiresIn,
			metadata: {
				organizationId: actor.organizationId,
				...(input.scopes && { scopes: input.scopes }),
			},
		},
	});
	c.set("auditResourceId", created.id);
	return { ...(await keyOf(c, created.id)), key: created.key };
}

async function revoke(c: Context<Env>, id: string, ownerId: string) {
	await c.var.deps.auth.api.updateApiKey({
		body: { keyId: id, userId: ownerId, enabled: false },
	});
}

const ServiceAccountInput = z.object({
	name: z.string().trim().min(1).max(64),
	role: z.string().min(1).default("viewer"),
});

export const apiKeys = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/api-keys",
			tags: ["api-keys"],
			security,
			summary:
				"Your API keys, and service accounts' keys when you are an admin",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(ApiKey), "Keys"), ...errors },
		}),
		async (c) => c.json(await listKeys(c), 200),
	)
	.openapi(
		mutation(
			"api_key.create",
			createRoute({
				method: "post",
				path: "/api-keys",
				tags: ["api-keys"],
				security,
				summary: "Create an API key for you or a service account",
				description:
					"The `key` (`lsk_...`) is returned only once. `scopes` narrows the key to a subset of its owner's grants; without it the key carries all of them. A scoped key may do an action only where both its owner and its scopes allow it.",
				middleware: [requirePermission("read", inOrganization)],
				request: body(
					z.object({
						name: z.string().trim().min(1).max(32),
						ownerId: z.string().optional(),
						scopes: z.array(KeyScope).min(1).max(20).optional(),
						expiresInDays: z.int().min(1).max(365).optional(),
					}),
				),
				responses: { 201: json(CreatedKey, "Created"), ...errors },
			}),
		),
		async (c) => {
			const actor = requireActor(c);
			const input = c.req.valid("json");
			const ownerId = await ownerFor(c, input.ownerId);
			// A scoped key minting a key for itself passes its own limits on.
			const inherited =
				ownerId === actor.userId
					? actor.keyScopes?.map((g) => ({
							role: typeof g.role === "string" ? g.role : g.role.id,
							scope: g.scope,
						}))
					: undefined;
			const scopes = input.scopes ?? inherited;
			if (scopes) await assertWithinOwner(c, ownerId, scopes);
			if (input.scopes && inherited)
				await assertWithinOwner(c, ownerId, inherited);
			return c.json(
				await createKey(c, {
					name: input.name,
					ownerId,
					scopes,
					expiresIn: input.expiresInDays ? input.expiresInDays * 86_400 : null,
				}),
				201,
			);
		},
	)
	.openapi(
		mutation(
			"api_key.rotate",
			createRoute({
				method: "post",
				path: "/api-keys/{id}/rotate",
				tags: ["api-keys"],
				security,
				summary:
					"Replace a key with a new secret, same owner, scopes and lifetime",
				description:
					"The old key stops working immediately. The new `key` is returned only once.",
				middleware: [requirePermission("read", inOrganization)],
				request: { params: IdParam },
				responses: { 201: json(CreatedKey, "Rotated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const old = await keyOf(c, id);
			if (!old.enabled) throw new Failure("conflict", "the key is revoked");
			const lifetime =
				old.expiresAt &&
				Math.max(
					86_400,
					Math.round(
						(Date.parse(old.expiresAt) - Date.parse(old.createdAt)) / 1000,
					),
				);
			const created = await createKey(c, {
				name: old.name ?? "rotated",
				ownerId: old.owner.id,
				scopes: old.scopes?.map(({ role, scope }) => ({ role, scope })),
				expiresIn: lifetime || null,
			});
			await revoke(c, id, old.owner.id);
			c.set("auditDiff", {
				before: { keyId: id },
				after: { keyId: created.id },
			});
			return c.json(created, 201);
		},
	)
	.openapi(
		mutation(
			"api_key.delete",
			createRoute({
				method: "delete",
				path: "/api-keys/{id}",
				tags: ["api-keys"],
				security,
				summary: "Revoke an API key",
				middleware: [requirePermission("read", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Revoked" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			const key = await keyOf(c, id);
			await revoke(c, id, key.owner.id);
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/service-accounts",
			tags: ["api-keys"],
			security,
			summary: "Machine users that own API keys",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.array(ServiceAccount), "Service accounts"),
				...errors,
			},
		}),
		async (c) => {
			const orgId = requireActor(c).organizationId;
			const rows = await c.var.deps.db
				.select({
					id: user.id,
					name: user.name,
					role: member.role,
					createdAt: user.createdAt,
					keyCount: sql<number>`(select count(*)::int from ${apikey} where ${apikey.referenceId} = ${user.id} and ${apikey.enabled})`,
				})
				.from(user)
				.innerJoin(member, eq(member.userId, user.id))
				.where(and(eq(member.organizationId, orgId), eq(user.kind, "machine")))
				.orderBy(user.createdAt);
			return c.json(
				rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"service_account.create",
			createRoute({
				method: "post",
				path: "/service-accounts",
				tags: ["api-keys"],
				security,
				summary:
					"Create a service account (a machine user) in the organization",
				description:
					"`role` is its organization-wide role; add scoped grants with `POST /grants` and keys with `POST /api-keys`.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(ServiceAccountInput),
				responses: { 201: json(ServiceAccount, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const orgId = requireActor(c).organizationId;
			await resolveRole(c, input.role);
			await assertOwnershipChange(c, undefined, input.role);
			const id = crypto.randomUUID();
			const now = new Date();
			await c.var.deps.db.transaction(async (tx) => {
				await tx.insert(user).values({
					id,
					name: input.name,
					// Machines never sign in; the address only satisfies better-auth's unique email.
					email: `${id}@service-accounts.invalid`,
					kind: "machine",
				});
				await tx.insert(member).values({
					id: crypto.randomUUID(),
					organizationId: orgId,
					userId: id,
					role: input.role,
					createdAt: now,
				});
				await auditInTx(c, tx, { resourceId: id });
			});
			return c.json(
				{
					id,
					name: input.name,
					role: input.role,
					keyCount: 0,
					createdAt: now.toISOString(),
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"service_account.update",
			createRoute({
				method: "patch",
				path: "/service-accounts/{id}",
				tags: ["api-keys"],
				security,
				summary:
					"Rename a service account or change its organization-wide role",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam, ...body(ServiceAccountInput.partial()) },
				responses: {
					200: json(z.object({ id: z.string() }), "Updated"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			c.set("auditResourceId", id);
			if (!(await serviceAccountIds(c)).includes(id))
				throw notFound("service account");
			const orgId = requireActor(c).organizationId;
			if (input.role) {
				await resolveRole(c, input.role);
				const [m] = await db
					.select({ role: member.role })
					.from(member)
					.where(and(eq(member.userId, id), eq(member.organizationId, orgId)));
				await assertOwnershipChange(c, m?.role, input.role);
			}
			await db.transaction(async (tx) => {
				if (input.role)
					await tx
						.update(member)
						.set({ role: input.role })
						.where(
							and(eq(member.userId, id), eq(member.organizationId, orgId)),
						);
				if (input.name)
					await tx
						.update(user)
						.set({ name: input.name })
						.where(eq(user.id, id));
				await auditInTx(c, tx);
			});
			return c.json({ id }, 200);
		},
	)
	.openapi(
		mutation(
			"service_account.delete",
			createRoute({
				method: "delete",
				path: "/service-accounts/{id}",
				tags: ["api-keys"],
				security,
				summary: "Delete a service account and every key it owns",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			if (!(await serviceAccountIds(c)).includes(id))
				throw notFound("service account");
			await c.var.deps.db.transaction(async (tx) => {
				const keys = await tx
					.select({ id: apikey.id })
					.from(apikey)
					.where(eq(apikey.referenceId, id));
				if (keys.length > 0) {
					await tx.delete(apiKeyUsage).where(
						inArray(
							apiKeyUsage.keyId,
							keys.map((k) => k.id),
						),
					);
					await tx.delete(apikey).where(eq(apikey.referenceId, id));
				}
				// Membership, grants and sessions cascade with the user.
				await tx
					.delete(user)
					.where(and(eq(user.id, id), eq(user.kind, "machine")));
				await auditInTx(c, tx);
			});
			return c.body(null, 204);
		},
	);
