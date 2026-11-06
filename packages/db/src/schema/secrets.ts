import { sql } from "drizzle-orm";
import {
	index,
	integer,
	pgTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";
import { secretScope } from "./enums.ts";

/**
 * Per-organization data keys (DEK), wrapped by the KEK derived from the master key.
 * Exactly one `active` version per organization encrypts new secret versions.
 */
export const secretKey = pgTable(
	"secret_key",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		/** `v2` ciphertext of the 32-byte key, AAD `secret_key:<org>:<version>`. */
		wrappedKey: text("wrapped_key").notNull(),
		status: text("status").$type<"active" | "retired">().notNull(),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [
		unique("secret_key_version_unique").on(t.organizationId, t.version),
		uniqueIndex("secret_key_one_active_idx")
			.on(t.organizationId)
			.where(sql`${t.status} = 'active'`),
	],
);

/** A managed secret at one scope. Its value lives in `secret_version`. */
export const secret = pgTable(
	"secret",
	{
		id: id("sec"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		scope: secretScope("scope").notNull(),
		// Polymorphic: organization, folder, project, environment or service id depending on `scope`.
		scopeId: text("scope_id").notNull(),
		key: text("key").notNull(),
		description: text("description"),
		currentVersion: integer("current_version").notNull(),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		updatedBy: text("updated_by").references(() => user.id, {
			onDelete: "set null",
		}),
		...timestamps,
	},
	(t) => [
		unique("secret_key_unique").on(t.scope, t.scopeId, t.key),
		index("secret_organization_idx").on(t.organizationId),
	],
);

/** Append-only history of a secret's values. */
export const secretVersion = pgTable(
	"secret_version",
	{
		id: id("sev"),
		secretId: text("secret_id")
			.notNull()
			.references(() => secret.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		/** `v2` ciphertext under the org's data key `dekVersion`, AAD `secret_version:<org>:<secret>:<version>`. */
		valueEncrypted: text("value_encrypted").notNull(),
		dekVersion: integer("dek_version").notNull(),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: tstz("created_at").defaultNow().notNull(),
	},
	(t) => [unique("secret_version_unique").on(t.secretId, t.version)],
);
