import type { DnsProviderKind } from "@logistack/contracts";
import type { z } from "zod";
import type { ProviderDef } from "../http.ts";
import { cloudflare } from "./cloudflare.ts";
import { digitalocean } from "./digitalocean.ts";
import { hetzner } from "./hetzner.ts";
import { ovh, ovhSignature } from "./ovh.ts";
import { porkbun } from "./porkbun.ts";
import { route53 } from "./route53.ts";
import { type DnsProvider, type DnsZone, normalizeName } from "./types.ts";

export * from "./propagation.ts";
export * from "./types.ts";
export {
	cloudflare,
	digitalocean,
	hetzner,
	ovh,
	ovhSignature,
	porkbun,
	route53,
};

export const dnsProviders = {
	cloudflare,
	route53,
	hetzner,
	digitalocean,
	ovh,
	porkbun,
} satisfies Record<DnsProviderKind, ProviderDef<z.ZodType, DnsProvider>>;
export type DnsKind = keyof typeof dnsProviders;
export type DnsConfig<K extends DnsKind> = z.infer<
	(typeof dnsProviders)[K]["configSchema"]
>;

/** The `provider` object of Caddy's `dns` challenge, field names as the caddy-dns modules read them. */
export type CaddyDnsProvider = { name: DnsKind } & Record<string, string>;

export function caddyDnsChallenge<K extends DnsKind>(
	kind: K,
	config: DnsConfig<K>,
): CaddyDnsProvider {
	// The casts are safe: K narrows config, TS just cannot correlate the two.
	switch (kind) {
		case "cloudflare": {
			const c = config as DnsConfig<"cloudflare">;
			return { name: "cloudflare", api_token: c.apiToken };
		}
		case "hetzner": {
			const c = config as DnsConfig<"hetzner">;
			return { name: "hetzner", api_token: c.apiToken };
		}
		case "route53": {
			const c = config as DnsConfig<"route53">;
			return {
				name: "route53",
				access_key_id: c.accessKeyId,
				secret_access_key: c.secretAccessKey,
				region: c.region,
			};
		}
		case "digitalocean": {
			const c = config as DnsConfig<"digitalocean">;
			return { name: "digitalocean", auth_token: c.apiToken };
		}
		case "ovh": {
			const c = config as DnsConfig<"ovh">;
			return {
				name: "ovh",
				endpoint: c.endpoint,
				application_key: c.applicationKey,
				application_secret: c.applicationSecret,
				consumer_key: c.consumerKey,
			};
		}
		case "porkbun": {
			const c = config as DnsConfig<"porkbun">;
			return {
				name: "porkbun",
				api_key: c.apiKey,
				api_secret_key: c.secretApiKey,
			};
		}
	}
	throw new Error(`no Caddy DNS module for ${kind}`);
}

/** The zone owning `hostname`: the longest zone name equal to it or a dot-suffix of it. */
export function findZoneForHostname<Z extends DnsZone>(
	hostname: string,
	zones: readonly Z[],
): Z | undefined {
	const host = normalizeName(hostname);
	let best: Z | undefined;
	for (const z of zones) {
		const name = normalizeName(z.name);
		if (host !== name && !host.endsWith(`.${name}`)) continue;
		if (!best || name.length > normalizeName(best.name).length) best = z;
	}
	return best;
}
