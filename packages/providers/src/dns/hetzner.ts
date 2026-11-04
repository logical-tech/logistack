import { z } from "zod";
import { defineProvider, Http, ProviderError, secret } from "../http.ts";
import {
	type DnsProvider,
	type DnsRecord,
	isDnsRecordType,
	mapTarget,
	normalizeName,
	quoteTxt,
	type RecordSetInput,
	unquoteTxt,
	withDot,
	withoutDot,
} from "./types.ts";

// Hetzner Cloud DNS API (the one caddy-dns/hetzner v2 uses), not the retired dns.hetzner.com API.
const API = "https://api.hetzner.cloud/v1";

export const hetznerConfig = z.object({ apiToken: secret() });
export type HetznerConfig = z.infer<typeof hetznerConfig>;

type RRSet = {
	name: string;
	type: string;
	ttl: number | null;
	records: { value: string }[];
	protection?: { change?: boolean };
};
type Paged = { meta?: { pagination?: { next_page?: number | null } } };

/** Record ids are `<relative name>/<type>`, the rrset address Hetzner's API uses. */
export const hetzner = defineProvider({
	configSchema: hetznerConfig,
	create(config, deps): DnsProvider {
		const http = new Http("hetzner", deps);
		const headers = {
			authorization: `Bearer ${config.apiToken}`,
			"content-type": "application/json",
		};
		const call = <T>(op: string, path: string, init: RequestInit = {}) =>
			http.json<T>(op, `${API}${path}`, { ...init, headers });

		async function all<K extends string, T>(
			op: string,
			path: string,
			key: K,
		): Promise<T[]> {
			const out: T[] = [];
			for (let page: number | null | undefined = 1; page; ) {
				const sep = path.includes("?") ? "&" : "?";
				const res: Paged & Record<K, T[]> = await call(
					op,
					`${path}${sep}per_page=100&page=${page}`,
				);
				out.push(...res[key]);
				page = res.meta?.pagination?.next_page;
			}
			return out;
		}

		const zonePath = (zoneId: string) => `/zones/${encodeURIComponent(zoneId)}`;
		const rrsetPath = (zoneId: string, rel: string, type: string) =>
			`${zonePath(zoneId)}/rrsets/${encodeURIComponent(rel)}/${type}`;

		async function zone(zoneId: string) {
			const res = await call<{ zone: { name: string; ttl: number } }>(
				"getZone",
				zonePath(zoneId),
			);
			return { name: normalizeName(res.zone.name), ttl: res.zone.ttl };
		}

		function relative(fqdn: string, zoneName: string, op = "upsertRecord") {
			const name = normalizeName(fqdn);
			if (name === zoneName) return "@";
			if (!name.endsWith(`.${zoneName}`))
				throw new ProviderError(
					"hetzner",
					op,
					`${name} is not inside zone ${zoneName}`,
				);
			return name.slice(0, -zoneName.length - 1);
		}

		const toRecords = (
			zoneId: string,
			zoneName: string,
			zoneTtl: number,
			set: RRSet,
		): DnsRecord[] => {
			const type = set.type;
			if (!isDnsRecordType(type)) return [];
			const name = set.name === "@" ? zoneName : `${set.name}.${zoneName}`;
			return set.records.map((r) => ({
				id: `${set.name}/${type}`,
				zoneId,
				name,
				type,
				content:
					type === "TXT"
						? unquoteTxt(r.value)
						: mapTarget(type, r.value, withoutDot),
				ttl: set.ttl ?? zoneTtl,
				...(set.protection?.change
					? {
							readOnly:
								"Protected at Hetzner, unprotect it in the Hetzner Console",
						}
					: {}),
			}));
		};

		// Hetzner reads a target without a trailing dot as relative to the zone.
		const toWire = (type: string, v: string) => ({
			value: type === "TXT" ? quoteTxt(v) : mapTarget(type, v, withDot),
		});

		/** Makes the rrset at (rel, type) hold exactly `values` with `ttl`, creating it when missing. */
		async function setRRSet(
			op: string,
			zoneId: string,
			rel: string,
			type: string,
			ttl: number,
			values: string[],
		) {
			const records = values.map((v) => toWire(type, v));
			const path = rrsetPath(zoneId, rel, type);
			let existing: RRSet | null = null;
			try {
				existing = (await call<{ rrset: RRSet }>(op, path)).rrset;
			} catch (err) {
				if (!(err instanceof ProviderError && err.status === 404)) throw err;
			}
			if (!existing) {
				await call(op, `${zonePath(zoneId)}/rrsets`, {
					method: "POST",
					body: JSON.stringify({ name: rel, type, ttl, records }),
				});
				return;
			}
			await call(op, `${path}/actions/set_records`, {
				method: "POST",
				body: JSON.stringify({ records }),
			});
			if (existing.ttl !== ttl)
				await call(op, `${path}/actions/change_ttl`, {
					method: "POST",
					body: JSON.stringify({ ttl }),
				});
		}

		function parseId(op: string, recordId: string) {
			const slash = recordId.lastIndexOf("/");
			const rel = recordId.slice(0, slash);
			const type = recordId.slice(slash + 1);
			if (slash < 1 || !isDnsRecordType(type))
				throw new ProviderError("hetzner", op, "malformed record id");
			return { rel, type };
		}

		const savedRecords = (input: RecordSetInput, rel: string): DnsRecord[] =>
			input.values.map((content) => ({
				id: `${rel}/${input.type}`,
				zoneId: input.zoneId,
				name: normalizeName(input.name),
				type: input.type,
				content,
				ttl: input.ttl,
			}));

		async function remove(
			op: string,
			zoneId: string,
			rel: string,
			type: string,
		) {
			try {
				await call(op, rrsetPath(zoneId, rel, type), { method: "DELETE" });
			} catch (err) {
				if (err instanceof ProviderError && err.status === 404) return;
				throw err;
			}
		}

		return {
			async verify() {
				await call("verify", "/zones?per_page=1");
			},
			async listZones() {
				const zones = await all<"zones", { id: number; name: string }>(
					"listZones",
					"/zones",
					"zones",
				);
				return zones.map((z) => ({
					id: String(z.id),
					name: normalizeName(z.name),
				}));
			},
			async listRecords(zoneId, name) {
				const z = await zone(zoneId);
				const q = name
					? `?name=${encodeURIComponent(relative(name, z.name))}`
					: "";
				const sets = await all<"rrsets", RRSet>(
					"listRecords",
					`${zonePath(zoneId)}/rrsets${q}`,
					"rrsets",
				);
				return sets.flatMap((s) => toRecords(zoneId, z.name, z.ttl, s));
			},
			async upsertRecord(input) {
				const z = await zone(input.zoneId);
				const rel = relative(input.name, z.name);
				await setRRSet(
					"upsertRecord",
					input.zoneId,
					rel,
					input.type,
					input.ttl,
					[input.content],
				);
				return {
					id: `${rel}/${input.type}`,
					zoneId: input.zoneId,
					name: normalizeName(input.name),
					type: input.type,
					content: input.content,
					ttl: input.ttl,
				};
			},
			async createRecord(input) {
				const z = await zone(input.zoneId);
				const rel = relative(input.name, z.name, "createRecord");
				await call("createRecord", `${zonePath(input.zoneId)}/rrsets`, {
					method: "POST",
					body: JSON.stringify({
						name: rel,
						type: input.type,
						ttl: input.ttl,
						records: input.values.map((v) => toWire(input.type, v)),
					}),
				});
				return savedRecords(input, rel);
			},
			async updateRecord(recordId, input) {
				const old = parseId("updateRecord", recordId);
				const z = await zone(input.zoneId);
				const rel = relative(input.name, z.name, "updateRecord");
				if (old.rel === rel && old.type === input.type) {
					await setRRSet(
						"updateRecord",
						input.zoneId,
						rel,
						input.type,
						input.ttl,
						input.values,
					);
					return savedRecords(input, rel);
				}
				// shortcut: create-then-delete is two calls, not atomic; a failed delete leaves both sets.
				const records = await this.createRecord(input);
				await remove("updateRecord", input.zoneId, old.rel, old.type);
				return records;
			},
			async deleteRecord(zoneId, recordId) {
				const { rel, type } = parseId("deleteRecord", recordId);
				await remove("deleteRecord", zoneId, rel, type);
			},
		};
	},
});
