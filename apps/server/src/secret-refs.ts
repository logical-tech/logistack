import {
	parseSecretReference,
	secretReferenceIssue,
	secretReferenceTail,
} from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import { envVar, secretProvider } from "@logistack/db";
import { type DbOrTx, readSecretValues } from "@logistack/worker/secrets";
import { and, eq, inArray } from "drizzle-orm";
import type { Actor } from "./actor.ts";
import type { Deps } from "./env.ts";
import { Failure } from "./errors.ts";
import { actorCan, organizationResource } from "./scope.ts";

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

/**
 * The columns of an external secret for `reference`, after checking its provider and path shape.
 * A provider reads any path its token reaches, so pointing at a new one needs admin on the
 * organization; `current` (the secret's columns now) lets an unchanged reference through.
 */
export async function externalColumns(
	db: DbOrTx,
	actor: Actor,
	reference: string,
	current?: { providerId: string | null; externalRef: string | null },
) {
	const { organizationId } = actor;
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
	const externalRef = secretReferenceTail(parsed.ref);
	if (
		(current?.providerId !== p.id || current.externalRef !== externalRef) &&
		!actorCan(actor, "admin", organizationResource(organizationId))
	)
		throw new Failure(
			"forbidden",
			"reading a secret from a provider needs admin on the organization",
		);
	return {
		providerId: p.id,
		externalRef,
		externalFingerprint: null,
		externalCheckedAt: null,
		externalError: null,
	};
}
