import { z } from "zod";
import { defineProvider, Http, ProviderError, secret } from "../http.ts";
import {
	type DnsProvider,
	type DnsRecord,
	isDnsRecordType,
	normalizeName,
	unquoteTxt,
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
};

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
						content: r.type === "TXT" ? unquoteTxt(r.content) : r.content,
						ttl: r.ttl,
						proxied: r.proxied ?? false,
					}
				: null;

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
				const saved = first
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
				const record = toRecord(input.zoneId, saved);
				if (!record)
					throw new ProviderError(
						"cloudflare",
						"upsertRecord",
						"unexpected record type",
					);
				return record;
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
