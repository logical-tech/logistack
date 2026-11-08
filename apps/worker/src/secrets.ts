import type { SecretScope } from "@logistack/contracts";
import {
	decrypt,
	encrypt,
	newWrappedDataKey,
	seal,
	secretValueAad,
	unseal,
	unwrapDataKey,
} from "@logistack/core";
import {
	type Db,
	environment,
	envVar,
	project,
	secret,
	secretKey,
	secretVersion,
	service,
} from "@logistack/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

/** A database handle or an open transaction. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type SecretsCtx = {
	db: DbOrTx;
	/** Only for the v1 copy on referencing env_var rows. */
	masterKey: CryptoKey;
	secretsKek: CryptoKey;
};

// shortcut: unbounded per-process cache of unwrapped (non-extractable) data keys; orgs × versions stay small.
const dataKeys = new WeakMap<CryptoKey, Map<string, Promise<CryptoKey>>>();

function dataKey(
	ctx: SecretsCtx,
	organizationId: string,
	version: number,
): Promise<CryptoKey> {
	const byKek = dataKeys.get(ctx.secretsKek) ?? new Map();
	dataKeys.set(ctx.secretsKek, byKek);
	const id = `${organizationId}:${version}`;
	let key = byKek.get(id);
	if (!key) {
		key = (async () => {
			const [row] = await ctx.db
				.select({ wrappedKey: secretKey.wrappedKey })
				.from(secretKey)
				.where(
					and(
						eq(secretKey.organizationId, organizationId),
						eq(secretKey.version, version),
					),
				);
			if (!row)
				throw new Error(`data key ${version} of ${organizationId} is missing`);
			return unwrapDataKey(
				ctx.secretsKek,
				organizationId,
				version,
				row.wrappedKey,
			);
		})();
		key.catch(() => byKek.delete(id));
		byKek.set(id, key);
	}
	return key;
}

/** The organization's active data key, created on first use. */
async function activeDataKey(
	ctx: SecretsCtx,
	organizationId: string,
): Promise<{ version: number; key: CryptoKey }> {
	const active = () =>
		ctx.db
			.select({ version: secretKey.version })
			.from(secretKey)
			.where(
				and(
					eq(secretKey.organizationId, organizationId),
					eq(secretKey.status, "active"),
				),
			);
	let [row] = await active();
	if (!row) {
		await ctx.db
			.insert(secretKey)
			.values({
				organizationId,
				version: 1,
				wrappedKey: await newWrappedDataKey(ctx.secretsKek, organizationId, 1),
				status: "active",
			})
			.onConflictDoNothing();
		[row] = await active();
		if (!row) throw new Error(`no active data key for ${organizationId}`);
	}
	return {
		version: row.version,
		key: await dataKey(ctx, organizationId, row.version),
	};
}

type SecretRef = { id: string; organizationId: string };

/** Stores `value` as `version` of the secret and refreshes the copies on referencing rows. */
async function writeVersion(
	ctx: SecretsCtx,
	s: SecretRef,
	version: number,
	value: string,
	userId: string | null,
) {
	const dek = await activeDataKey(ctx, s.organizationId);
	await ctx.db.insert(secretVersion).values({
		secretId: s.id,
		version,
		dekVersion: dek.version,
		valueEncrypted: await seal(
			dek.key,
			secretValueAad(s.organizationId, s.id, version),
			value,
		),
		createdBy: userId,
	});
	// shortcut: v1 copy kept only for v0.5.0, whose credential readers still read it; stop writing it next release.
	await ctx.db
		.update(envVar)
		.set({ valueEncrypted: await encrypt(ctx.masterKey, value) })
		.where(eq(envVar.secretId, s.id));
}

export async function createSecret(
	ctx: SecretsCtx,
	input: {
		organizationId: string;
		scope: SecretScope;
		scopeId: string;
		key: string;
		value: string;
		description?: string | null;
	},
	userId: string | null,
) {
	const [row] = await ctx.db
		.insert(secret)
		.values({
			organizationId: input.organizationId,
			scope: input.scope,
			scopeId: input.scopeId,
			key: input.key,
			description: input.description ?? null,
			currentVersion: 1,
			createdBy: userId,
			updatedBy: userId,
		})
		.returning();
	if (!row) throw new Error("secret insert returned nothing");
	await writeVersion(ctx, row, 1, input.value, userId);
	return row;
}

/** Adds a version with `value`; the row lock serializes concurrent writers. */
export async function setSecretValue(
	ctx: SecretsCtx,
	secretId: string,
	value: string,
	userId: string | null,
) {
	const [row] = await ctx.db
		.update(secret)
		.set({
			currentVersion: sql`${secret.currentVersion} + 1`,
			updatedBy: userId,
		})
		.where(eq(secret.id, secretId))
		.returning();
	if (!row) throw new Error(`secret ${secretId} not found`);
	await writeVersion(ctx, row, row.currentVersion, value, userId);
	return row;
}

/** Decrypts one version (default: the current one). External secrets have none. */
export async function readSecretValue(
	ctx: SecretsCtx,
	s: SecretRef & { currentVersion: number; providerId?: string | null },
	version = s.currentVersion,
): Promise<string> {
	if (s.providerId)
		throw new Error(
			`secret ${s.id} is external; its value lives in the provider`,
		);
	const [v] = await ctx.db
		.select()
		.from(secretVersion)
		.where(
			and(eq(secretVersion.secretId, s.id), eq(secretVersion.version, version)),
		);
	if (!v) throw new Error(`secret ${s.id} has no version ${version}`);
	return unseal(
		await dataKey(ctx, s.organizationId, v.dekVersion),
		secretValueAad(s.organizationId, s.id, version),
		v.valueEncrypted,
	);
}

/** The current value of each secret, by id; null for an external secret (see `resolveExternalSecrets`). */
export async function readSecretValues(ctx: SecretsCtx, ids: string[]) {
	const out = new Map<
		string,
		typeof secret.$inferSelect & { value: string | null }
	>();
	if (!ids.length) return out;
	const rows = await ctx.db
		.select()
		.from(secret)
		.where(inArray(secret.id, [...new Set(ids)]));
	for (const s of rows)
		out.set(s.id, {
			...s,
			value: s.providerId ? null : await readSecretValue(ctx, s),
		});
	return out;
}

/**
 * Starts a new data key version for the organization and re-encrypts every secret version
 * under it. Idempotent: rerunning finishes an interrupted rotation.
 */
export async function rotateDataKey(
	ctx: SecretsCtx & { db: Db },
	organizationId: string,
) {
	const version = await ctx.db.transaction(async (tx) => {
		const t = { ...ctx, db: tx };
		const current = await activeDataKey(t, organizationId);
		const next = current.version + 1;
		await tx
			.update(secretKey)
			.set({ status: "retired" })
			.where(
				and(
					eq(secretKey.organizationId, organizationId),
					eq(secretKey.status, "active"),
				),
			);
		await tx.insert(secretKey).values({
			organizationId,
			version: next,
			wrappedKey: await newWrappedDataKey(ctx.secretsKek, organizationId, next),
			status: "active",
		});
		return next;
	});
	return {
		version,
		reencrypted: await reencrypt(ctx, organizationId, version),
	};
}

// shortcut: re-encrypts in one pass inside the request; move to a job past ~10k versions per org.
async function reencrypt(
	ctx: SecretsCtx & { db: Db },
	orgId: string,
	to: number,
) {
	const key = await dataKey(ctx, orgId, to);
	const rows = await ctx.db
		.select({ v: secretVersion, orgId: secret.organizationId })
		.from(secretVersion)
		.innerJoin(secret, eq(secret.id, secretVersion.secretId))
		.where(
			and(
				eq(secret.organizationId, orgId),
				sql`${secretVersion.dekVersion} <> ${to}`,
			),
		);
	for (const { v } of rows) {
		const aad = secretValueAad(orgId, v.secretId, v.version);
		const plain = await unseal(
			await dataKey(ctx, orgId, v.dekVersion),
			aad,
			v.valueEncrypted,
		);
		await ctx.db
			.update(secretVersion)
			.set({ valueEncrypted: await seal(key, aad, plain), dekVersion: to })
			.where(eq(secretVersion.id, v.id));
	}
	return rows.length;
}

/**
 * Moves secret variables stored the pre-secrets way (`env_var.is_secret` without a secret) into
 * managed secrets. A service variable becomes a service secret plus a reference. An organization,
 * project or environment variable becomes a secret at that scope, referenced from every service
 * that received it, so each service's effective env is unchanged. Idempotent; each row converts
 * in its own transaction.
 */
export async function convertLegacySecrets(ctx: SecretsCtx & { db: Db }) {
	const legacy = await ctx.db
		.select()
		.from(envVar)
		.where(and(eq(envVar.isSecret, true), isNull(envVar.secretId)));
	let converted = 0;
	for (const row of legacy) {
		await ctx.db.transaction(async (tx) => {
			const t = { ...ctx, db: tx };
			// Re-read under a lock: a concurrent pass may have converted it already.
			const [cur] = await tx
				.select()
				.from(envVar)
				.where(and(eq(envVar.id, row.id), isNull(envVar.secretId)))
				.for("update");
			if (!cur) return;
			const services = await servicesUnder(tx, cur.scope, cur.scopeId);
			const organizationId =
				cur.scope === "organization" ? cur.scopeId : services.orgId;
			if (!organizationId) {
				// The scope no longer exists: nothing can receive it.
				await tx.delete(envVar).where(eq(envVar.id, cur.id));
				return;
			}
			const value = await decrypt(ctx.masterKey, cur.valueEncrypted);
			const s = await upsertByKey(
				t,
				organizationId,
				cur.scope,
				cur.scopeId,
				cur.key,
				value,
			);
			if (cur.scope === "service") {
				await tx
					.update(envVar)
					.set({ secretId: s.id })
					.where(eq(envVar.id, cur.id));
			} else {
				for (const svc of services.list) {
					if (await overriddenBelow(tx, cur.scope, cur.key, svc)) continue;
					await tx
						.insert(envVar)
						.values({
							scope: "service",
							scopeId: svc.serviceId,
							key: cur.key,
							isSecret: true,
							isBuildTime: cur.isBuildTime,
							secretId: s.id,
							valueEncrypted: cur.valueEncrypted,
						})
						.onConflictDoNothing();
				}
				await tx.delete(envVar).where(eq(envVar.id, cur.id));
			}
			converted++;
		});
	}
	return converted;
}

async function upsertByKey(
	ctx: SecretsCtx,
	organizationId: string,
	scope: SecretScope,
	scopeId: string,
	key: string,
	value: string,
) {
	const [existing] = await ctx.db
		.select()
		.from(secret)
		.where(
			and(
				eq(secret.scope, scope),
				eq(secret.scopeId, scopeId),
				eq(secret.key, key),
			),
		);
	if (!existing)
		return createSecret(
			ctx,
			{ organizationId, scope, scopeId, key, value },
			null,
		);
	// An external secret owns the key at this scope: the reference wins over the legacy copy.
	if (existing.providerId) return existing;
	if ((await readSecretValue(ctx, existing)) === value) return existing;
	return setSecretValue(ctx, existing.id, value, null);
}

type ServiceChain = {
	serviceId: string;
	environmentId: string;
	projectId: string;
};

async function servicesUnder(
	db: DbOrTx,
	scope: (typeof envVar.$inferSelect)["scope"],
	scopeId: string,
): Promise<{ orgId: string | null; list: ServiceChain[] }> {
	const where = {
		organization: eq(project.organizationId, scopeId),
		project: eq(project.id, scopeId),
		environment: eq(environment.id, scopeId),
		service: eq(service.id, scopeId),
	}[scope];
	const list = await db
		.select({
			serviceId: service.id,
			environmentId: environment.id,
			projectId: project.id,
			orgId: project.organizationId,
		})
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(where);
	let orgId = list[0]?.orgId ?? null;
	if (!orgId && scope !== "service" && scope !== "organization") {
		const [p] = await db
			.select({ orgId: project.organizationId })
			.from(project)
			.leftJoin(environment, eq(environment.projectId, project.id))
			.where(
				scope === "project"
					? eq(project.id, scopeId)
					: eq(environment.id, scopeId),
			);
		orgId = p?.orgId ?? null;
	}
	return { orgId, list };
}

/** Whether a scope more specific than `scope` defines `key` for this service. */
async function overriddenBelow(
	db: DbOrTx,
	scope: (typeof envVar.$inferSelect)["scope"],
	key: string,
	svc: ServiceChain,
) {
	const below = [
		["project", svc.projectId],
		["environment", svc.environmentId],
		["service", svc.serviceId],
	] as const;
	const from = below.findIndex(([s]) => s === scope) + 1;
	const scopes = scope === "organization" ? below : below.slice(from);
	if (!scopes.length) return false;
	const [hit] = await db
		.select({ id: envVar.id })
		.from(envVar)
		.where(
			and(
				eq(envVar.key, key),
				or(
					...scopes.map(([s, id]) =>
						and(eq(envVar.scope, s), eq(envVar.scopeId, id)),
					),
				),
			),
		)
		.limit(1);
	return !!hit;
}
