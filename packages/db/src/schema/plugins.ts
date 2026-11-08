import type {
	PluginIndexEntry,
	PluginIndexVersion,
	PluginManifest,
	PluginStatus,
} from "@logistack/contracts";
import {
	boolean,
	integer,
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
		/** The marketplace index it came from; null for an image or dev URL ("Unlisted"). */
		indexId: text("index_id").references(() => pluginIndex.id, {
			onDelete: "set null",
		}),
		/** The index marked this version reviewed when it was installed. */
		verified: boolean("verified").notNull().default(false),
		/** The index yanked this version (seen at the last refresh); a warning, never a removal. */
		yanked: boolean("yanked").notNull().default(false),
		/** What the last update replaced, for rollback. */
		previousImage: text("previous_image"),
		previousVersion: text("previous_version"),
		previousManifest: jsonb("previous_manifest").$type<PluginManifest>(),
		/** Deploy gate (phase 4): seconds a deploy waits for an answer, 1 to 60. */
		gateTimeoutSeconds: integer("gate_timeout_seconds").notNull().default(10),
		/** Deploy gate: go ahead when the plugin does not answer in time. */
		gateFailOpen: boolean("gate_fail_open").notNull().default(false),
		...timestamps,
	},
	(t) => [unique("plugin_install_org_plugin").on(t.organizationId, t.pluginId)],
);

/** What an index refresh caches: the listing, plus every version of a plugin once something needed them. */
export type PluginIndexCache = (PluginIndexEntry & {
	versions?: PluginIndexVersion[];
})[];

/**
 * A marketplace index this instance trusts (instance-wide). The official one is `builtin` and
 * kept in step with the server's config; private ones are added by an instance admin.
 */
export const pluginIndex = pgTable("plugin_index", {
	id: id("pidx"),
	url: text("url").notNull().unique(),
	name: text("name").notNull(),
	/** base64url raw Ed25519 public keys; an envelope's `keyId` must be one of them. */
	publicKeys: jsonb("public_keys").$type<string[]>().notNull(),
	builtin: boolean("builtin").notNull().default(false),
	fetchedAt: tstz("fetched_at"),
	entries: jsonb("entries").$type<PluginIndexCache>().notNull().default([]),
	lastError: text("last_error"),
	...timestamps,
});

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
