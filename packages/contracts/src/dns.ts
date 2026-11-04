import { z } from "zod";

/*
 * DNS records as LogiStack speaks them, shared by the providers, the API and the record editor.
 * A record set is (name, type) with one or more values. Each value is in zone-file presentation
 * format without trailing dots: `10 mail.example.com` (MX), `10 5 5060 sip.example.com` (SRV),
 * `0 issue "letsencrypt.org"` (CAA). TXT values are the unquoted text.
 */

export const dnsRecordTypes = [
	"A",
	"AAAA",
	"CNAME",
	"TXT",
	"MX",
	"SRV",
	"CAA",
	"NS",
] as const;
export const DnsRecordType = z.enum(dnsRecordTypes);
export type DnsRecordType = z.infer<typeof DnsRecordType>;
export const isDnsRecordType = (t: string): t is DnsRecordType =>
	(dnsRecordTypes as readonly string[]).includes(t);

/** Types Cloudflare can serve through its proxy (the orange cloud). */
export const proxiableTypes: readonly DnsRecordType[] = ["A", "AAAA", "CNAME"];

/** TTL bounds per provider kind, in seconds. `auto` is the value meaning "provider decides". */
export const dnsTtlRules: Record<
	string,
	{ min: number; max: number; auto?: number }
> = {
	cloudflare: { min: 60, max: 86_400, auto: 1 },
	route53: { min: 0, max: 2_147_483_647 },
	hetzner: { min: 60, max: 2_147_483_647 },
};

/** The fields each type's value is made of, in presentation order. */
export const dnsValueParts = {
	A: ["address"],
	AAAA: ["address"],
	CNAME: ["target"],
	NS: ["target"],
	TXT: ["text"],
	MX: ["priority", "target"],
	SRV: ["priority", "weight", "port", "target"],
	CAA: ["flags", "tag", "value"],
} as const satisfies Record<DnsRecordType, readonly string[]>;

export type DnsValueParts = Record<string, string>;

/** Splits a presentation value into its named parts; the last part takes the rest of the line. */
export function parseDnsValue(
	type: DnsRecordType,
	value: string,
): DnsValueParts {
	const keys = dnsValueParts[type];
	const out: DnsValueParts = {};
	let rest = value.trim();
	keys.forEach((k, i) => {
		if (i === keys.length - 1) {
			out[k] =
				type === "CAA" && rest.startsWith('"') && rest.endsWith('"')
					? rest.slice(1, -1).replace(/\\(.)/g, "$1")
					: rest;
			return;
		}
		const m = /^(\S*)\s*/.exec(rest);
		out[k] = m?.[1] ?? "";
		rest = rest.slice(m?.[0].length ?? 0);
	});
	return out;
}

export function formatDnsValue(
	type: DnsRecordType,
	parts: DnsValueParts,
): string {
	return dnsValueParts[type]
		.map((k) => {
			const v = (parts[k] ?? "").trim();
			if (type === "CAA" && k === "value")
				return `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
			return k === "target" ? v.replace(/\.$/, "") : v;
		})
		.join(" ");
}

const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/i;
const isHost = (v: string) => {
	const name = v.replace(/\.$/, "");
	return (
		name.length > 0 &&
		name.length <= 253 &&
		name.split(".").every((l) => LABEL.test(l))
	);
};
const isIpv4 = (v: string) =>
	/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(
		v,
	);
const isIpv6 = (v: string) => {
	if (!/^[0-9a-f:.]+$/i.test(v) || !v.includes(":")) return false;
	try {
		new URL(`http://[${v}]`);
		return true;
	} catch {
		return false;
	}
};
const inRange = (v: string | undefined, max: number) =>
	/^\d+$/.test(v ?? "") && Number(v) <= max;

/** What is wrong with one value of a `type` record, keyed by part; empty when it is valid. */
export function dnsValueIssues(
	type: DnsRecordType,
	value: string,
): Partial<Record<string, string>> {
	const p = parseDnsValue(type, value);
	const issues: Partial<Record<string, string>> = {};
	const host = (k: string, allowRoot = false) => {
		const v = p[k] ?? "";
		if (!(isHost(v) || (allowRoot && v === ".")))
			issues[k] = "Enter a hostname";
	};
	const u16 = (k: string) => {
		if (!inRange(p[k], 65_535)) issues[k] = "0 to 65535";
	};
	switch (type) {
		case "A":
			if (!isIpv4(p.address ?? "")) issues.address = "Enter an IPv4 address";
			break;
		case "AAAA":
			if (!isIpv6(p.address ?? "")) issues.address = "Enter an IPv6 address";
			break;
		case "CNAME":
		case "NS":
			host("target");
			break;
		case "TXT":
			if (!p.text) issues.text = "Enter the text";
			else if (p.text.length > 4096) issues.text = "At most 4096 characters";
			break;
		case "MX":
			u16("priority");
			host("target", true);
			break;
		case "SRV":
			u16("priority");
			u16("weight");
			u16("port");
			host("target", true);
			break;
		case "CAA":
			if (!inRange(p.flags, 255)) issues.flags = "0 to 255";
			if (!/^[a-z0-9]{1,15}$/i.test(p.tag ?? "")) issues.tag = "Pick a tag";
			if (!p.value && p.tag !== "issue" && p.tag !== "issuewild")
				issues.value = "Enter a value";
			break;
	}
	return issues;
}

/** A record name: an FQDN, `*.` allowed as the first label, `_service` labels allowed. */
export const isDnsName = (name: string) =>
	isHost(name.replace(/^\*\./, "")) || name === "*";

export const DnsRecordSetInput = z.object({
	/** FQDN inside the zone, without the trailing dot. */
	name: z
		.string()
		.trim()
		.toLowerCase()
		.transform((n) => n.replace(/\.$/, ""))
		.refine(isDnsName, "invalid record name"),
	type: DnsRecordType,
	ttl: z.int().min(0).max(2_147_483_647),
	values: z.array(z.string().trim().min(1)).min(1).max(100),
	/** Cloudflare only, A/AAAA/CNAME only. */
	proxied: z.boolean().optional(),
	/** Cloudflare only. */
	comment: z.string().trim().max(100).optional(),
});
export type DnsRecordSetInput = z.infer<typeof DnsRecordSetInput>;

/**
 * Checks a record set against the rules of the zone and provider kind holding it.
 * Returns `[path, message]` pairs; `path` is `name`, `ttl`, `proxied`, `values` or `values.<i>.<part>`.
 */
export function dnsRecordSetIssues(
	kind: string,
	zoneName: string,
	input: DnsRecordSetInput,
): [string, string][] {
	const out: [string, string][] = [];
	if (input.name !== zoneName && !input.name.endsWith(`.${zoneName}`))
		out.push(["name", `Must be inside ${zoneName}`]);
	if (input.type === "CNAME" && input.name === zoneName)
		out.push(["name", "A CNAME can't sit at the zone apex"]);
	const ttl = dnsTtlRules[kind];
	if (
		ttl &&
		input.ttl !== ttl.auto &&
		(input.ttl < ttl.min || input.ttl > ttl.max)
	)
		out.push([
			"ttl",
			`Between ${ttl.min} and ${ttl.max} seconds${ttl.auto ? ", or Auto" : ""}`,
		]);
	if (
		input.proxied &&
		(kind !== "cloudflare" || !proxiableTypes.includes(input.type))
	)
		out.push([
			"proxied",
			"Only Cloudflare A, AAAA and CNAME records can be proxied",
		]);
	if (kind === "cloudflare" && input.values.length > 1)
		out.push(["values", "Cloudflare holds one value per record"]);
	if (input.type === "CNAME" && input.values.length > 1)
		out.push(["values", "A CNAME has exactly one target"]);
	input.values.forEach((v, i) => {
		for (const [part, msg] of Object.entries(dnsValueIssues(input.type, v)))
			if (msg) out.push([`values.${i}.${part}`, msg]);
	});
	return out;
}
