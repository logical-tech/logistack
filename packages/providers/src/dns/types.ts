export const dnsRecordTypes = ["A", "AAAA", "CNAME", "TXT"] as const;
export type DnsRecordType = (typeof dnsRecordTypes)[number];
export const isDnsRecordType = (t: string): t is DnsRecordType =>
	(dnsRecordTypes as readonly string[]).includes(t);

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
};

export type UpsertRecordInput = Omit<DnsRecord, "id">;

export interface DnsProvider {
	/** Throws ProviderError when the credentials cannot list zones. */
	verify(): Promise<void>;
	listZones(): Promise<DnsZone[]>;
	/** Only A, AAAA, CNAME and TXT records; `name` filters to that exact FQDN. */
	listRecords(zoneId: string, name?: string): Promise<DnsRecord[]>;
	/** Sets the (name, type) record set to exactly this one value, creating or replacing it. */
	upsertRecord(input: UpsertRecordInput): Promise<DnsRecord>;
	/** Deleting a record that no longer exists succeeds. */
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

// shortcut: values over 255 bytes are sent as one chunk, split them if DKIM-sized TXT records ever go through here.
export const quoteTxt = (v: string) =>
	`"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
