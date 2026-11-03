/*
 * MongoDB documents cross the api as canonical Extended JSON, where every int is
 * `{"$numberInt": "3"}`. `readable` drops the wrappers whose plain form parses back to the same
 * BSON type, so people read and edit `3` and `"2024-01-02T03:04:05.123Z"` while the round trip
 * stays exact: a long, an integral double or a date outside 1970-9999 keeps its wrapper.
 */
import { EJSON } from "bson";

type Json = unknown;

const only = (o: object, key: string) => {
	const keys = Object.keys(o);
	return keys.length === 1 && keys[0] === key;
};

export function readable(v: Json): Json {
	if (Array.isArray(v)) return v.map(readable);
	if (v === null || typeof v !== "object") return v;
	const o = v as Record<string, unknown>;
	if (only(o, "$numberInt")) return Number(o.$numberInt);
	if (only(o, "$numberDouble")) {
		const n = Number(o.$numberDouble);
		// A plain integer parses back as an int32 or long, so integral doubles keep the wrapper.
		return Number.isFinite(n) && !Number.isInteger(n) ? n : o;
	}
	if (only(o, "$date")) {
		const ms = (o.$date as { $numberLong?: string }).$numberLong;
		const d = new Date(Number(ms));
		const y = d.getUTCFullYear();
		return ms !== undefined && y >= 1970 && y <= 9999
			? { $date: d.toISOString() }
			: o;
	}
	return Object.fromEntries(
		Object.entries(o).map(([k, x]) => [k, readable(x)]),
	);
}

export const pretty = (doc: Json) => JSON.stringify(readable(doc), null, 2);

export type Parsed =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; error: string };

/** Extended JSON text to a canonical object, or why it isn't one. Empty text is `{}`. */
export function parseObject(text: string): Parsed {
	if (!text.trim()) return { ok: true, value: {} };
	try {
		const v = EJSON.parse(text, { relaxed: false });
		if (v === null || typeof v !== "object" || Array.isArray(v))
			return { ok: false, error: "Expected a JSON object, like { }." };
		return {
			ok: true,
			value: EJSON.serialize(v, { relaxed: false }) as Record<string, unknown>,
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** A typed literal for the wrappers worth naming in the read view; null for anything else. */
export function literal(v: Json): { type: string; text: string } | null {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
	const [key, ...rest] = Object.keys(v);
	if (!key || rest.length) return null;
	const raw = (v as Record<string, unknown>)[key];
	const s = String(raw);
	const x = (raw ?? {}) as Record<string, string>;
	switch (key) {
		case "$oid":
			return { type: "ObjectId", text: s };
		case "$date":
			return {
				type: "Date",
				text: typeof raw === "string" ? raw : String(x.$numberLong),
			};
		case "$numberLong":
			return { type: "Long", text: s };
		case "$numberDecimal":
			return { type: "Decimal128", text: s };
		case "$numberDouble":
			return { type: "Double", text: s };
		case "$numberInt":
			return { type: "Int32", text: s };
		case "$binary":
			return {
				type: x.subType === "04" ? "UUID" : `Binary ${x.subType}`,
				text: String(x.base64),
			};
		case "$timestamp":
			return { type: "Timestamp", text: JSON.stringify(x) };
		case "$regularExpression":
			return { type: "RegExp", text: `/${x.pattern}/${x.options}` };
		case "$minKey":
			return { type: "MinKey", text: "" };
		case "$maxKey":
			return { type: "MaxKey", text: "" };
		default:
			return null;
	}
}
