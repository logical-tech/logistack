import {
	parseSecretReference,
	secretReferenceIssue,
	secretReferenceTail,
} from "@logistack/contracts";
import { secretProvider } from "@logistack/db";
import type { DbOrTx } from "@logistack/worker/secrets";
import { and, eq } from "drizzle-orm";
import { Failure } from "./errors.ts";

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
