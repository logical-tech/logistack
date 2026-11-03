/*
 * The MongoDB slice of the database explorer's mock world: storefront/production's `catalog`
 * service holds a shop database (2 400 orders, customers, an empty events collection, a view)
 * and an analytics database. Order 11 was deleted by a teammate after the page loaded: editing
 * or deleting it shows the stale conflict. booking services answer writes with 403. Finds
 * understand equality, $gt/$gte/$lt/$lte/$ne/$in/$exists/$regex, $and/$or, and reject
 * $where/$function/$accumulator like the api.
 */
import type {
	CollectionRef,
	DatabaseSchema,
	DbColumn,
	DocumentsPage,
	DocumentWrite,
} from "@logistack/contracts";
import { Binary, Decimal128, Double, EJSON, Int32, Long, ObjectId } from "bson";
import { readable } from "@/components/database/ejson";
import { ApiError } from "../adapter";

type Doc = Record<string, unknown>;
type Coll = { docs: Doc[]; view?: boolean; ghosts?: Set<string> };
type World = Record<string, Record<string, Coll>>;

const PAGE = 200;
const delay = <T>(value: T, ms = 140 + Math.random() * 240): Promise<T> =>
	new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);

function prng(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const canonical = (d: object) => EJSON.serialize(d, { relaxed: false }) as Doc;
// A creation second near 2026-01 plus a stable tail, so ids look real and sort by n.
const oid = (n: number) =>
	new ObjectId(
		`${(0x69560000 + n).toString(16)}a1f3c27e${n.toString(16).padStart(8, "0")}`,
	);
const keyOf = (id: unknown) => JSON.stringify(id);

const FIRST = ["Giulia", "Marco", "Sofia", "Luca", "Chiara", "Matteo", "Anna"];
const LAST = ["Rossi", "Bianchi", "Esposito", "Romano", "Colombo", "Ricci"];
const STATUS = ["paid", "pending", "shipped", "refunded"];
const SKU = ["MUG-01", "TEE-M", "TEE-L", "CAP-02", "BAG-07", "PEN-11"];

function build(): World {
	const r = prng(4242);
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T;
	const start = Date.parse("2026-01-01T08:00:00Z");
	const customers = Array.from({ length: 300 }, (_, i) =>
		canonical({
			_id: oid(0x100000 + i),
			name: `${pick(FIRST)} ${pick(LAST)}`,
			email: `customer${i + 1}@example.it`,
			since: new Date(start - Math.floor(r() * 4e10)),
			vip: r() < 0.1,
			tags: r() < 0.5 ? ["newsletter"] : [],
		}),
	);
	const orders = Array.from({ length: 2400 }, (_, i) => {
		const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
			sku: pick(SKU),
			qty: new Int32(1 + Math.floor(r() * 4)),
			price: Decimal128.fromString((5 + r() * 60).toFixed(2)),
		}));
		return canonical({
			_id: oid(0x200000 + i),
			number: new Int32(1000 + i),
			customer: oid(0x100000 + Math.floor(r() * 300)),
			status: pick(STATUS),
			placedAt: new Date(start + i * 3_600_000 + Math.floor(r() * 3e6)),
			total: Decimal128.fromString(
				lines
					.reduce(
						(s, l) => s + Number(l.price.toString()) * Number(l.qty.value),
						0,
					)
					.toFixed(2),
			),
			lines,
			shipping: {
				city: pick(["Milano", "Torino", "Roma", "Bologna", "Napoli"]),
				express: r() < 0.2,
				weightKg: new Double((Math.round(r() * 50) + 1) / 10),
			},
			...(i % 9 === 0
				? { trackingId: Long.fromString(`9007199254${740993 + i}`) }
				: {}),
			...(i % 13 === 0
				? {
						receipt: new Binary(
							new Uint8Array(
								Array.from({ length: 12 }, () => Math.floor(r() * 256)),
							),
						),
					}
				: {}),
		});
	});
	return {
		shop: {
			orders: { docs: orders, ghosts: new Set([keyOf(orders[11]?._id)]) },
			customers: { docs: customers },
			events: { docs: [] },
			paid_orders: {
				docs: orders.filter((o) => o.status === "paid"),
				view: true,
			},
		},
		analytics: {
			sessions: {
				docs: Array.from({ length: 640 }, (_, i) =>
					canonical({
						_id: `s-${(i + 1).toString(36).padStart(5, "0")}`,
						path: pick(["/", "/shop", "/cart", "/checkout", "/account"]),
						ms: new Int32(Math.floor(r() * 9000)),
						at: new Date(start + i * 600_000),
					}),
				),
			},
		},
	};
}

const worlds = new Map<string, World>();
const worldOf = (id: string) => {
	let w = worlds.get(id);
	if (!w) {
		w = build();
		worlds.set(id, w);
	}
	return w;
};

function typeOf(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "boolean") return "bool";
	if (typeof v !== "object") return typeof v;
	const k = Object.keys(v)[0];
	const t: Record<string, string> = {
		$oid: "objectId",
		$date: "date",
		$numberInt: "int",
		$numberLong: "long",
		$numberDouble: "double",
		$numberDecimal: "decimal",
		$binary: "binData",
	};
	return (k && t[k]) || "object";
}

function fields(docs: Doc[]): DbColumn[] {
	const types = new Map<string, string>();
	for (const d of docs.slice(0, 20))
		for (const [k, v] of Object.entries(d))
			if (!types.has(k)) types.set(k, typeOf(v));
	return [...types].map(([name, type]) => ({
		name,
		type,
		nullable: name !== "_id",
		default: null,
		primaryKey: name === "_id",
	}));
}

export function mongoSchema(id: string): Promise<DatabaseSchema> {
	const w = worldOf(id);
	return delay({
		engine: "mongo",
		database: "shop",
		schemas: Object.entries(w)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, colls]) => ({
				name,
				tables: Object.entries(colls)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([c, coll]) => ({
						name: c,
						kind: coll.view ? ("view" as const) : ("collection" as const),
						rows: coll.view ? null : coll.docs.length,
						editable: !coll.view,
						columns: fields(coll.docs),
					})),
			})),
	});
}

const bad = (message: string) =>
	new ApiError(400, message, "bad_request", { reason: "query" });

function parse(text: string | undefined, name: string): Doc {
	if (!text?.trim()) return {};
	try {
		const v = JSON.parse(text, (k, x) => {
			if (k === "$where" || k === "$function" || k === "$accumulator")
				throw bad(`${k} is not allowed in ${name}`);
			return x;
		});
		return readable(
			EJSON.serialize(EJSON.deserialize(v), { relaxed: false }),
		) as Doc;
	} catch (e) {
		throw e instanceof ApiError ? e : bad(`${name} is not valid JSON`);
	}
}

const scalar = (v: unknown) => {
	const o = v as Record<string, string> | null;
	if (o && typeof o === "object" && !Array.isArray(o)) {
		const [k] = Object.keys(o);
		if (k === "$date" || k === "$oid") return String(o[k]);
		if (k?.startsWith("$number")) return Number(o[k as string]);
	}
	return v;
};
const get = (d: Doc, path: string) =>
	path.split(".").reduce<unknown>((x, k) => (x as Doc | null)?.[k], d);
const cmp = (a: unknown, b: unknown) => {
	const [x, y] = [scalar(a), scalar(b)];
	return x === y ? 0 : (x as number) < (y as number) ? -1 : 1;
};
const eq = (a: unknown, b: unknown) =>
	JSON.stringify(scalar(a)) === JSON.stringify(scalar(b));

function matches(d: Doc, f: Doc): boolean {
	return Object.entries(f).every(([k, cond]) => {
		if (k === "$and") return (cond as Doc[]).every((c) => matches(d, c));
		if (k === "$or") return (cond as Doc[]).some((c) => matches(d, c));
		if (k.startsWith("$")) throw bad(`unknown top level operator: ${k}`);
		const v = get(d, k);
		const ops =
			cond && typeof cond === "object" && !Array.isArray(cond)
				? Object.entries(cond as Doc)
				: [];
		if (!ops.length || !ops.every(([o]) => o.startsWith("$")))
			return Array.isArray(v) ? v.some((x) => eq(x, cond)) : eq(v, cond);
		return ops.every(([op, x]) => {
			switch (op) {
				case "$eq":
					return eq(v, x);
				case "$ne":
					return !eq(v, x);
				case "$gt":
					return v !== undefined && cmp(v, x) > 0;
				case "$gte":
					return v !== undefined && cmp(v, x) >= 0;
				case "$lt":
					return v !== undefined && cmp(v, x) < 0;
				case "$lte":
					return v !== undefined && cmp(v, x) <= 0;
				case "$in":
					return (x as unknown[]).some((y) => eq(v, y));
				case "$exists":
					return (v !== undefined) === !!x;
				case "$regex":
					return new RegExp(String(x)).test(String(v));
				default:
					throw bad(`unknown operator: ${op}`);
			}
		});
	});
}

function collOf(id: string, ref: CollectionRef): Coll {
	return worldOf(id)[ref.database]?.[ref.collection] ?? { docs: [] };
}

export async function mockDocuments(
	id: string,
	ref: CollectionRef,
	q: { filter?: string; sort?: string; projection?: string; cursor?: string },
): Promise<DocumentsPage> {
	const filter = parse(q.filter, "filter");
	const sort = Object.entries(parse(q.sort, "sort"));
	const projection = Object.entries(parse(q.projection, "projection")).filter(
		([k]) => k !== "_id",
	);
	const coll = collOf(id, ref);
	const view = (d: Doc) => readable(d) as Doc;
	let docs = coll.docs.filter((d) => matches(view(d), filter));
	if (sort.length)
		docs = [...docs].sort((a, b) => {
			for (const [k, dir] of sort) {
				const c = cmp(get(view(a), k), get(view(b), k));
				if (c) return Number(dir) < 0 ? -c : c;
			}
			return 0;
		});
	const include = projection.some(([, v]) => Number(v) === 1);
	const shaped = projection.length
		? docs.map((d) =>
				Object.fromEntries(
					Object.entries(d).filter(
						([k]) =>
							k === "_id" || projection.some(([p]) => p === k) === include,
					),
				),
			)
		: docs;
	const offset = Number(q.cursor || 0);
	return delay({
		documents: shaped.slice(offset, offset + PAGE),
		nextCursor: offset + PAGE < shaped.length ? String(offset + PAGE) : null,
	});
}

export async function mockWriteDocument(
	id: string,
	ref: CollectionRef,
	op: DocumentWrite,
) {
	await delay(null, 300);
	if (id.startsWith("svc_booking"))
		throw new ApiError(
			403,
			"You need write on this service to change its documents.",
			"forbidden",
		);
	const coll = collOf(id, ref);
	if (coll.view)
		throw bad(
			`Namespace ${ref.database}.${ref.collection} is a view, not a collection`,
		);
	if (op.op === "insert") {
		const doc = canonical({
			_id: new ObjectId(),
			...EJSON.deserialize(op.document),
		});
		coll.docs.unshift(doc);
		return { document: doc };
	}
	const at = coll.docs.findIndex((d) => keyOf(d._id) === keyOf(op.id));
	if (at < 0 || coll.ghosts?.has(keyOf(op.id))) {
		if (at >= 0) coll.docs.splice(at, 1);
		throw new ApiError(
			409,
			`no document in ${ref.database}.${ref.collection} has this _id`,
			"conflict",
			{ reason: "stale" },
		);
	}
	if (op.op === "delete") {
		coll.docs.splice(at, 1);
		return { document: null };
	}
	const doc = canonical({
		...EJSON.deserialize(op.document),
		_id: EJSON.deserialize({ v: op.id }).v,
	});
	coll.docs[at] = doc;
	return { document: doc };
}
