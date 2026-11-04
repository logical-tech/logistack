import type { DnsRecordType } from "@logistack/contracts";

export {
	DnsRecordType,
	dnsRecordTypes,
	isDnsRecordType,
} from "@logistack/contracts";

/** Names are lowercase FQDNs without the trailing dot. */
export type DnsZone = { id: string; name: string };

export type DnsRecord = {
	/** Opaque, provider-specific; pass it back to `deleteRecord`. */
	id: string;
	zoneId: string;
	name: string;
	type: DnsRecordType;
	/** TXT content is unquoted. */
	content: string;
	ttl: number;
	proxied?: boolean;
	/** Cloudflare's per-record note. */
	comment?: string;
	/** Set when LogiStack can show but not change the record, with the reason (e.g. a Route 53 alias). */
	readOnly?: string;
};

export type UpsertRecordInput = Omit<DnsRecord, "id" | "comment" | "readOnly">;

/** A whole (name, type) record set. Values use the presentation format described in contracts/dns.ts. */
export type RecordSetInput = {
	zoneId: string;
	name: string;
	type: DnsRecordType;
	ttl: number;
	values: string[];
	proxied?: boolean;
	comment?: string;
};

export interface DnsProvider {
	/** Throws ProviderError when the credentials cannot list zones. */
	verify(): Promise<void>;
	listZones(): Promise<DnsZone[]>;
	/**
	 * Records of the types in `dnsRecordTypes`, one entry per value; values of one set share `id`
	 * (on Cloudflare every record is its own set). `name` filters to that exact FQDN.
	 */
	listRecords(zoneId: string, name?: string): Promise<DnsRecord[]>;
	/** Sets the (name, type) record set to exactly this one value, creating or replacing it. */
	upsertRecord(input: UpsertRecordInput): Promise<DnsRecord>;
	/** Creates a set; fails when (name, type) already exists on providers that address sets. Cloudflare takes one value. */
	createRecord(input: RecordSetInput): Promise<DnsRecord[]>;
	/** Replaces the set `recordId` points at with `input`, renaming it when name or type changed. */
	updateRecord(recordId: string, input: RecordSetInput): Promise<DnsRecord[]>;
	/** Deletes the whole set `recordId` points at. Deleting a record that no longer exists succeeds. */
	deleteRecord(zoneId: string, recordId: string): Promise<void>;
}

export const normalizeName = (name: string) =>
	name.trim().toLowerCase().replace(/\.+$/, "");

/** Joins the quoted chunks of a TXT value (`"a" "b"` → `ab`); a bare value passes through. */
export const unquoteTxt = (v: string) =>
	v.startsWith('"')
		? [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
				.map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1"))
				.join("")
		: v;

/** Quotes TXT text as 255-character strings (`"a…" "b…"`), the longest a single TXT string may be. */
export const quoteTxt = (v: string) =>
	(v.match(/[\s\S]{1,255}/g) ?? [""])
		.map((c) => `"${c.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
		.join(" ");

/** Types whose value ends in a hostname (CNAME, NS, MX, SRV). */
const targetTypes: readonly string[] = ["CNAME", "NS", "MX", "SRV"];

/** Rewrites the hostname at the end of a CNAME/NS/MX/SRV value; other values pass through. */
export function mapTarget(
	type: string,
	value: string,
	fn: (host: string) => string,
): string {
	if (!targetTypes.includes(type)) return value;
	const i = value.lastIndexOf(" ") + 1;
	const host = value.slice(i);
	return host === "." ? value : value.slice(0, i) + fn(host);
}
export const withDot = (h: string) => (h.endsWith(".") ? h : `${h}.`);
export const withoutDot = (h: string) => h.replace(/\.$/, "");
