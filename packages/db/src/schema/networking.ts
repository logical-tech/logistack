import type {
	AccessRule,
	DomainEdge,
	HomeDnsDesiredState,
	HomeDnsSettings,
	HomeDnsStatus,
} from "@logistack/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	unique,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { id, timestamps, tstz } from "./columns.ts";
import { certMode, dnsProviderKind, domainStatus } from "./enums.ts";
import { service } from "./hierarchy.ts";
import { pluginInstall } from "./plugins.ts";
import { node } from "./runtime.ts";

export const certificate = pgTable("certificate", {
	id: id("crt"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	certPem: text("cert_pem").notNull(),
	keyPemEncrypted: text("key_pem_encrypted").notNull(),
	notAfter: tstz("not_after").notNull(),
	sans: text("sans").array().notNull(),
	...timestamps,
});

export const dnsProvider = pgTable("dns_provider", {
	id: id("dns"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	kind: dnsProviderKind("kind").notNull(),
	name: text("name").notNull(),
	credentialsEncrypted: text("credentials_encrypted").notNull(),
	zonesCache: jsonb("zones_cache"),
	/** Kind `plugin`: the install contributing it and the provider's name in its manifest. */
	pluginInstallId: text("plugin_install_id").references(() => pluginInstall.id),
	pluginProvider: text("plugin_provider"),
	/** Kind `plugin`: encrypted basic-auth password Caddy's acmeproxy module sends to `/acme-proxy/<id>`. */
	acmeSecretEncrypted: text("acme_secret_encrypted"),
	...timestamps,
});

export const domain = pgTable(
	"domain",
	{
		id: id("dom"),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		hostname: text("hostname").notNull(),
		port: integer("port").notNull(),
		pathPrefix: text("path_prefix"),
		https: boolean("https").notNull().default(true),
		cert: certMode("cert").notNull().default("auto"),
		customCertificateId: text("custom_certificate_id").references(
			() => certificate.id,
			{ onDelete: "restrict" },
		),
		redirectTo: text("redirect_to"),
		isGenerated: boolean("is_generated").notNull().default(false),
		dnsProviderId: text("dns_provider_id").references(() => dnsProvider.id, {
			onDelete: "set null",
		}),
		dnsRecordId: text("dns_record_id"),
		/** Served through the Cloudflare Tunnel of `dnsProviderId` instead of a public port. */
		tunnel: boolean("tunnel").notNull().default(false),
		/** Caddy serves the first-party analytics script and beacon under `/_ls/` before the upstream. */
		webAnalytics: boolean("web_analytics").notNull().default(false),
		/** Checks the proxy runs before the upstream; basic auth holds bcrypt hashes only. */
		access: jsonb("access").$type<AccessRule[]>().notNull().default([]),
		/** Rate limit, block rules and custom error page the proxy applies before `access`. */
		edge: jsonb("edge").$type<Partial<DomainEdge>>().notNull().default({}),
		status: domainStatus("status").notNull().default("pending"),
		statusMessage: text("status_message"),
		...timestamps,
	},
	(t) => [
		// Routes are global in Caddy, so a hostname+path belongs to one service across all orgs.
		unique("domain_route_unique")
			.on(t.hostname, t.pathPrefix)
			.nullsNotDistinct(),
		index("domain_service_id_idx").on(t.serviceId),
	],
);

/** One Cloudflare Tunnel per Cloudflare DNS provider; the worker runs its cloudflared and ingress. */
export const cloudflareTunnel = pgTable("cloudflare_tunnel", {
	id: id("cft"),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	dnsProviderId: text("dns_provider_id")
		.notNull()
		.unique()
		.references(() => dnsProvider.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	accountId: text("account_id").notNull(),
	/** Cloudflare's tunnel UUID; CNAMEs point at `<tunnelId>.cfargotunnel.com`. */
	tunnelId: text("tunnel_id").notNull(),
	tokenEncrypted: text("token_encrypted").notNull(),
	statusMessage: text("status_message"),
	...timestamps,
});

/**
 * A hostname players use for a game server: an A/AAAA at the node's address, plus the SRV that
 * carries the port when the game reads one. Records are always DNS-only (Cloudflare's proxy
 * cannot carry game traffic); the ids are the provider's, kept to update and delete them.
 */
export const gameEndpoint = pgTable(
	"game_endpoint",
	{
		id: id("gep"),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		hostname: text("hostname").notNull().unique(),
		dnsProviderId: text("dns_provider_id").references(() => dnsProvider.id, {
			onDelete: "set null",
		}),
		addressRecordId: text("address_record_id"),
		srvRecordId: text("srv_record_id"),
		/** What the records point at when last written: `<address> <port>`; drift means a re-sync. */
		syncedTarget: text("synced_target"),
		status: domainStatus("status").notNull().default("pending"),
		statusMessage: text("status_message"),
		...timestamps,
	},
	(t) => [index("game_endpoint_service_id_idx").on(t.serviceId)],
);

/**
 * Tailscale for an organization: the worker runs tailscaled on every node with this auth key
 * (userspace networking, in-memory state, so an ephemeral key leaves nothing behind).
 */
export const tailscaleNetwork = pgTable("tailscale_network", {
	id: id("tsn"),
	organizationId: text("organization_id")
		.notNull()
		.unique()
		.references(() => organization.id, { onDelete: "cascade" }),
	authKeyEncrypted: text("auth_key_encrypted").notNull(),
	/** Swarm id of the per-node tailscaled, recorded by the worker; the test step execs into it. */
	nodeServiceId: text("node_service_id"),
	statusMessage: text("status_message"),
	...timestamps,
});

/** A service published on its own tailnet machine through `tailscale serve`. */
export const tailscalePublication = pgTable(
	"tailscale_publication",
	{
		id: id("tsp"),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serviceId: text("service_id")
			.notNull()
			.references(() => service.id, { onDelete: "cascade" }),
		/** The tailnet machine name; MagicDNS serves it as `<hostname>.<tailnet>.ts.net`. */
		hostname: text("hostname").notNull(),
		port: integer("port").notNull(),
		/** HTTPS on 443 with a tailnet certificate; otherwise plain HTTP on 80. */
		https: boolean("https").notNull().default(true),
		statusMessage: text("status_message"),
		...timestamps,
	},
	(t) => [
		unique("tailscale_publication_hostname").on(t.organizationId, t.hostname),
	],
);

/**
 * The instance's home DNS: one Technitium DNS Server on one node, owned by no organization.
 * `singleton` is always true, so its unique index allows one row.
 */
export const homeNetwork = pgTable(
	"home_network",
	{
		id: id("hdn"),
		singleton: boolean("singleton").notNull().default(true).unique(),
		nodeId: text("node_id")
			.notNull()
			.references(() => node.id, { onDelete: "cascade" }),
		lanAddress: text("lan_address").notNull(),
		desiredState: text("desired_state")
			.$type<HomeDnsDesiredState>()
			.notNull()
			.default("running"),
		status: text("status").$type<HomeDnsStatus>().notNull().default("starting"),
		statusMessage: text("status_message"),
		settings: jsonb("settings").$type<HomeDnsSettings>().notNull(),
		adminPasswordEncrypted: text("admin_password_encrypted").notNull(),
		/** Technitium API token the worker creates on first contact; null until then. */
		tokenEncrypted: text("token_encrypted"),
		/** Hash of the settings last applied to Technitium; a mismatch re-applies them. */
		appliedHash: text("applied_hash"),
		/** Swarm id of the Technitium service, recorded by the worker. */
		serviceId: text("service_id"),
		version: text("version"),
		...timestamps,
	},
	(t) => [check("home_network_singleton_true", sql`${t.singleton}`)],
);
