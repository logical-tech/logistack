import type { UpdateState, UpdateSteps } from "@logistack/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns.ts";
import { generatedDomainBase } from "./enums.ts";

export const instanceSettings = pgTable(
	"instance_settings",
	{
		id: text("id").primaryKey().default("singleton"),
		setupCompleted: boolean("setup_completed").notNull().default(false),
		publicUrl: text("public_url"),
		primaryDomain: text("primary_domain"),
		letsencryptEmail: text("letsencrypt_email"),
		generatedDomainBase: generatedDomainBase("generated_domain_base")
			.notNull()
			.default("sslip"),
		customWildcard: text("custom_wildcard"),
		/** Where Caddy gets certificates: `letsencrypt`, `letsencrypt-staging`, `zerossl` or `internal`. Parsed by the API. */
		acmeDirectory: text("acme_directory").notNull().default("letsencrypt"),
		localRegistryEnabled: boolean("local_registry_enabled")
			.notNull()
			.default(true),
		/** Lets server-side checks reach private, loopback and link-local addresses. */
		allowPrivateHosts: boolean("allow_private_hosts").notNull().default(false),
		/** The worker asks GitHub for the latest release once a day and emits `instance.update_available`. */
		autoCheckUpdates: boolean("auto_check_updates").notNull().default(true),
		/** Updates follow `staging` builds (GitHub prereleases), not only stable releases. */
		betaUpdates: boolean("beta_updates").notNull().default(false),
		...timestamps,
	},
	(t) => [
		check("instance_settings_singleton_check", sql`${t.id} = 'singleton'`),
	],
);

/** One in-app update of the stack's images, queued by the API and run by the worker's updater task. */
export const instanceUpdate = pgTable(
	"instance_update",
	{
		id: id("upd"),
		fromVersion: text("from_version").notNull(),
		toVersion: text("to_version").notNull(),
		state: text("state").$type<UpdateState>().notNull().default("queued"),
		steps: jsonb("steps").$type<UpdateSteps>().notNull().default({}),
		log: jsonb("log").$type<string[]>().notNull().default([]),
		error: text("error"),
		/** User id of the admin who started it. */
		requestedBy: text("requested_by"),
		...timestamps,
	},
	// One run at a time: two updaters would fight over the same services.
	(t) => [
		uniqueIndex("instance_update_one_active")
			.on(sql`(true)`)
			.where(sql`${t.state} in ('queued', 'running')`),
	],
);
