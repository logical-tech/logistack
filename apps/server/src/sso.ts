import { type Db, member, organization } from "@logistack/db";
import { and, eq, sql } from "drizzle-orm";
import { log } from "./log.ts";

/*
 * The role an SSO sign-in joins with lives in `organization.metadata` (better-auth's JSON text
 * column) as `{"ssoDefaultRoles": {"<providerId>": "<role>"}}`: no table of our own, no migration.
 */

const metadataJson = sql`coalesce(${organization.metadata}::jsonb, '{}'::jsonb)`;

export async function setDefaultRole(
	db: Db,
	organizationId: string,
	providerId: string,
	role: string,
) {
	await db
		.update(organization)
		.set({
			metadata: sql`(${metadataJson} || jsonb_build_object('ssoDefaultRoles', coalesce(${metadataJson}->'ssoDefaultRoles', '{}'::jsonb) || jsonb_build_object(${providerId}::text, ${role}::text)))::text`,
		})
		.where(eq(organization.id, organizationId));
}

export async function clearDefaultRole(
	db: Db,
	organizationId: string,
	providerId: string,
) {
	await db
		.update(organization)
		.set({
			metadata: sql`(${metadataJson} #- array['ssoDefaultRoles', ${providerId}::text])::text`,
		})
		.where(eq(organization.id, organizationId));
}

/** Provider id to default role, for one organization. */
export async function defaultRoles(
	db: Db,
	organizationId: string,
): Promise<Record<string, string>> {
	const [row] = await db
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, organizationId));
	try {
		const roles = JSON.parse(row?.metadata ?? "{}")?.ssoDefaultRoles;
		return roles && typeof roles === "object" ? roles : {};
	} catch {
		return {};
	}
}

/** The lowercase domains of a provider's comma-separated `domain` column. */
const providerDomains = (domain: string) =>
	domain
		.split(",")
		.map((d) => d.trim().toLowerCase())
		.filter(Boolean);

export type SsoJoin = "joined" | "already-member" | "skipped";

/**
 * Runs after every SSO sign-in: a user whose email domain is one of the provider's joins the
 * provider's organization with the role the admin chose. Members keep their current role.
 */
export async function joinOrganization(
	db: Db,
	user: { id: string; email: string },
	provider: {
		providerId: string;
		organizationId?: string | null;
		domain: string;
	},
): Promise<SsoJoin> {
	const organizationId = provider.organizationId;
	const emailDomain = user.email.toLowerCase().split("@")[1];
	if (
		!organizationId ||
		!emailDomain ||
		!providerDomains(provider.domain).includes(emailDomain)
	)
		return "skipped";
	const role = (await defaultRoles(db, organizationId))[provider.providerId];
	if (!role) return "skipped";
	const existing = await db.$count(
		member,
		and(eq(member.organizationId, organizationId), eq(member.userId, user.id)),
	);
	if (existing > 0) return "already-member";
	// shortcut: no unique (organization, user) index; two first sign-ins racing could both insert, add the index if that is ever seen.
	await db.insert(member).values({
		id: crypto.randomUUID(),
		organizationId,
		userId: user.id,
		role,
		createdAt: new Date(),
	});
	log("info", "sso user joined organization", {
		userId: user.id,
		organizationId,
		providerId: provider.providerId,
		role,
	});
	return "joined";
}
