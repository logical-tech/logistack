import {
	formatDnsValue,
	parseDnsValue,
	proxiableTypes,
} from "@logistack/contracts";
import { z } from "zod";
import { defineProvider, Http, ProviderError, secret } from "../http.ts";
import {
	type DnsProvider,
	type DnsRecord,
	type DnsRecordType,
	isDnsRecordType,
	mapTarget,
	normalizeName,
	type RecordSetInput,
	unquoteTxt,
	withoutDot,
} from "./types.ts";

const API = "https://api.cloudflare.com/client/v4";

export const cloudflareConfig = z.object({ apiToken: secret() });
export type CloudflareConfig = z.infer<typeof cloudflareConfig>;

type CfPage<T> = { result: T[]; result_info?: { total_pages?: number } };
type CfRecord = {
	id: string;
	name: string;
	type: string;
	content: string;
	ttl: number;
	proxied?: boolean;
	priority?: number;
	comment?: string | null;
	data?: Record<string, string | number>;
};

/** Cloudflare's own shape for a presentation value: MX splits off `priority`, SRV and CAA go in `data`. */
function toBody(type: DnsRecordType, value: string) {
	const p = parseDnsValue(type, value);
	switch (type) {
		case "MX":
			return {
				priority: Number(p.priority),
				content: withoutDot(p.target ?? ""),
			};
		case "SRV":
			return {
				data: {
					priority: Number(p.priority),
					weight: Number(p.weight),
					port: Number(p.port),
					target: withoutDot(p.target ?? ""),
				},
			};
		case "CAA":
			return { data: { flags: Number(p.flags), tag: p.tag, value: p.value } };
		default:
			return { content: mapTarget(type, value, withoutDot) };
	}
}

function toValue(type: DnsRecordType, r: CfRecord): string {
	const d = r.data ?? {};
	switch (type) {
		case "TXT":
			return unquoteTxt(r.content);
		case "MX":
			return `${r.priority ?? 0} ${r.content}`;
		case "SRV":
			return r.data
				? `${d.priority} ${d.weight} ${d.port} ${d.target}`
				: `${r.priority ?? 0} ${r.content}`;
		case "CAA":
			return r.data
				? formatDnsValue("CAA", {
						flags: String(d.flags),
						tag: String(d.tag),
						value: String(d.value),
					})
				: r.content;
		default:
			return r.content;
	}
}

export const cloudflare = defineProvider({
	configSchema: cloudflareConfig,
	create(config, deps): DnsProvider {
		const http = new Http("cloudflare", deps);
		const headers = { authorization: `Bearer ${config.apiToken}` };

		async function all<T>(op: string, path: string): Promise<T[]> {
			const out: T[] = [];
			for (let page = 1; ; page++) {
				const sep = path.includes("?") ? "&" : "?";
				const res = await http.json<CfPage<T>>(
					op,
					`${API}${path}${sep}per_page=100&page=${page}`,
					{ headers },
				);
				out.push(...res.result);
				if (page >= (res.result_info?.total_pages ?? 1)) return out;
			}
		}

		const toRecord = (zoneId: string, r: CfRecord): DnsRecord | null =>
			isDnsRecordType(r.type)
				? {
						id: r.id,
						zoneId,
						name: normalizeName(r.name),
						type: r.type,
						content: toValue(r.type, r),
						ttl: r.ttl,
						proxied: r.proxied ?? false,
						...(r.comment ? { comment: r.comment } : {}),
					}
				: null;

		const recordBody = (input: RecordSetInput) => {
			if (input.values.length !== 1)
				throw new ProviderError(
					"cloudflare",
					"saveRecord",
					"a record holds exactly one value",
				);
			return {
				type: input.type,
				name: normalizeName(input.name),
				ttl: input.ttl,
				...toBody(input.type, input.values[0] ?? ""),
				...(proxiableTypes.includes(input.type)
					? { proxied: input.proxied ?? false }
					: {}),
				...(input.comment !== undefined ? { comment: input.comment } : {}),
			};
		};

		const saved = (zoneId: string, r: CfRecord) => {
			const record = toRecord(zoneId, r);
			if (!record)
				throw new ProviderError(
					"cloudflare",
					"saveRecord",
					"unexpected record type",
				);
			return record;
		};

		async function listRecords(zoneId: string, name?: string, type?: string) {
			const q = new URLSearchParams();
			if (name) q.set("name", normalizeName(name));
			if (type) q.set("type", type);
			const rows = await all<CfRecord>(
				"listRecords",
				`/zones/${encodeURIComponent(zoneId)}/dns_records?${q}`,
			);
			return rows
				.map((r) => toRecord(zoneId, r))
				.filter((r): r is DnsRecord => r !== null);
		}

		async function send(
			op: string,
			method: string,
			path: string,
			body?: unknown,
		) {
			const res = await http.json<{ result: CfRecord }>(op, `${API}${path}`, {
				method,
				headers: { ...headers, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return res.result;
		}

		return {
			async verify() {
				await http.json("verify", `${API}/zones?per_page=1`, { headers });
			},
			async listZones() {
				const zones = await all<{ id: string; name: string }>(
					"listZones",
					"/zones",
				);
				return zones.map((z) => ({ id: z.id, name: normalizeName(z.name) }));
			},
			listRecords: (zoneId, name) => listRecords(zoneId, name),
			async upsertRecord(input) {
				const body = {
					type: input.type,
					name: normalizeName(input.name),
					content: input.content,
					ttl: input.ttl,
					proxied: input.proxied ?? false,
				};
				const zone = encodeURIComponent(input.zoneId);
				const [first, ...extra] = await listRecords(
					input.zoneId,
					input.name,
					input.type,
				);
				const result = first
					? await send(
							"upsertRecord",
							"PUT",
							`/zones/${zone}/dns_records/${encodeURIComponent(first.id)}`,
							body,
						)
					: await send(
							"upsertRecord",
							"POST",
							`/zones/${zone}/dns_records`,
							body,
						);
				for (const r of extra)
					await send(
						"upsertRecord",
						"DELETE",
						`/zones/${zone}/dns_records/${encodeURIComponent(r.id)}`,
					);
				return saved(input.zoneId, result);
			},
			async createRecord(input) {
				const r = await send(
					"createRecord",
					"POST",
					`/zones/${encodeURIComponent(input.zoneId)}/dns_records`,
					recordBody(input),
				);
				return [saved(input.zoneId, r)];
			},
			async updateRecord(recordId, input) {
				const r = await send(
					"updateRecord",
					"PUT",
					`/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
					recordBody(input),
				);
				return [saved(input.zoneId, r)];
			},
			async deleteRecord(zoneId, recordId) {
				try {
					await send(
						"deleteRecord",
						"DELETE",
						`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
					);
				} catch (err) {
					if (err instanceof ProviderError && err.status === 404) return;
					throw err;
				}
			},
		};
	},
});
