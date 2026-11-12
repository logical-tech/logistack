import { z } from "zod";
import { dnsValueIssues, isDnsName } from "./dns.ts";

/*
 * Home DNS: one Technitium DNS Server per installation, run by the worker on a chosen node.
 * LogiStack owns the settings below (Postgres, reconciled); zones, records and the allow/block
 * lists live in Technitium and the API passes them through.
 */

/** Technitium's web console and API, on the node's host network. */
export const TECHNITIUM_PORT = 5380;

/** The block list the installer and the CLI turn on by default (Hagezi Pro, wildcard domains). */
export const HOME_DNS_DEFAULT_BLOCKLIST =
	"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro-onlydomains.txt";

/** What the instance admin asked for. `removed` tears it down and deletes its data volume. */
export const HomeDnsDesiredState = z.enum(["running", "stopped", "removed"]);
export type HomeDnsDesiredState = z.infer<typeof HomeDnsDesiredState>;

/** What the worker observed; transitions go through `advanceHomeDns` in @logistack/core. */
export const HomeDnsStatus = z.enum([
	"starting",
	"configuring",
	"ready",
	"error",
	"stopped",
]);
export type HomeDnsStatus = z.infer<typeof HomeDnsStatus>;

export const HomeDnsUpstreamProtocol = z.enum(["Udp", "Tls", "Https"]);
export type HomeDnsUpstreamProtocol = z.infer<typeof HomeDnsUpstreamProtocol>;

// Technitium takes these lists comma-separated, so a comma would smuggle in another entry.
const NoComma = z
	.string()
	.trim()
	.min(1)
	.max(500)
	.regex(/^[^,]+$/, "must not contain a comma");

const Hostname = z
	.string()
	.trim()
	.toLowerCase()
	.transform((n) => n.replace(/\.$/, ""))
	.refine((n) => isDnsName(n) && !n.startsWith("*"), "enter a domain name");

const Upstream = z.object({
	/** Technitium's name server format: `1.1.1.1`, `dns.quad9.net (9.9.9.9:853)`, `https://cloudflare-dns.com/dns-query (1.1.1.1)`. */
	servers: z.array(NoComma).min(1).max(8),
	protocol: HomeDnsUpstreamProtocol,
});

export const HomeDnsBlocking = z.object({
	enabled: z.boolean().default(true),
	/** Hosts files or plain domain lists, refreshed by Technitium every 24 hours. */
	listUrls: z
		.array(NoComma.pipe(z.url({ protocol: /^https?$/ })))
		.max(50)
		.default([]),
});
export type HomeDnsBlocking = z.infer<typeof HomeDnsBlocking>;

/** A primary zone the worker creates when missing (`home.lan`); null for none. */
const LocalZone = Hostname.nullable();

export const HomeDnsSettings = z.object({
	upstream: Upstream.default({
		servers: ["https://cloudflare-dns.com/dns-query (1.1.1.1)"],
		protocol: "Https",
	}),
	dnssecValidation: z.boolean().default(true),
	blocking: HomeDnsBlocking.default({ enabled: true, listUrls: [] }),
	localZone: LocalZone.default(null),
});
export type HomeDnsSettings = z.infer<typeof HomeDnsSettings>;

export const Ipv4 = z.ipv4();

/** The public view; every field but `enabled` is null while the feature is off. */
export const HomeDns = z.object({
	enabled: z.boolean(),
	nodeId: z.string().nullable(),
	nodeHostname: z.string().nullable(),
	/** The address devices use as their DNS server. */
	lanAddress: z.string().nullable(),
	desiredState: HomeDnsDesiredState.nullable(),
	status: HomeDnsStatus.nullable(),
	statusMessage: z.string().nullable(),
	settings: HomeDnsSettings.nullable(),
	/** Technitium's version once its API answered. */
	version: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type HomeDns = z.infer<typeof HomeDns>;

export const HomeDnsEnableInput = z.object({
	nodeId: z.string().min(1),
	lanAddress: Ipv4,
	settings: HomeDnsSettings.default(HomeDnsSettings.parse({})),
});
export type HomeDnsEnableInput = z.infer<typeof HomeDnsEnableInput>;

export const HomeDnsUpdateInput = z
	.object({
		nodeId: z.string().min(1),
		lanAddress: Ipv4,
		/** Replaces only the top-level keys given. */
		settings: z
			.object({
				upstream: Upstream,
				dnssecValidation: z.boolean(),
				blocking: HomeDnsBlocking,
				localZone: LocalZone,
			})
			.partial(),
		desiredState: HomeDnsDesiredState.exclude(["removed"]),
	})
	.partial()
	.refine((o) => Object.keys(o).length > 0, "nothing to update");
export type HomeDnsUpdateInput = z.infer<typeof HomeDnsUpdateInput>;

export const HomeDnsDomainInput = z.object({ domain: Hostname });

export const HomeDnsTestInput = z.object({ name: Hostname });
export const HomeDnsTestResult = z.object({
	name: z.string(),
	/** Technitium answered from a blocked zone or a block list. */
	blocked: z.boolean(),
	rcode: z.string(),
	answers: z.array(z.object({ type: z.string(), data: z.string() })),
});
export type HomeDnsTestResult = z.infer<typeof HomeDnsTestResult>;

export const HomeDnsConsole = z.object({
	url: z.string(),
	username: z.string(),
	password: z.string(),
});

export const HomeDnsStatsRange = z.enum([
	"hour",
	"day",
	"week",
	"month",
	"year",
]);
export type HomeDnsStatsRange = z.infer<typeof HomeDnsStatsRange>;

const Top = z.object({
	name: z.string(),
	/** Reverse-lookup name of a client, when Technitium found one. */
	domain: z.string().optional(),
	hits: z.number(),
});

export const HomeDnsStats = z.object({
	totals: z.object({
		queries: z.number(),
		noError: z.number(),
		serverFailure: z.number(),
		nxDomain: z.number(),
		refused: z.number(),
		authoritative: z.number(),
		recursive: z.number(),
		cached: z.number(),
		blocked: z.number(),
		dropped: z.number(),
		clients: z.number(),
	}),
	/** One point per label; labels are UTC timestamps. */
	chart: z.object({
		labels: z.array(z.string()),
		series: z.array(z.object({ label: z.string(), data: z.array(z.number()) })),
	}),
	topClients: z.array(Top),
	topDomains: z.array(Top),
	topBlocked: z.array(Top),
});
export type HomeDnsStats = z.infer<typeof HomeDnsStats>;

export const HomeDnsResponseType = z.enum([
	"Authoritative",
	"Recursive",
	"Cached",
	"Blocked",
	"UpstreamBlocked",
	"CacheBlocked",
]);

export const HomeDnsLogQuery = z.object({
	page: z.coerce.number().int().min(1).default(1),
	perPage: z.coerce.number().int().min(1).max(500).default(50),
	client: z.ipv4().or(z.ipv6()).optional(),
	domain: z.string().trim().min(1).max(253).optional(),
	responseType: HomeDnsResponseType.optional(),
	start: z.iso.datetime({ offset: true }).optional(),
	end: z.iso.datetime({ offset: true }).optional(),
});
export type HomeDnsLogQuery = z.infer<typeof HomeDnsLogQuery>;

export const HomeDnsLogPage = z.object({
	page: z.number(),
	totalPages: z.number(),
	totalEntries: z.number(),
	entries: z.array(
		z.object({
			timestamp: z.string(),
			client: z.string(),
			protocol: z.string(),
			responseType: z.string(),
			rcode: z.string(),
			domain: z.string(),
			type: z.string(),
			answer: z.string(),
			rttMs: z.number().nullable(),
		}),
	),
});
export type HomeDnsLogPage = z.infer<typeof HomeDnsLogPage>;

export const HomeDnsZone = z.object({
	name: z.string(),
	type: z.string(),
	disabled: z.boolean(),
});
export type HomeDnsZone = z.infer<typeof HomeDnsZone>;

export const HomeDnsZoneInput = z.object({ name: Hostname });

export const homeDnsRecordTypes = [
	"A",
	"AAAA",
	"CNAME",
	"TXT",
	"MX",
	"SRV",
	"PTR",
] as const;
export const HomeDnsRecordType = z.enum(homeDnsRecordTypes);
export type HomeDnsRecordType = z.infer<typeof HomeDnsRecordType>;

/**
 * `content` uses the presentation format of `contracts/dns.ts` (`10 mail.home.lan` for MX,
 * `10 5 5060 sip.home.lan` for SRV); a PTR's content is its target name.
 */
export const HomeDnsRecordInput = z
	.object({
		name: Hostname,
		type: HomeDnsRecordType,
		content: z.string().trim().min(1).max(4096),
		ttl: z.int().min(0).max(604_800).default(3600),
		comment: z.string().trim().max(200).optional(),
	})
	.superRefine((r, ctx) => {
		const issues =
			r.type === "PTR"
				? isDnsName(r.content.replace(/\.$/, ""))
					? {}
					: { target: "Enter a hostname" }
				: dnsValueIssues(r.type, r.content);
		for (const [part, message] of Object.entries(issues))
			ctx.addIssue({
				code: "custom",
				path: ["content"],
				message: `${part}: ${message}`,
			});
	});
export type HomeDnsRecordInput = z.infer<typeof HomeDnsRecordInput>;

export const HomeDnsRecord = z.object({
	/** Opaque: encodes name, type and content, which is how Technitium addresses a record. */
	id: z.string(),
	name: z.string(),
	type: HomeDnsRecordType,
	content: z.string(),
	ttl: z.number(),
	comment: z.string().optional(),
	disabled: z.boolean(),
});
export type HomeDnsRecord = z.infer<typeof HomeDnsRecord>;

type RecordKey = Pick<HomeDnsRecord, "name" | "type" | "content">;

export const homeDnsRecordId = (r: RecordKey) =>
	new TextEncoder()
		.encode(JSON.stringify([r.name, r.type, r.content]))
		.toBase64({ alphabet: "base64url", omitPadding: true });

/** Undefined when `id` was not made by `homeDnsRecordId`. */
export function parseHomeDnsRecordId(id: string): RecordKey | undefined {
	try {
		const [name, type, content] = JSON.parse(
			new TextDecoder().decode(
				Uint8Array.fromBase64(id, { alphabet: "base64url" }),
			),
		);
		const t = HomeDnsRecordType.safeParse(type);
		if (typeof name !== "string" || typeof content !== "string" || !t.success)
			return undefined;
		return { name, type: t.data, content };
	} catch {
		return undefined;
	}
}
