import { ProviderError } from "../http.ts";
import {
	type DnsProvider,
	type DnsRecord,
	type DnsRecordType,
	type DnsZone,
	isDnsRecordType,
	normalizeName,
	type RecordSetInput,
} from "./types.ts";

/**
 * One record as a record-level API (DigitalOcean, OVH, Porkbun) stores it. `rel` is the name
 * relative to the zone (`@` at the apex), `value` LogiStack's presentation format.
 */
export type WireRecord = {
	id: string;
	rel: string;
	type: DnsRecordType;
	value: string;
	ttl: number;
};
export type NewRecord = Omit<WireRecord, "id">;

/** What a record-level API has to offer; zone ids are the zone names. */
export type RecordApi = {
	provider: string;
	verify(): Promise<void>;
	listZones(): Promise<DnsZone[]>;
	/** Records of `zone`; `rel` and `type` are hints the API may use to filter. */
	list(zone: string, rel?: string, type?: DnsRecordType): Promise<WireRecord[]>;
	create(zone: string, record: NewRecord): Promise<void>;
	update(zone: string, id: string, record: NewRecord): Promise<void>;
	remove(zone: string, id: string): Promise<void>;
	/** Runs once after a batch of writes (OVH applies changes on a zone refresh). */
	commit?(zone: string): Promise<void>;
};

/**
 * Lifts a record-level API to the set-level `DnsProvider`: record ids are `<rel>/<type>`
 * like Hetzner's, and a set's values map to one provider record each.
 */
export function recordSetProvider(api: RecordApi): DnsProvider {
	function relative(op: string, fqdn: string, zone: string) {
		const name = normalizeName(fqdn);
		const z = normalizeName(zone);
		if (name === z) return "@";
		if (!name.endsWith(`.${z}`))
			throw new ProviderError(
				api.provider,
				op,
				`${name} is not inside zone ${z}`,
			);
		return name.slice(0, -z.length - 1);
	}
	const absolute = (rel: string, zone: string) =>
		rel === "@" ? normalizeName(zone) : `${rel}.${normalizeName(zone)}`;

	function parseId(op: string, recordId: string) {
		const slash = recordId.lastIndexOf("/");
		const rel = recordId.slice(0, slash);
		const type = recordId.slice(slash + 1);
		if (slash < 1 || !isDnsRecordType(type))
			throw new ProviderError(api.provider, op, "malformed record id");
		return { rel, type };
	}

	async function setOf(zone: string, rel: string, type: DnsRecordType) {
		const rows = await api.list(zone, rel, type);
		return rows.filter((r) => r.rel === rel && r.type === type);
	}

	/** Makes (rel, type) hold exactly `values`: matching records stay, others are rewritten in place, then added or removed. */
	async function setValues(
		zone: string,
		rel: string,
		type: DnsRecordType,
		ttl: number,
		values: string[],
	) {
		const stale = await setOf(zone, rel, type);
		const missing: string[] = [];
		for (const value of values) {
			const i = stale.findIndex((r) => r.value === value && r.ttl === ttl);
			if (i >= 0) stale.splice(i, 1);
			else missing.push(value);
		}
		for (const value of missing) {
			const old = stale.shift();
			const record = { rel, type, value, ttl };
			if (old) await api.update(zone, old.id, record);
			else await api.create(zone, record);
		}
		for (const r of stale) await api.remove(zone, r.id);
		await api.commit?.(zone);
	}

	async function removeSet(zone: string, rel: string, type: DnsRecordType) {
		const rows = await setOf(zone, rel, type);
		for (const r of rows) await api.remove(zone, r.id);
		if (rows.length) await api.commit?.(zone);
	}

	const saved = (input: RecordSetInput, rel: string): DnsRecord[] =>
		input.values.map((content) => ({
			id: `${rel}/${input.type}`,
			zoneId: input.zoneId,
			name: normalizeName(input.name),
			type: input.type,
			content,
			ttl: input.ttl,
		}));

	return {
		verify: () => api.verify(),
		listZones: () => api.listZones(),
		async listRecords(zoneId, name) {
			const rel = name ? relative("listRecords", name, zoneId) : undefined;
			const rows = await api.list(zoneId, rel);
			return rows
				.filter((r) => rel === undefined || r.rel === rel)
				.map((r) => ({
					id: `${r.rel}/${r.type}`,
					zoneId,
					name: absolute(r.rel, zoneId),
					type: r.type,
					content: r.value,
					ttl: r.ttl,
				}));
		},
		async upsertRecord(input) {
			const rel = relative("upsertRecord", input.name, input.zoneId);
			await setValues(input.zoneId, rel, input.type, input.ttl, [
				input.content,
			]);
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
			const rel = relative("createRecord", input.name, input.zoneId);
			if ((await setOf(input.zoneId, rel, input.type)).length)
				throw new ProviderError(
					api.provider,
					"createRecord",
					`${normalizeName(input.name)} already has ${input.type} records`,
				);
			for (const value of input.values)
				await api.create(input.zoneId, {
					rel,
					type: input.type,
					value,
					ttl: input.ttl,
				});
			await api.commit?.(input.zoneId);
			return saved(input, rel);
		},
		async updateRecord(recordId, input) {
			const old = parseId("updateRecord", recordId);
			const rel = relative("updateRecord", input.name, input.zoneId);
			if (old.rel === rel && old.type === input.type) {
				await setValues(input.zoneId, rel, input.type, input.ttl, input.values);
				return saved(input, rel);
			}
			// shortcut: create-then-delete is not atomic; a failed delete leaves both sets.
			const records = await this.createRecord(input);
			await removeSet(input.zoneId, old.rel, old.type);
			return records;
		},
		async deleteRecord(zoneId, recordId) {
			const { rel, type } = parseId("deleteRecord", recordId);
			await removeSet(zoneId, rel, type);
		},
	};
}
