import type { PluginManifest, PluginStatus } from "@logistack/contracts";
import {
	boolean,
	jsonb,
	pgTable,
	primaryKey,
	text,
	unique,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";

/**
 * One plugin installed in one organization (docs/plans/plugins.md). The worker runs it as the
 * Swarm service `ls-plg-<id body>`; a `dev_url` install has no container and is called there.
 */
export const pluginInstall = pgTable(
	"plugin_install",
	{
		id: id("plg"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** The manifest's reverse-DNS id. */
		pluginId: text("plugin_id").notNull(),
		version: text("version").notNull(),
		/** `repo@sha256:…`, never a tag; null for a dev-URL install. */
		image: text("image"),
		/** `https://…` of a plugin running elsewhere, for development. */
		devUrl: text("dev_url"),
		manifest: jsonb("manifest").$type<PluginManifest>().notNull(),
		/** Registry credentials used to pull `image`, when private. */
		registryId: text("registry_id"),
		/** Encrypted JSON of the settings form (v1 envelope); secrets are never returned in clear. */
		configEncrypted: text("config_encrypted").notNull(),
		/** The machine user whose API key the plugin holds. */
		serviceAccountId: text("service_account_id").references(() => user.id, {
			onDelete: "set null",
		}),
		/** Encrypted `lsk_` key handed to the container as `LOGISTACK_TOKEN`. */
		tokenEncrypted: text("token_encrypted"),
		/** Encrypted HMAC key of the requests LogiStack signs to the plugin. */
		signingSecretEncrypted: text("signing_secret_encrypted").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		status: text("status").$type<PluginStatus>().notNull().default("pending"),
		statusMessage: text("status_message"),
		/** User id of whoever installed it. */
		installedBy: text("installed_by"),
		...timestamps,
	},
	(t) => [unique("plugin_install_org_plugin").on(t.organizationId, t.pluginId)],
);

/** UI state a plugin page keeps over the bridge, per user and install. Not for secrets. */
export const pluginUiStorage = pgTable(
	"plugin_ui_storage",
	{
		installId: text("install_id")
			.notNull()
			.references(() => pluginInstall.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		value: jsonb("value").$type<unknown>().notNull(),
		updatedAt: tstz("updated_at").defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.installId, t.userId, t.key] })],
);
