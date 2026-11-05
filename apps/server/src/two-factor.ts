import { z } from "@hono/zod-openapi";
import { TwoFactorPolicy } from "@logistack/contracts";
import { type TwoFactorAccess, twoFactorAccess } from "@logistack/core";
import {
	account,
	auditLog,
	type Db,
	invitation,
	member,
	organization,
	passkey,
	ssoProvider,
	user,
} from "@logistack/db";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Context } from "hono";
import { recordAudit } from "./audit.ts";
import type { Env } from "./env.ts";

/*
 * The policy lives in `organization.metadata` (better-auth's JSON text column) as
 * `{"twoFactor": {mode, graceDays, trustIdpMfa, enabledAt}}`, next to the SSO default roles:
 * no table of our own, no migration.
 */

const Stored = TwoFactorPolicy.extend({
	/** When the mode last went from off to required; null while off. */
	enabledAt: z.coerce.date().nullable(),
});
export type StoredTwoFactorPolicy = z.infer<typeof Stored>;

export const defaultTwoFactorPolicy: StoredTwoFactorPolicy = {
	mode: "off",
	graceDays: 7,
	trustIdpMfa: false,
	enabledAt: null,
};

const metadataJson = sql`coalesce(${organization.metadata}::jsonb, '{}'::jsonb)`;

export async function readTwoFactorPolicy(
	db: Db,
	organizationId: string,
): Promise<StoredTwoFactorPolicy> {
	const [row] = await db
		.select({ policy: sql<unknown>`${metadataJson}->'twoFactor'` })
		.from(organization)
		.where(eq(organization.id, organizationId));
	const parsed = Stored.safeParse(row?.policy);
	return parsed.success ? parsed.data : defaultTwoFactorPolicy;
}

/** Saves `next`; the grace clock starts when the mode turns to required and keeps running across edits. */
export async function writeTwoFactorPolicy(
	db: Db,
	organizationId: string,
	next: TwoFactorPolicy,
	now = new Date(),
): Promise<{ before: StoredTwoFactorPolicy; after: StoredTwoFactorPolicy }> {
	const before = await readTwoFactorPolicy(db, organizationId);
	const after: StoredTwoFactorPolicy = {
		...next,
		enabledAt:
			next.mode === "off"
				? null
				: before.mode === "required"
					? before.enabledAt
					: now,
	};
	await db
		.update(organization)
		.set({
			metadata: sql`(${metadataJson} || jsonb_build_object('twoFactor', ${JSON.stringify(after)}::jsonb))::text`,
		})
		.where(eq(organization.id, organizationId));
	return { before, after };
}

export type MemberTwoFactor = TwoFactorAccess & { memberId: string };

/**
 * The access decision for a signed-in member, or undefined when they are not a member.
 * One query for the policy; a second only when the organization requires a second factor.
 */
export async function memberTwoFactor(
	db: Db,
	userId: string,
	organizationId: string,
	now = new Date(),
): Promise<MemberTwoFactor | undefined> {
	const policy = await readTwoFactorPolicy(db, organizationId);
	if (policy.mode === "off" || !policy.enabledAt) return undefined;
	const [row] = await db
		.select({
			memberId: member.id,
			joinedAt: member.createdAt,
			totp: sql<boolean>`coalesce(${user.twoFactorEnabled}, false)`,
			passkey: sql<boolean>`exists (select 1 from ${passkey} where ${passkey.userId} = ${userId})`,
			ssoOnly: sql<boolean>`not exists (select 1 from ${account} where ${account.userId} = ${userId} and ${account.providerId} = 'credential')
				and exists (select 1 from ${account} join ${ssoProvider} on ${ssoProvider.providerId} = ${account.providerId}
					where ${account.userId} = ${userId} and ${ssoProvider.organizationId} = ${organizationId})`,
		})
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(
			and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
		);
	if (!row) return undefined;
	const access = twoFactorAccess(
		row,
		policy,
		{ joinedAt: row.joinedAt, enabledAt: policy.enabledAt },
		now,
	);
	return { ...access, memberId: row.memberId };
}

export const TWO_FACTOR_BLOCKED = "member.two_factor_blocked";

export const TWO_FACTOR_REQUIRED_MESSAGE =
	"this organization requires two-factor authentication: add an authenticator app or a passkey";

/**
 * better-auth organization endpoints a blocked member may still call: answering an invitation
 * and choosing an organization. Every other `/organization/*` endpoint is gated, new ones included.
 */
const OPEN_ORGANIZATION_PATHS = new Set([
	"/organization/accept-invitation",
	"/organization/reject-invitation",
	"/organization/get-invitation",
	"/organization/list-user-invitations",
	"/organization/list",
	"/organization/set-active",
]);

const OrganizationTarget = z
	.object({
		organizationId: z.string().optional(),
		organizationSlug: z.string().optional(),
		invitationId: z.string().optional(),
	})
	.catch({});

/**
 * The organization a better-auth organization endpoint acts on, resolved in better-auth's order:
 * the invitation's, then the slug's, then the id, else the session's active organization.
 */
async function targetOrganization(
	db: Db,
	input: unknown,
	activeOrganizationId: string | null | undefined,
): Promise<string | undefined> {
	const target = OrganizationTarget.parse(input);
	if (target.invitationId) {
		const [row] = await db
			.select({ id: invitation.organizationId })
			.from(invitation)
			.where(eq(invitation.id, target.invitationId));
		return row?.id;
	}
	if (target.organizationSlug) {
		const [row] = await db
			.select({ id: organization.id })
			.from(organization)
			.where(eq(organization.slug, target.organizationSlug));
		return row?.id;
	}
	return target.organizationId ?? activeOrganizationId ?? undefined;
}

/** The lockout that refuses this better-auth `/organization/*` request, or undefined when it may proceed. */
export async function blockedOnOrganizationEndpoint(
	db: Db,
	request: {
		path: string;
		body?: unknown;
		query?: unknown;
		userId: string;
		activeOrganizationId?: string | null;
	},
): Promise<{ memberId: string; deadline: Date } | undefined> {
	if (OPEN_ORGANIZATION_PATHS.has(request.path)) return undefined;
	const organizationId = await targetOrganization(
		db,
		{ ...(request.query as object), ...(request.body as object) },
		request.activeOrganizationId,
	);
	if (!organizationId) return undefined;
	const access = await memberTwoFactor(db, request.userId, organizationId);
	return access?.kind === "blocked" ? access : undefined;
}

/** One audit row per member and lockout: the first request after the deadline writes it. */
export async function auditBlocked(
	c: Context<Env>,
	{ memberId, deadline }: { memberId: string; deadline: Date },
) {
	const actor = c.get("actor");
	if (!actor) return;
	const [seen] = await c.var.deps.db
		.select({ id: auditLog.id })
		.from(auditLog)
		.where(
			and(
				eq(auditLog.organizationId, actor.organizationId),
				gte(auditLog.at, deadline),
				eq(auditLog.action, TWO_FACTOR_BLOCKED),
				eq(auditLog.actorId, actor.id),
			),
		)
		.limit(1);
	if (seen) return;
	// shortcut: check-then-insert, so two concurrent first requests can both write a row; harmless duplicate.
	await recordAudit(c, {
		action: TWO_FACTOR_BLOCKED,
		resourceId: memberId,
		diff: { deadline: deadline.toISOString() },
		outcome: "denied",
	});
}
