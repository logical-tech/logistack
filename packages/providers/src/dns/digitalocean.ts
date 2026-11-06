import { formatDnsValue, parseDnsValue } from "@logistack/contracts";
import { z } from "zod";
import { defineProvider, Http, secret } from "../http.ts";
import {
	type NewRecord,
	recordSetProvider,
	type WireRecord,
} from "./record-sets.ts";
import {
	type DnsProvider,
	isDnsRecordType,
	normalizeName,
	withDot,
	withoutDot,
} from "./types.ts";

const API = "https://api.digitalocean.com/v2";

export const digitaloceanConfig = z.object({ apiToken: secret() });
export type DigitaloceanConfig = z.infer<typeof digitaloceanConfig>;

type DoRecord = {
	id: number;
	type: string;
	name: string;
	data: string;
	ttl: number;
	priority?: number | null;
	port?: number | null;
	weight?: number | null;
	flags?: number | null;
	tag?: string | null;
};
type Paged = { links?: { pages?: { next?: string } } };

/** DigitalOcean's fields for a presentation value: targets are absolute, MX/SRV/CAA parts are separate fields. */
function doBody(r: NewRecord) {
	const base = { type: r.type, name: r.rel, ttl: r.ttl };
	const p = parseDnsValue(r.type, r.value);
	switch (r.type) {
		case "CNAME":
		case "NS":
			return { ...base, data: withDot(r.value) };
		case "MX":
			return {
				...base,
				data: withDot(p.target ?? ""),
				priority: Number(p.priority),
			};
		case "SRV":
			return {
				...base,
				data: withDot(p.target ?? ""),
				priority: Number(p.priority),
				weight: Number(p.weight),
				port: Number(p.port),
			};
		case "CAA":
			return { ...base, data: p.value, flags: Number(p.flags), tag: p.tag };
		default:
			return { ...base, data: r.value };
	}
}

export const digitalocean = defineProvider({
	configSchema: digitaloceanConfig,
	create(config, deps): DnsProvider {
		const http = new Http("digitalocean", deps);
		const headers = {
			authorization: `Bearer ${config.apiToken}`,
			"content-type": "application/json",
		};
		const domain = (zone: string) =>
			`/domains/${encodeURIComponent(normalizeName(zone))}`;

		async function all<K extends string, T>(
			op: string,
			path: string,
			key: K,
		): Promise<T[]> {
			const out: T[] = [];
			const sep = path.includes("?") ? "&" : "?";
			let url: string | undefined = `${API}${path}${sep}per_page=200`;
			while (url) {
				const res: Paged & Record<K, T[]> = await http.json(op, url, {
					headers,
				});
				out.push(...res[key]);
				url = res.links?.pages?.next;
			}
			return out;
		}

		const send = (op: string, method: string, path: string, body?: unknown) =>
			http.request(op, `${API}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});

		function toWire(zone: string, r: DoRecord): WireRecord | null {
			if (!isDnsRecordType(r.type)) return null;
			// DigitalOcean writes the apex as `@`, in names and in targets alike.
			const host = (h: string) =>
				h === "@" ? normalizeName(zone) : withoutDot(h);
			const value = (() => {
				switch (r.type) {
					case "CNAME":
					case "NS":
						return host(r.data);
					case "MX":
						return `${r.priority ?? 0} ${host(r.data)}`;
					case "SRV":
						return `${r.priority ?? 0} ${r.weight ?? 0} ${r.port ?? 0} ${host(r.data)}`;
					case "CAA":
						return formatDnsValue("CAA", {
							flags: String(r.flags ?? 0),
							tag: r.tag ?? "",
							value: r.data,
						});
					default:
						return r.data;
				}
			})();
			return { id: String(r.id), rel: r.name, type: r.type, value, ttl: r.ttl };
		}

		return recordSetProvider({
			provider: "digitalocean",
			async verify() {
				await http.json("verify", `${API}/domains?per_page=1`, { headers });
			},
			async listZones() {
				const domains = await all<"domains", { name: string }>(
					"listZones",
					"/domains",
					"domains",
				);
				return domains.map((d) => {
					const name = normalizeName(d.name);
					return { id: name, name };
				});
			},
			async list(zone, rel, type) {
				const q = new URLSearchParams();
				// The name filter wants the FQDN and needs a type alongside.
				if (rel && type) {
					q.set(
						"name",
						rel === "@" ? normalizeName(zone) : `${rel}.${normalizeName(zone)}`,
					);
					q.set("type", type);
				}
				const rows = await all<"domain_records", DoRecord>(
					"listRecords",
					`${domain(zone)}/records${q.size ? `?${q}` : ""}`,
					"domain_records",
				);
				return rows
					.map((r) => toWire(zone, r))
					.filter((r): r is WireRecord => r !== null);
			},
			async create(zone, record) {
				await send(
					"createRecord",
					"POST",
					`${domain(zone)}/records`,
					doBody(record),
				);
			},
			async update(zone, id, record) {
				await send(
					"updateRecord",
					"PUT",
					`${domain(zone)}/records/${encodeURIComponent(id)}`,
					doBody(record),
				);
			},
			async remove(zone, id) {
				await send(
					"deleteRecord",
					"DELETE",
					`${domain(zone)}/records/${encodeURIComponent(id)}`,
				);
			},
		});
	},
});
