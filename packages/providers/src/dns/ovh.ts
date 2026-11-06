import { z } from "zod";
import { defineProvider, Http, secret } from "../http.ts";
import { recordSetProvider, type WireRecord } from "./record-sets.ts";
import {
	type DnsProvider,
	isDnsRecordType,
	mapTarget,
	normalizeName,
	unquoteTxt,
	withDot,
	withoutDot,
} from "./types.ts";

export const ovhEndpoints = {
	"ovh-eu": "https://eu.api.ovh.com/1.0",
	"ovh-ca": "https://ca.api.ovh.com/1.0",
	"ovh-us": "https://api.us.ovhcloud.com/1.0",
} as const;

export const ovhConfig = z.object({
	endpoint: z.enum(["ovh-eu", "ovh-ca", "ovh-us"]).default("ovh-eu"),
	applicationKey: z.string().min(1),
	applicationSecret: secret(),
	consumerKey: secret(),
});
export type OvhConfig = z.infer<typeof ovhConfig>;

type OvhRecord = {
	id: number;
	subDomain: string;
	fieldType: string;
	target: string;
	ttl: number;
};

/** `$1$` + SHA-1 of `AS+CK+METHOD+URL+BODY+TIMESTAMP`, the signature OVH's API checks. */
export async function ovhSignature(p: {
	applicationSecret: string;
	consumerKey: string;
	method: string;
	url: string;
	body: string;
	timestamp: number;
}): Promise<string> {
	const data = [
		p.applicationSecret,
		p.consumerKey,
		p.method,
		p.url,
		p.body,
		String(p.timestamp),
	].join("+");
	const digest = await crypto.subtle.digest(
		"SHA-1",
		new TextEncoder().encode(data),
	);
	return `$1$${new Uint8Array(digest).toHex()}`;
}

export const ovh = defineProvider({
	configSchema: ovhConfig,
	create(config, deps): DnsProvider {
		const http = new Http("ovh", deps);
		const base = ovhEndpoints[config.endpoint];
		const now = () => Math.floor(Date.now() / 1000);

		// Signatures carry a timestamp OVH checks against its own clock, so read the skew once.
		let skew: Promise<number> | undefined;
		const serverSkew = () => {
			skew ??= http
				.json<number>("time", `${base}/auth/time`)
				.then((t) => t - now())
				.catch((err) => {
					skew = undefined;
					throw err;
				});
			return skew;
		};

		async function call(
			op: string,
			method: string,
			path: string,
			body?: unknown,
		) {
			const url = `${base}${path}`;
			const text = body === undefined ? "" : JSON.stringify(body);
			const timestamp = now() + (await serverSkew());
			return http.request(op, url, {
				method,
				headers: {
					"content-type": "application/json",
					"x-ovh-application": config.applicationKey,
					"x-ovh-consumer": config.consumerKey,
					"x-ovh-timestamp": String(timestamp),
					"x-ovh-signature": await ovhSignature({
						applicationSecret: config.applicationSecret,
						consumerKey: config.consumerKey,
						method,
						url,
						body: text,
						timestamp,
					}),
				},
				body: text || undefined,
			});
		}
		const get = async <T>(op: string, path: string) =>
			(await (await call(op, "GET", path)).json()) as T;
		const zonePath = (zone: string) =>
			`/domain/zone/${encodeURIComponent(normalizeName(zone))}`;

		function toWire(r: OvhRecord): WireRecord | null {
			if (!isDnsRecordType(r.fieldType)) return null;
			const type = r.fieldType;
			return {
				id: String(r.id),
				rel: r.subDomain === "" ? "@" : r.subDomain.toLowerCase(),
				type,
				value:
					type === "TXT"
						? unquoteTxt(r.target)
						: mapTarget(type, r.target, withoutDot),
				// 0 is OVH's "zone default", shown as Auto.
				ttl: r.ttl,
			};
		}
		const toBody = (r: Omit<WireRecord, "id">) => ({
			subDomain: r.rel === "@" ? "" : r.rel,
			// OVH reads a target without the trailing dot as relative to the zone.
			target: mapTarget(r.type, r.value, withDot),
			ttl: r.ttl,
		});

		return recordSetProvider({
			provider: "ovh",
			async verify() {
				await call("verify", "GET", "/domain/zone");
			},
			async listZones() {
				const zones = await get<string[]>("listZones", "/domain/zone");
				return zones.map((z) => {
					const name = normalizeName(z);
					return { id: name, name };
				});
			},
			async list(zone, rel, type) {
				const q = new URLSearchParams();
				if (type) q.set("fieldType", type);
				if (rel && rel !== "@") q.set("subDomain", rel);
				const ids = await get<number[]>(
					"listRecords",
					`${zonePath(zone)}/record${q.size ? `?${q}` : ""}`,
				);
				// shortcut: OVH lists ids only, so one GET per record; fine for zones of a few hundred records.
				const rows = await Promise.all(
					ids.map((id) =>
						get<OvhRecord>("listRecords", `${zonePath(zone)}/record/${id}`),
					),
				);
				return rows.map(toWire).filter((r): r is WireRecord => r !== null);
			},
			async create(zone, record) {
				await call("createRecord", "POST", `${zonePath(zone)}/record`, {
					fieldType: record.type,
					...toBody(record),
				});
			},
			async update(zone, id, record) {
				await call(
					"updateRecord",
					"PUT",
					`${zonePath(zone)}/record/${encodeURIComponent(id)}`,
					toBody(record),
				);
			},
			async remove(zone, id) {
				await call(
					"deleteRecord",
					"DELETE",
					`${zonePath(zone)}/record/${encodeURIComponent(id)}`,
				);
			},
			async commit(zone) {
				await call("refresh", "POST", `${zonePath(zone)}/refresh`);
			},
		});
	},
});
