import {
	parseSecretReference,
	secretReferenceIssue,
	secretReferenceTail,
} from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import { envVar, secretProvider } from "@logistack/db";
import { type DbOrTx, readSecretValues } from "@logistack/worker/secrets";
import { and, eq, inArray } from "drizzle-orm";
import type { Deps } from "./env.ts";
import { Failure } from "./errors.ts";

/**
 * Current values of a service's own variables `keys` (minted credentials): a reference reads its
 * managed secret, a plain value decrypts. Never the v1 copy on a reference, which goes away.
 */
export async function serviceEnvValues(
	deps: Pick<Deps, "db" | "masterKey" | "secretsKek">,
	serviceId: string,
	keys: readonly string[],
): Promise<Record<string, string>> {
	const rows = await deps.db
		.select({
			key: envVar.key,
			value: envVar.valueEncrypted,
			secretId: envVar.secretId,
		})
		.from(envVar)
		.where(
			and(
				eq(envVar.scope, "service"),
				eq(envVar.scopeId, serviceId),
				inArray(envVar.key, [...keys]),
			),
		);
	const secrets = await readSecretValues(
		deps,
		rows.flatMap((r) => (r.secretId ? [r.secretId] : [])),
	);
	const out: Record<string, string> = {};
	for (const r of rows) {
		if (!r.secretId) out[r.key] = await decrypt(deps.masterKey, r.value);
		else {
			// An external secret has no stored value; these callers need a managed one.
			const v = secrets.get(r.secretId)?.value;
			if (v != null) out[r.key] = v;
		}
	}
	return out;
}

/** The columns of an external secret for `reference`, after checking its provider and path shape. */
export async function externalColumns(
	db: DbOrTx,
	organizationId: string,
	reference: string,
) {
	const parsed = parseSecretReference(reference.trim());
	if (!parsed.ok) throw new Failure("validation_failed", parsed.error);
	const [p] = await db
		.select()
		.from(secretProvider)
		.where(
			and(
				eq(secretProvider.organizationId, organizationId),
				eq(secretProvider.name, parsed.ref.provider),
			),
		);
	if (!p)
		throw new Failure(
			"validation_failed",
			`no secret provider named "${parsed.ref.provider}"; add it in Integrations > Secret providers`,
		);
	const issue = secretReferenceIssue(p.kind, parsed.ref);
	if (issue) throw new Failure("validation_failed", issue);
	return {
		providerId: p.id,
		externalRef: secretReferenceTail(parsed.ref),
		externalFingerprint: null,
		externalCheckedAt: null,
		externalError: null,
	};
}
