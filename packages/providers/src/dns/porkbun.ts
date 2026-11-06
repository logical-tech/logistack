import { parseDnsValue } from "@logistack/contracts";
import { z } from "zod";
import { defineProvider, Http, ProviderError, secret } from "../http.ts";
import {
	type NewRecord,
	recordSetProvider,
	type WireRecord,
} from "./record-sets.ts";
import {
	type DnsProvider,
	isDnsRecordType,
	normalizeName,
	withoutDot,
} from "./types.ts";

const API = "https://api.porkbun.com/api/json/v3";
/** Porkbun raises anything lower to 600 seconds. */
export const PORKBUN_MIN_TTL = 600;
/** listAll pages by this many domains. */
const PAGE = 1000;

export const porkbunConfig = z.object({
	apiKey: secret(),
	secretApiKey: secret(),
});
export type PorkbunConfig = z.infer<typeof porkbunConfig>;

type PbRecord = {
	id: string;
	name: string;
	type: string;
	content: string;
	ttl: string;
	prio?: string | null;
};

/** Porkbun's fields for a presentation value: MX and SRV priority goes in `prio`. */
function pbBody(r: NewRecord) {
	const base = {
		name: r.rel === "@" ? "" : r.rel,
		type: r.type,
		ttl: String(Math.max(r.ttl, PORKBUN_MIN_TTL)),
	};
	const p = parseDnsValue(r.type, r.value);
	switch (r.type) {
		case "MX":
			return { ...base, content: p.target ?? "", prio: p.priority };
		case "SRV":
			return {
				...base,
				content: `${p.weight} ${p.port} ${p.target}`,
				prio: p.priority,
			};
		default:
			return { ...base, content: r.value };
	}
}

export const porkbun = defineProvider({
	configSchema: porkbunConfig,
	create(config, deps): DnsProvider {
		const http = new Http("porkbun", deps);
		const auth = { apikey: config.apiKey, secretapikey: config.secretApiKey };

		/** Every call is a POST carrying the keys in the body; `status` says whether it worked. */
		async function call<T>(op: string, path: string, body: object = {}) {
			const res = await http.json<{ status?: string; message?: string } & T>(
				op,
				`${API}${path}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...auth, ...body }),
				},
			);
			if (res.status !== "SUCCESS")
				throw new ProviderError("porkbun", op, res.message ?? "request failed");
			return res;
		}
		const domain = (zone: string) => encodeURIComponent(normalizeName(zone));

		function toWire(zone: string, r: PbRecord): WireRecord | null {
			if (!isDnsRecordType(r.type)) return null;
			const z = normalizeName(zone);
			const name = normalizeName(r.name);
			const rel = name === z ? "@" : name.slice(0, -z.length - 1);
			const prio = r.prio ?? "0";
			const value = (() => {
				switch (r.type) {
					case "CNAME":
					case "NS":
						return withoutDot(r.content);
					case "MX":
					case "SRV":
						return `${prio} ${withoutDot(r.content)}`;
					default:
						return r.content;
				}
			})();
			return { id: r.id, rel, type: r.type, value, ttl: Number(r.ttl) };
		}

		return recordSetProvider({
			provider: "porkbun",
			async verify() {
				await call("verify", "/ping");
			},
			async listZones() {
				const out: { id: string; name: string }[] = [];
				for (let start = 0; ; start += PAGE) {
					const res = await call<{ domains?: { domain: string }[] }>(
						"listZones",
						"/domain/listAll",
						{ start: String(start) },
					);
					const page = res.domains ?? [];
					for (const d of page) {
						const name = normalizeName(d.domain);
						out.push({ id: name, name });
					}
					if (page.length < PAGE) return out;
				}
			},
			async list(zone) {
				const res = await call<{ records?: PbRecord[] }>(
					"listRecords",
					`/dns/retrieve/${domain(zone)}`,
				);
				return (res.records ?? [])
					.map((r) => toWire(zone, r))
					.filter((r): r is WireRecord => r !== null);
			},
			async create(zone, record) {
				await call(
					"createRecord",
					`/dns/create/${domain(zone)}`,
					pbBody(record),
				);
			},
			async update(zone, id, record) {
				await call(
					"updateRecord",
					`/dns/edit/${domain(zone)}/${encodeURIComponent(id)}`,
					pbBody(record),
				);
			},
			async remove(zone, id) {
				await call(
					"deleteRecord",
					`/dns/delete/${domain(zone)}/${encodeURIComponent(id)}`,
				);
			},
		});
	},
});
