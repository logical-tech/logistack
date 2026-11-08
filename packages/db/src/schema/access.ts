import type { ScopeKind } from "@logistack/core";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	inet,
	pgTable,
	primaryKey,
	text,
	unique,
} from "drizzle-orm/pg-core";
import { member, organization, user } from "./auth.ts";
import { id, tstz } from "./columns.ts";

/**
 * A role held by a user (human member or machine) on one scope. The member's own
 * `member.role` stays the organization-wide default grant; these rows add to it.
 * `scope_id` is polymorphic, so a grant on a deleted folder or project lingers
 * harmlessly: no resource chain matches it any more.
 */
export const roleGrant = pgTable(
	"role_grant",
	{
		id: id("grt"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** A built-in role name or an `organization_role.role` of the same organization. */
		role: text("role").notNull(),
		scopeKind: text("scope_kind").$type<ScopeKind>().notNull(),
		scopeId: text("scope_id").notNull(),
		createdBy: text("created_by"),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [
		unique("role_grant_unique").on(t.userId, t.role, t.scopeKind, t.scopeId),
		index("role_grant_org_user_idx").on(t.organizationId, t.userId),
		check(
			"role_grant_scope_kind_check",
			sql`${t.scopeKind} in ('organization', 'folder', 'project', 'environment', 'service')`,
		),
	],
);

/** Where an API key was last used from; better-auth's `apikey` keeps only the time. */
export const apiKeyUsage = pgTable("api_key_usage", {
	keyId: text("key_id").primaryKey(),
	lastIp: inet("last_ip"),
	lastUsedAt: tstz("last_used_at").defaultNow().notNull(),
});

/**
 * One row per member and two-factor lockout (its deadline): the key makes the "blocked" audit row
 * write exactly once even when the member's first requests after the deadline race.
 */
export const twoFactorLockout = pgTable(
	"two_factor_lockout",
	{
		memberId: text("member_id")
			.notNull()
			.references(() => member.id, { onDelete: "cascade" }),
		deadline: tstz("deadline").notNull(),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.memberId, t.deadline] })],
);
