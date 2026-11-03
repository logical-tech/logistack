import { z } from "zod";
import { defineProvider, Http, ProviderError, secret } from "../http.ts";
import { signV4 } from "../sigv4.ts";
import {
	type DnsProvider,
	type DnsRecord,
	type DnsRecordType,
	isDnsRecordType,
	normalizeName,
	quoteTxt,
	unquoteTxt,
} from "./types.ts";

const API = "https://route53.amazonaws.com/2013-04-01";

export const route53Config = z.object({
	accessKeyId: z.string().min(1),
	secretAccessKey: secret(),
	/** Route53 itself is global; caddy-dns/route53 still wants a region for its client. */
	region: z.string().min(1).default("us-east-1"),
});
export type Route53Config = z.infer<typeof route53Config>;

// Route53 answers in a flat, namespace-only XML; these few tags are all we read.
const tags = (xml: string, tag: string) =>
	[...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(
		(m) => m[1] ?? "",
	);
const tag = (xml: string, name: string) => tags(xml, name)[0];
const unescapeXml = (s: string) =>
	s
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
const escapeXml = (s: string) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
/** Route53 returns `*` and other specials as octal escapes (`\052`). */
const decodeName = (s: string) =>
	normalizeName(
		unescapeXml(s).replace(/\\(\d{3})/g, (_, o: string) =>
			String.fromCharCode(Number.parseInt(o, 8)),
		),
	);

type RRSet = { name: string; type: string; ttl: number; values: string[] };

/** Record ids are `<fqdn>/<type>`: Route53 addresses record sets, not records. */
export const route53 = defineProvider({
	configSchema: route53Config,
	create(config, deps): DnsProvider {
		const http = new Http("route53", deps);

		async function call(op: string, path: string, body?: string) {
			const url = `${API}${path}`;
			const method = body === undefined ? "GET" : "POST";
			const headers: Record<string, string> = body
				? { "content-type": "application/xml" }
				: {};
			const signed = await signV4(
				{ method, url, headers, body },
				{ credentials: config, region: "us-east-1", service: "route53" },
			);
			try {
				const res = await http.request(op, url, {
					method,
					body,
					headers: { ...headers, ...signed },
				});
				return await res.text();
			} catch (err) {
				// Surface AWS's <Code>/<Message> instead of the whole XML document.
				if (err instanceof ProviderError && err.status !== undefined) {
					const code = tag(err.message, "Code");
					const message = tag(err.message, "Message");
					if (code)
						throw new ProviderError(
							"route53",
							op,
							`${code}: ${unescapeXml(message ?? "")}`,
							err.status,
						);
				}
				throw err;
			}
		}

		async function rrsets(zoneId: string, name?: string): Promise<RRSet[]> {
			const out: RRSet[] = [];
			const zone = encodeURIComponent(zoneId);
			const want = name ? normalizeName(name) : undefined;
			let next: { name: string; type?: string } | undefined = want
				? { name: want }
				: undefined;
			while (true) {
				const q = new URLSearchParams({ maxitems: "300" });
				if (next) q.set("name", `${next.name}.`);
				if (next?.type) q.set("type", next.type);
				const xml = await call("listRecords", `/hostedzone/${zone}/rrset?${q}`);
				for (const set of tags(xml, "ResourceRecordSet")) {
					// Weighted/latency/alias sets are not addressable by name/type; leave them alone.
					if (
						tag(set, "SetIdentifier") !== undefined ||
						tag(set, "AliasTarget") !== undefined
					)
						continue;
					out.push({
						name: decodeName(tag(set, "Name") ?? ""),
						type: tag(set, "Type") ?? "",
						ttl: Number(tag(set, "TTL") ?? 0),
						values: tags(set, "Value").map(unescapeXml),
					});
				}
				const nextName = tag(xml, "NextRecordName");
				if (tag(xml, "IsTruncated") !== "true" || !nextName) break;
				const decoded = decodeName(nextName);
				if (want && decoded !== want) break;
				next = { name: decoded, type: tag(xml, "NextRecordType") };
			}
			return want ? out.filter((s) => s.name === want) : out;
		}

		const toRecords = (zoneId: string, s: RRSet): DnsRecord[] => {
			const type = s.type;
			if (!isDnsRecordType(type)) return [];
			return s.values.map((v) => ({
				id: `${s.name}/${type}`,
				zoneId,
				name: s.name,
				type,
				content: type === "TXT" ? unquoteTxt(v) : v,
				ttl: s.ttl,
			}));
		};

		const change = (
			zoneId: string,
			op: string,
			action: "UPSERT" | "DELETE",
			s: { name: string; type: DnsRecordType; ttl: number; values: string[] },
		) =>
			call(
				op,
				`/hostedzone/${encodeURIComponent(zoneId)}/rrset/`,
				`<?xml version="1.0" encoding="UTF-8"?><ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Changes><Change><Action>${action}</Action><ResourceRecordSet><Name>${escapeXml(s.name)}.</Name><Type>${s.type}</Type><TTL>${s.ttl}</TTL><ResourceRecords>${s.values
					.map(
						(v) =>
							`<ResourceRecord><Value>${escapeXml(v)}</Value></ResourceRecord>`,
					)
					.join(
						"",
					)}</ResourceRecords></ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`,
			);

		return {
			async verify() {
				await call("verify", "/hostedzone?maxitems=1");
			},
			async listZones() {
				const zones = [];
				let marker: string | undefined;
				do {
					const q = new URLSearchParams({ maxitems: "100" });
					if (marker) q.set("marker", marker);
					const xml = await call("listZones", `/hostedzone?${q}`);
					for (const z of tags(xml, "HostedZone"))
						zones.push({
							id: (tag(z, "Id") ?? "").replace(/^\/hostedzone\//, ""),
							name: decodeName(tag(z, "Name") ?? ""),
						});
					marker =
						tag(xml, "IsTruncated") === "true"
							? tag(xml, "NextMarker")
							: undefined;
				} while (marker);
				return zones;
			},
			async listRecords(zoneId, name) {
				return (await rrsets(zoneId, name)).flatMap((s) =>
					toRecords(zoneId, s),
				);
			},
			async upsertRecord(input) {
				const name = normalizeName(input.name);
				const value =
					input.type === "TXT" ? quoteTxt(input.content) : input.content;
				await change(input.zoneId, "upsertRecord", "UPSERT", {
					name,
					type: input.type,
					ttl: input.ttl,
					values: [value],
				});
				return {
					...input,
					id: `${name}/${input.type}`,
					name,
					proxied: undefined,
				};
			},
			async deleteRecord(zoneId, recordId) {
				const slash = recordId.lastIndexOf("/");
				const name = recordId.slice(0, slash);
				const type = recordId.slice(slash + 1);
				if (slash < 1 || !isDnsRecordType(type))
					throw new ProviderError(
						"route53",
						"deleteRecord",
						"malformed record id",
					);
				// DELETE must repeat the set's current TTL and values exactly.
				const current = (await rrsets(zoneId, name)).find(
					(s) => s.type === type,
				);
				if (!current) return;
				await change(zoneId, "deleteRecord", "DELETE", { ...current, type });
			},
		};
	},
});
