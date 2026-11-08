import { z } from "@hono/zod-openapi";
import { decrypt, encrypt } from "@logistack/core";
import { type Db, dnsProvider } from "@logistack/db";
import {
	type DnsKind,
	type DnsProvider,
	type DnsZone,
	dnsProviders,
	findZoneForHostname,
	instantiate,
	ProviderError,
	pluginDnsProvider,
} from "@logistack/providers";
import {
	openPluginProvider,
	type PluginProviderRef,
} from "@logistack/worker/plugin-providers";
import { and, asc, eq } from "drizzle-orm";
import { Failure, notFound } from "./errors.ts";
import { contributedProvider } from "./plugins.ts";

/** Built-in kinds; `plugin` rows resolve through the install that contributes them. */
export const dnsKinds = Object.keys(dnsProviders) as [DnsKind, ...DnsKind[]];
export const BuiltinDnsKindSchema = z.enum(dnsKinds);
export const DnsKindSchema = z.enum([...dnsKinds, "plugin"]);
export type AnyDnsKind = z.infer<typeof DnsKindSchema>;

export const Zone = z.object({ id: z.string(), name: z.string() });

export type DnsProviderRow = typeof dnsProvider.$inferSelect;

/** zones_cache holds the zones the user chose to manage, as `DnsZone[]`. */
export const managedZones = (row: Pick<DnsProviderRow, "zonesCache">) =>
	z.array(Zone).catch([]).parse(row.zonesCache);

/**
 * Credentials parsed with the kind's zod schema: defaults applied, stray fields dropped, so
 * this is what gets stored. A 400 with the issues when they don't fit.
 */
export function parseCredentials(kind: DnsKind, credentials: unknown): unknown {
	const parsed = dnsProviders[kind].configSchema.safeParse(credentials);
	if (!parsed.success)
		throw new Failure(
			"validation_failed",
			"credentials do not match the provider",
			parsed.error.issues,
		);
	return parsed.data;
}

export const connect = (kind: DnsKind, credentials: unknown): DnsProvider =>
	instantiate(dnsProviders[kind], parseCredentials(kind, credentials));

/** Runs a provider call; provider failures become 400s carrying the provider's message. */
export async function viaProvider<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ProviderError)
			throw new Failure("bad_request", err.message);
		throw err;
	}
}

export const sealCredentials = (key: CryptoKey, credentials: unknown) =>
	encrypt(key, JSON.stringify(credentials));

export type DnsDeps = { db: Db; masterKey: CryptoKey };

/** A plugin's DNS provider over its signed contract; "plugin disabled" when it is off. */
export const connectPlugin = async (
	deps: DnsDeps,
	ref: PluginProviderRef,
	credentials: unknown,
): Promise<DnsProvider> =>
	pluginDnsProvider(
		await openPluginProvider(deps, "dnsProviders", ref, credentials),
	);

export async function openProvider(deps: DnsDeps, row: DnsProviderRow) {
	const credentials = JSON.parse(
		await decrypt(deps.masterKey, row.credentialsEncrypted),
	);
	if (row.kind === "plugin") return connectPlugin(deps, row, credentials);
	if (!(row.kind in dnsProviders))
		throw new Failure("bad_request", `${row.kind} is not supported yet`);
	return connect(row.kind as DnsKind, credentials);
}

/**
 * A provider from wizard input, with the credentials as they will be stored and, for a plugin,
 * the row's plugin columns. The provider is not called yet.
 */
export async function connectInput(
	deps: DnsDeps,
	organizationId: string,
	input: {
		kind: AnyDnsKind;
		credentials: Record<string, unknown>;
		pluginInstallId?: string;
		pluginProvider?: string;
	},
) {
	if (input.kind === "plugin") {
		const p = await contributedProvider(
			deps.db,
			organizationId,
			"dnsProviders",
			input,
			input.credentials,
		);
		return {
			provider: await connectPlugin(
				deps,
				{ organizationId, ...p.columns },
				p.config,
			),
			credentials: p.config as unknown,
			columns: p.columns,
		};
	}
	return {
		provider: connect(input.kind, input.credentials),
		credentials: parseCredentials(input.kind, input.credentials),
		columns: {},
	};
}

export async function providerRow(
	db: Db,
	organizationId: string,
	id: string,
): Promise<DnsProviderRow> {
	const [row] = await db
		.select()
		.from(dnsProvider)
		.where(
			and(
				eq(dnsProvider.id, id),
				eq(dnsProvider.organizationId, organizationId),
			),
		);
	if (!row) throw notFound("dns provider");
	return row;
}

export type ZoneMatch = { provider: DnsProviderRow; zone: DnsZone };

/** The organization's provider managing the zone that owns `hostname`, longest zone first. */
export async function matchZone(
	db: Db,
	organizationId: string,
	hostname: string,
): Promise<ZoneMatch | null> {
	const rows = await db
		.select()
		.from(dnsProvider)
		.where(eq(dnsProvider.organizationId, organizationId))
		.orderBy(asc(dnsProvider.createdAt));
	let best: ZoneMatch | null = null;
	for (const provider of rows) {
		const zone = findZoneForHostname(hostname, managedZones(provider));
		if (zone && (!best || zone.name.length > best.zone.name.length))
			best = { provider, zone };
	}
	return best;
}
