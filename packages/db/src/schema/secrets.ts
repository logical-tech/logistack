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
import { secretProviderKind, secretScope } from "./enums.ts";
import { pluginInstall } from "./plugins.ts";

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

/** An external secret manager (Vault, Infisical, 1Password Connect) external secrets read from. */
export const secretProvider = pgTable(
	"secret_provider",
	{
		id: id("ssp"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		kind: secretProviderKind("kind").notNull(),
		/** Written in references: `secret://<name>/...`. */
		name: text("name").notNull(),
		/** For display; the copy inside the config is the one used. */
		url: text("url").notNull(),
		// Encrypted JSON document (v1:<iv>:<ct>): the config carries the credentials.
		configEncrypted: text("config_encrypted").notNull(),
		/** Kind `plugin`: the install contributing it and the provider's name in its manifest. */
		pluginInstallId: text("plugin_install_id").references(
			() => pluginInstall.id,
		),
		pluginProvider: text("plugin_provider"),
		...timestamps,
	},
	(t) => [unique("secret_provider_name_unique").on(t.organizationId, t.name)],
);

/**
 * A secret at one scope. A managed one keeps its value in `secret_version`; an external one
 * (`provider_id` set) is read from the provider at deploy time and stores no value at all.
 */
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
		/** 0 for an external secret, which has no versions. */
		currentVersion: integer("current_version").notNull(),
		providerId: text("provider_id").references(() => secretProvider.id, {
			onDelete: "restrict",
		}),
		/** `<path>#<key>`, percent-encoded, after `secret://<provider name>/`. */
		externalRef: text("external_ref"),
		/** Keyed hash of the value last read, so a changed value shows as a pending change. Never the value. */
		externalFingerprint: text("external_fingerprint"),
		externalCheckedAt: tstz("external_checked_at"),
		externalError: text("external_error"),
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
