import { createRoute, z } from "@hono/zod-openapi";
import {
	AvailableSecret,
	Secret,
	SecretInput,
	SecretReveal,
	SecretScope,
	SecretUpdate,
	SecretUsage,
	SecretVersion,
} from "@logistack/contracts";
import {
	markShadowed,
	type Resource,
	secretChain,
	secretScopeRank,
} from "@logistack/core";
import {
	type Db,
	environment,
	envVar,
	folder,
	project,
	secret,
	secretProvider,
	secretVersion,
	service,
} from "@logistack/db";
import { referenceOf } from "@logistack/worker/external-secrets";
import {
	createSecret,
	readSecretValue,
	rotateDataKey,
	setSecretValue,
} from "@logistack/worker/secrets";
import { and, asc, count, desc, eq, inArray, or } from "drizzle-orm";
import type { Context } from "hono";
import type { Actor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import {
	Failure,
	notFound,
	one,
	parseInput,
	rejectReservedEnvKeys,
} from "../errors.ts";
import {
	body,
	errors,
	IdParam,
	json,
	reservedEnvKey,
	router,
	security,
} from "../openapi.ts";
import {
	actorCan,
	inOrganization,
	locate,
	organizationResource,
	type ResolveResource,
	requirePermission,
} from "../scope.ts";
import { externalColumns } from "../secret-refs.ts";

const ScopeRef = z.object({ scope: SecretScope, scopeId: z.string() });
type ScopeRef = z.infer<typeof ScopeRef>;

export async function secretScopeResource(
	db: Db,
	actor: Actor,
	{ scope, scopeId }: ScopeRef,
): Promise<Resource> {
	if (scope !== "organization")
		return locate(db, actor.organizationId, scope, scopeId);
	if (scopeId !== actor.organizationId) throw notFound("organization");
	return organizationResource(scopeId);
}

/** The resource of one link in `r`'s chain, for permission checks on secrets defined there. */
export function chainResource(
	r: Resource,
	scope: z.infer<typeof SecretScope>,
	scopeId: string,
): Resource {
	const org = organizationResource(r.organizationId);
	switch (scope) {
		case "organization":
			return org;
		case "folder": {
			const i = (r.folderIds ?? []).indexOf(scopeId);
			return {
				...org,
				type: "folder",
				folderIds: (r.folderIds ?? []).slice(0, i + 1),
			};
		}
		case "project":
			return {
				...org,
				type: "project",
				folderIds: r.folderIds,
				projectId: scopeId,
			};
		case "environment":
			return { ...r, type: "environment", serviceId: undefined };
		case "service":
			return r;
	}
}

const fromQuery: ResolveResource = (c, actor) =>
	secretScopeResource(
		c.var.deps.db,
		actor,
		parseInput(ScopeRef, c.req.query()),
	);

const fromBody: ResolveResource = async (c, actor) =>
	secretScopeResource(
		c.var.deps.db,
		actor,
		parseInput(ScopeRef, await c.req.json().catch(() => undefined)),
	);

async function loadRow(c: Context<Env>, actor: Actor) {
	const [row] = await c.var.deps.db
		.select()
		.from(secret)
		.where(
			and(
				eq(secret.id, c.req.param("id") ?? ""),
				eq(secret.organizationId, actor.organizationId),
			),
		);
	if (!row) throw notFound("secret");
	return row;
}

const fromRow: ResolveResource = async (c, actor) => {
	const row = await loadRow(c, actor);
	// Before the permission check, so a denied reveal is filed under the secret too.
	c.set("auditResourceId", row.id);
	return secretScopeResource(c.var.deps.db, actor, row);
};

const secretsCtx = (c: Context<Env>) => ({
	db: c.var.deps.db,
	masterKey: c.var.deps.masterKey,
	secretsKek: c.var.deps.secretsKek,
});

async function usageCounts(db: Db, ids: string[]) {
	if (!ids.length) return new Map<string, number>();
	const rows = await db
		.select({ id: envVar.secretId, n: count() })
		.from(envVar)
		.where(inArray(envVar.secretId, ids))
		.groupBy(envVar.secretId);
	return new Map(rows.map((r) => [r.id ?? "", r.n]));
}

async function present(db: Db, rows: (typeof secret.$inferSelect)[]) {
	const used = await usageCounts(
		db,
		rows.map((r) => r.id),
	);
	const providerIds = [
		...new Set(rows.flatMap((r) => (r.providerId ? [r.providerId] : []))),
	];
	const providers = new Map(
		(providerIds.length
			? await db
					.select({
						id: secretProvider.id,
						name: secretProvider.name,
						kind: secretProvider.kind,
					})
					.from(secretProvider)
					.where(inArray(secretProvider.id, providerIds))
			: []
		).map((p) => [p.id, p]),
	);
	const external = (r: typeof secret.$inferSelect) => {
		const p = r.providerId ? providers.get(r.providerId) : undefined;
		return p
			? {
					providerId: p.id,
					providerName: p.name,
					kind: p.kind,
					reference: referenceOf(p.name, r.externalRef ?? ""),
					checkedAt: r.externalCheckedAt,
					error: r.externalError,
				}
			: null;
	};
	return rows.map((r) => ({
		id: r.id,
		scope: r.scope,
		scopeId: r.scopeId,
		key: r.key,
		description: r.description,
		version: r.currentVersion,
		usedBy: used.get(r.id) ?? 0,
		external: external(r),
		updatedBy: r.updatedBy,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	}));
}

/** Display names of the folders, project, environment and service in a chain. */
async function chainNames(db: Db, r: Resource) {
	const names = new Map<string, string>();
	const [folders, projects, envs, services] = await Promise.all([
		r.folderIds?.length
			? db
					.select({ id: folder.id, name: folder.name })
					.from(folder)
					.where(inArray(folder.id, [...r.folderIds]))
			: [],
		r.projectId
			? db
					.select({ id: project.id, name: project.name })
					.from(project)
					.where(eq(project.id, r.projectId))
			: [],
		r.environmentId
			? db
					.select({ id: environment.id, name: environment.name })
					.from(environment)
					.where(eq(environment.id, r.environmentId))
			: [],
		r.serviceId
			? db
					.select({ id: service.id, name: service.name })
					.from(service)
					.where(eq(service.id, r.serviceId))
			: [],
	]);
	for (const x of [...folders, ...projects, ...envs, ...services])
		names.set(x.id, x.name);
	return names;
}

/** Every secret visible from `r` that the actor may read, with names and shadowing. */
export async function availableSecrets(db: Db, actor: Actor, r: Resource) {
	const chain = secretChain(r).filter(([scope, id]) =>
		actorCan(actor, "read", chainResource(r, scope, id)),
	);
	if (!chain.length) return [];
	const rows = await db
		.select()
		.from(secret)
		.where(
			and(
				eq(secret.organizationId, r.organizationId),
				or(
					...chain.map(([scope, id]) =>
						and(eq(secret.scope, scope), eq(secret.scopeId, id)),
					),
				),
			),
		);
	const names = await chainNames(db, r);
	const full = secretChain(r);
	return markShadowed(await present(db, rows), full)
		.map((s) => ({ ...s, scopeName: names.get(s.scopeId) ?? "" }))
		.sort(
			(a, b) =>
				a.key.localeCompare(b.key) ||
				secretScopeRank(b.scope) - secretScopeRank(a.scope),
		);
}

/** Values of external secrets are never read through the API: they live in the provider. */
function externalOnly(row: typeof secret.$inferSelect): never {
	throw new Failure(
		"bad_request",
		`${row.key} is read from an external provider at deploy time; change its value there`,
	);
}

const tags = ["secrets"];
const noStore = { "Cache-Control": "no-store" };

export const secrets = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/secrets",
			tags,
			security,
			summary: "Secrets defined at one scope",
			description:
				"Metadata only. Values are returned by `POST /secrets/{id}/reveal`.",
			middleware: [requirePermission("read", fromQuery)],
			request: { query: ScopeRef },
			responses: { 200: json(z.array(Secret), "Secrets"), ...errors },
		}),
		async (c) => {
			const { scope, scopeId } = c.req.valid("query");
			const { db } = c.var.deps;
			const rows = await db
				.select()
				.from(secret)
				.where(and(eq(secret.scope, scope), eq(secret.scopeId, scopeId)))
				.orderBy(asc(secret.key));
			return c.json(await present(db, rows), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/secrets/available",
			tags,
			security,
			summary: "Secrets a service can reference",
			description:
				"Every secret defined on the service's chain (organization, folders, project, environment, service) in a scope the caller can read. `shadowed` marks a key a more specific scope redefines.",
			middleware: [
				requirePermission("read", (c, actor) =>
					locate(
						c.var.deps.db,
						actor.organizationId,
						"service",
						c.req.query("serviceId") ?? "",
					),
				),
			],
			request: { query: z.object({ serviceId: z.string() }) },
			responses: { 200: json(z.array(AvailableSecret), "Secrets"), ...errors },
		}),
		async (c) => {
			const actor = c.get("actor") as Actor;
			const resource = c.get("resource") as Resource;
			return c.json(
				await availableSecrets(c.var.deps.db, actor, resource),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"secret.create",
			createRoute({
				method: "post",
				path: "/secrets",
				tags,
				security,
				summary: "Create a secret",
				middleware: [requirePermission("write", fromBody)],
				request: body(SecretInput),
				responses: {
					201: json(Secret, "Created"),
					...errors,
					...reservedEnvKey,
				},
			}),
		),
		async (c) => {
			const { value, reference, ...input } = c.req.valid("json");
			rejectReservedEnvKeys([input.key]);
			const actor = c.get("actor") as Actor;
			const { db } = c.var.deps;
			const row =
				reference !== undefined
					? one(
							await db
								.insert(secret)
								.values({
									...input,
									description: input.description ?? null,
									organizationId: actor.organizationId,
									...(await externalColumns(
										db,
										actor.organizationId,
										reference,
									)),
									currentVersion: 0,
									createdBy: actor.userId,
									updatedBy: actor.userId,
								})
								.returning(),
						)
					: await db.transaction((tx) =>
							createSecret(
								{ ...secretsCtx(c), db: tx },
								{
									...input,
									value: value as string,
									organizationId: actor.organizationId,
								},
								actor.userId,
							),
						);
			c.set("auditResourceId", row.id);
			c.set("auditDiff", {
				scope: input.scope,
				key: input.key,
				...(reference !== undefined ? { reference } : { version: 1 }),
			});
			const [out] = await present(db, [row]);
			return c.json(out, 201);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/secrets/{id}",
			tags,
			security,
			summary: "One secret's metadata",
			middleware: [requirePermission("read", fromRow)],
			request: { params: IdParam },
			responses: { 200: json(Secret, "Secret"), ...errors },
		}),
		async (c) => {
			const row = await loadRow(c, c.get("actor") as Actor);
			const [out] = await present(c.var.deps.db, [row]);
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"secret.update",
			createRoute({
				method: "patch",
				path: "/secrets/{id}",
				tags,
				security,
				summary: "Change a secret",
				description:
					"A new value becomes a new version; services that reference it show a pending change until they redeploy.",
				middleware: [requirePermission("write", fromRow)],
				request: { params: IdParam, ...body(SecretUpdate) },
				responses: { 200: json(Secret, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const actor = c.get("actor") as Actor;
			const { value, reference, description } = c.req.valid("json");
			const { db } = c.var.deps;
			const prev = await loadRow(c, actor);
			if (value !== undefined && prev.providerId) externalOnly(prev);
			if (reference !== undefined && !prev.providerId)
				throw new Failure(
					"bad_request",
					"only an external secret has a reference; create a new secret to read one from a provider",
				);
			const row = await db.transaction(async (tx) => {
				let r = prev;
				if (reference !== undefined)
					r = one(
						await tx
							.update(secret)
							.set({
								...(await externalColumns(tx, actor.organizationId, reference)),
								updatedBy: actor.userId,
							})
							.where(eq(secret.id, prev.id))
							.returning(),
					);
				if (description !== undefined)
					r = one(
						await tx
							.update(secret)
							.set({ description, updatedBy: actor.userId })
							.where(eq(secret.id, prev.id))
							.returning(),
					);
				if (value !== undefined)
					r = await setSecretValue(
						{ ...secretsCtx(c), db: tx },
						prev.id,
						value,
						actor.userId,
					);
				return r;
			});
			c.set("auditResourceId", row.id);
			c.set("auditDiff", {
				key: row.key,
				...(value !== undefined && {
					version: { from: prev.currentVersion, to: row.currentVersion },
				}),
				...(description !== undefined && { description }),
				...(reference !== undefined && { reference }),
			});
			const [out] = await present(db, [row]);
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"secret.reveal",
			createRoute({
				method: "post",
				path: "/secrets/{id}/reveal",
				tags,
				security,
				summary: "Read a secret's value",
				description:
					"Needs `read:secrets` on the scope that defines it. Every call is recorded in the audit log. Refused for an external secret, whose value stays in its provider.",
				middleware: [requirePermission("read:secrets", fromRow)],
				request: {
					params: IdParam,
					...body(z.object({ version: z.int().min(1).optional() })),
				},
				responses: { 200: json(SecretReveal, "Value"), ...errors },
			}),
		),
		async (c) => {
			const row = await loadRow(c, c.get("actor") as Actor);
			if (row.providerId) externalOnly(row);
			const version = c.req.valid("json").version ?? row.currentVersion;
			if (version > row.currentVersion) throw notFound("secret version");
			const value = await readSecretValue(secretsCtx(c), row, version);
			c.set("auditResourceId", row.id);
			c.set("auditDiff", { key: row.key, version });
			return c.json({ version, value }, 200, noStore);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/secrets/{id}/versions",
			tags,
			security,
			summary: "A secret's history",
			middleware: [requirePermission("read", fromRow)],
			request: { params: IdParam },
			responses: { 200: json(z.array(SecretVersion), "Versions"), ...errors },
		}),
		async (c) => {
			const row = await loadRow(c, c.get("actor") as Actor);
			const versions = await c.var.deps.db
				.select({
					version: secretVersion.version,
					createdBy: secretVersion.createdBy,
					createdAt: secretVersion.createdAt,
				})
				.from(secretVersion)
				.where(eq(secretVersion.secretId, row.id))
				.orderBy(desc(secretVersion.version));
			return c.json(
				versions.map((v) => ({
					...v,
					current: v.version === row.currentVersion,
				})),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"secret.rollback",
			createRoute({
				method: "post",
				path: "/secrets/{id}/rollback",
				tags,
				security,
				summary: "Restore an earlier value",
				description:
					"Copies `version`'s value as a new version; history stays append-only.",
				middleware: [requirePermission("write", fromRow)],
				request: {
					params: IdParam,
					...body(z.object({ version: z.int().min(1) })),
				},
				responses: { 200: json(Secret, "Restored"), ...errors },
			}),
		),
		async (c) => {
			const actor = c.get("actor") as Actor;
			const prev = await loadRow(c, actor);
			if (prev.providerId) externalOnly(prev);
			const { version } = c.req.valid("json");
			if (version >= prev.currentVersion)
				throw new Failure(
					"bad_request",
					"pick a version older than the current one",
				);
			const { db } = c.var.deps;
			const row = await db.transaction(async (tx) => {
				const t = { ...secretsCtx(c), db: tx };
				const value = await readSecretValue(t, prev, version);
				return setSecretValue(t, prev.id, value, actor.userId);
			});
			c.set("auditResourceId", row.id);
			c.set("auditDiff", {
				key: row.key,
				restored: version,
				version: row.currentVersion,
			});
			const [out] = await present(db, [row]);
			return c.json(out, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/secrets/{id}/usages",
			tags,
			security,
			summary: "Services that reference a secret",
			middleware: [requirePermission("read", fromRow)],
			request: { params: IdParam },
			responses: { 200: json(z.array(SecretUsage), "Usages"), ...errors },
		}),
		async (c) => {
			const row = await loadRow(c, c.get("actor") as Actor);
			return c.json(await usagesOf(c.var.deps.db, row.id), 200);
		},
	)
	.openapi(
		mutation(
			"secret.delete",
			createRoute({
				method: "delete",
				path: "/secrets/{id}",
				tags,
				security,
				summary: "Delete a secret and its history",
				description: "Refused (409) while a service references it.",
				middleware: [requirePermission("delete", fromRow)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const row = await loadRow(c, c.get("actor") as Actor);
			const { db } = c.var.deps;
			const usages = await usagesOf(db, row.id);
			if (usages.length)
				throw new Failure(
					"conflict",
					`${row.key} is used by ${usages.length} service variable(s); remove those references first`,
					{ usages },
				);
			await db.delete(secret).where(eq(secret.id, row.id));
			c.set("auditResourceId", row.id);
			c.set("auditDiff", { key: row.key, scope: row.scope });
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"secret_key.rotate",
			createRoute({
				method: "post",
				path: "/organization/secret-keys/rotate",
				tags,
				security,
				summary: "Rotate the organization's secret encryption key",
				description:
					"Creates a new data key and re-encrypts every secret version with it. Values and references do not change. Safe to repeat.",
				middleware: [requirePermission("admin", inOrganization)],
				responses: {
					200: json(
						z.object({ version: z.int(), reencrypted: z.int() }),
						"Rotated",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const actor = c.get("actor") as Actor;
			const { db, masterKey, secretsKek } = c.var.deps;
			const out = await rotateDataKey(
				{ db, masterKey, secretsKek },
				actor.organizationId,
			);
			c.set("auditDiff", out);
			return c.json(out, 200);
		},
	);

export async function usagesOf(db: Db, secretId: string) {
	return db
		.select({
			envVarId: envVar.id,
			key: envVar.key,
			serviceId: service.id,
			serviceName: service.name,
			environmentId: environment.id,
			projectId: environment.projectId,
		})
		.from(envVar)
		.innerJoin(service, eq(service.id, envVar.scopeId))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.where(and(eq(envVar.secretId, secretId), eq(envVar.scope, "service")))
		.orderBy(asc(service.name));
}
