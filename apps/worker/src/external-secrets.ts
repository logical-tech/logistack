import {
	parseSecretReference,
	SECRET_REFERENCE_SCHEME,
	type SecretProviderKind,
} from "@logistack/contracts";
import { decrypt, encrypt } from "@logistack/core";
import { type Db, envVar, secret, secretProvider } from "@logistack/db";
import {
	type Fetch,
	instantiate,
	ProviderError,
	type SecretSource,
	secretProviders,
	sha256Hex,
} from "@logistack/providers";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
// shortcut: imported across apps, like notify.ts does.
import {
	BlockedHostError,
	guardedFetch,
	hostPolicy,
} from "../../server/src/ssrf.ts";
import type { DbOrTx } from "./secrets.ts";

type SecretRow = typeof secret.$inferSelect;
type ProviderRow = typeof secretProvider.$inferSelect;

export type ExternalCtx = {
	db: DbOrTx;
	masterKey: CryptoKey;
	/** Tests only: replaces the SSRF-guarded fetch. */
	fetch?: Fetch;
};

/** User-provided URLs go through the SSRF guard; http is allowed to private hosts once those are allowed. */
async function providerFetch(ctx: ExternalCtx): Promise<Fetch> {
	if (ctx.fetch) return ctx.fetch;
	const policy = await hostPolicy(ctx.db as Db);
	return (url, init) => guardedFetch(url, init ?? {}, policy, undefined, true);
}

export async function openSource(
	ctx: ExternalCtx,
	kind: SecretProviderKind,
	config: unknown,
): Promise<SecretSource> {
	return instantiate(secretProviders[kind], config, {
		fetch: await providerFetch(ctx),
	});
}

export async function providerConfig(ctx: ExternalCtx, row: ProviderRow) {
	return JSON.parse(await decrypt(ctx.masterKey, row.configEncrypted));
}

export const referenceOf = (providerName: string, externalRef: string) =>
	`${SECRET_REFERENCE_SCHEME}${providerName}/${externalRef}`;

/**
 * A failure as shown to users and stored on the secret. Provider errors are safe by design; any
 * other error (a malformed response, say) could quote what it parsed, so it is replaced.
 */
export const failureMessage = (e: unknown) =>
	e instanceof ProviderError || e instanceof BlockedHostError
		? e.message
		: "the provider returned an unexpected response";

/** What an external value contributes to a spec snapshot: a hash, never the value. */
export const externalPlaceholder = (secretId: string, hash: string | null) =>
	`external:${secretId}:${hash ?? "unresolved"}`;

/** The placeholder for the value last read, from the secret's encrypted fingerprint. */
export async function storedPlaceholder(ctx: ExternalCtx, row: SecretRow) {
	return externalPlaceholder(
		row.id,
		row.externalFingerprint
			? await decrypt(ctx.masterKey, row.externalFingerprint)
			: null,
	);
}

export class ExternalSecretError extends Error {
	constructor(readonly failures: string[]) {
		super(
			`could not read ${failures.length === 1 ? "an external secret" : `${failures.length} external secrets`}: ${failures.join("; ")}`,
		);
		this.name = "ExternalSecretError";
	}
}

/**
 * Reads every external secret in `rows` from its provider. Values stay in memory: the secret row
 * records only when it was checked, the error if any, and an encrypted hash of the value (so a
 * changed value shows as a pending change). Throws `ExternalSecretError` naming every failure.
 */
export async function resolveExternalSecrets(
	ctx: ExternalCtx,
	rows: SecretRow[],
): Promise<Map<string, { value: string; placeholder: string }>> {
	const out = new Map<string, { value: string; placeholder: string }>();
	const ext = rows.filter((r) => r.providerId);
	if (!ext.length) return out;
	const providers = new Map(
		(
			await ctx.db
				.select()
				.from(secretProvider)
				.where(
					inArray(secretProvider.id, [
						...new Set(ext.map((r) => r.providerId as string)),
					]),
				)
		).map((p) => [p.id, p]),
	);
	const sources = new Map<string, Promise<SecretSource>>();
	const source = (p: ProviderRow) => {
		let s = sources.get(p.id);
		if (!s) {
			s = providerConfig(ctx, p).then((cfg) => openSource(ctx, p.kind, cfg));
			sources.set(p.id, s);
		}
		return s;
	};
	const failures: string[] = [];
	await Promise.all(
		ext.map(async (r) => {
			const p = providers.get(r.providerId as string);
			const reference = p
				? referenceOf(p.name, r.externalRef ?? "")
				: "its provider";
			let fingerprint = r.externalFingerprint;
			let error: string | null = null;
			try {
				if (!p || p.organizationId !== r.organizationId)
					throw new ProviderError("secrets", "read", "provider not found");
				const parsed = parseSecretReference(reference);
				if (!parsed.ok) throw new ProviderError(p.kind, "read", parsed.error);
				const value = await (await source(p)).read(
					parsed.ref.path,
					parsed.ref.key,
				);
				const hash = await sha256Hex(`${p.id}\n${r.externalRef}\n${value}`);
				fingerprint = await encrypt(ctx.masterKey, hash);
				out.set(r.id, { value, placeholder: externalPlaceholder(r.id, hash) });
			} catch (e) {
				error = failureMessage(e);
				failures.push(`${r.key} (${reference}): ${error}`);
			}
			await ctx.db
				.update(secret)
				.set({
					externalFingerprint: fingerprint,
					externalCheckedAt: new Date(),
					externalError: error,
					// A check is not an edit.
					updatedAt: r.updatedAt,
				})
				.where(eq(secret.id, r.id));
		}),
	);
	if (failures.length) throw new ExternalSecretError(failures.sort());
	return out;
}

/**
 * Periodic re-resolution: reads every external secret a service references and records its
 * fingerprint, so a value changed in the provider shows as a pending change on those services.
 */
export async function recheckExternalSecrets(ctx: ExternalCtx & { db: Db }) {
	const used = ctx.db
		.selectDistinct({ id: envVar.secretId })
		.from(envVar)
		.where(isNotNull(envVar.secretId));
	const rows = await ctx.db
		.select()
		.from(secret)
		.where(and(isNotNull(secret.providerId), inArray(secret.id, used)));
	// Every row's outcome is recorded even when some fail.
	const failed = await resolveExternalSecrets(ctx, rows).then(
		() => 0,
		(e) => {
			if (e instanceof ExternalSecretError) return e.failures.length;
			throw e;
		},
	);
	return { checked: rows.length, failed };
}
