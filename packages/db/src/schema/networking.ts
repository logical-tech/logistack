import type { AccessRule } from "@logistack/contracts";
import {
	boolean,
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
		/** Checks the proxy runs before the upstream; basic auth holds bcrypt hashes only. */
		access: jsonb("access").$type<AccessRule[]>().notNull().default([]),
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
