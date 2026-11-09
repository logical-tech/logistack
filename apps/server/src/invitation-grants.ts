import { type Db, invitationGrant, roleGrant } from "@logistack/db";
import { eq } from "drizzle-orm";

/**
 * On acceptance, turns an invitation's scoped grants (plan 12.8: a guest on one project, a developer
 * on one folder) into `role_grant` rows. Idempotent: a replayed hook adds nothing twice.
 */
export async function applyInvitationGrants(
	db: Db,
	o: { invitationId: string; userId: string; organizationId: string },
) {
	const rows = await db
		.select()
		.from(invitationGrant)
		.where(eq(invitationGrant.invitationId, o.invitationId));
	if (!rows.length) return;
	await db
		.insert(roleGrant)
		.values(
			rows.map((g) => ({
				organizationId: o.organizationId,
				userId: o.userId,
				role: g.role,
				scopeKind: g.scopeKind,
				scopeId: g.scopeId,
			})),
		)
		.onConflictDoNothing();
}
