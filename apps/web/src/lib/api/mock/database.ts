/*
 * The database explorer's mock world. storefront/production is a shop database with a 10k-row
 * orders table, a view, a materialized view, a table without a primary key and a second schema.
 * storefront/staging is unreachable until it is redeployed. booking/production answers writes
 * with 403, as for a member with read only. Customer 7 was deleted by a teammate after the
 * page loaded: editing it shows the stale conflict.
 */
import type {
	Cell,
	DatabaseSchema,
	DbColumn,
	DbTable,
	RowPatch,
	RowsPage,
} from "@logistack/contracts";
import { cellText } from "@/components/database/cells";
import { ApiError } from "../adapter";
import type { DatabaseApi } from "../database";
import { mockDb } from ".";

const delay = <T>(value: T, ms = 140 + Math.random() * 240): Promise<T> =>
	new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
const LOADED = Date.now();
const PAGE = 200;

type MockTable = {
	schema: string;
	name: string;
	kind: DbTable["kind"];
	columns: DbColumn[];
	rows: Cell[][];
	/** The planner never analyzed it. */
	unanalyzed?: boolean;
	/** Rows still listed but already deleted by someone else. */
	ghosts?: Set<string>;
};
type World = { database: string; tables: MockTable[] };

function prng(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const col = (
	name: string,
	type: string,
	opts: { pk?: boolean; nullable?: boolean; default?: string } = {},
): DbColumn => ({
	name,
	type,
	nullable: opts.nullable ?? false,
	default: opts.default ?? null,
	primaryKey: opts.pk ?? false,
});
const serial = (table: string, type: "integer" | "bigint" = "integer") =>
	col("id", type, {
		pk: true,
		default: `nextval('${table}_id_seq'::regclass)`,
	});

const ts = (ms: number) =>
	new Date(ms).toISOString().replace("T", " ").replace("Z", "+00");
const big = (n: number | string): Cell => ({
	type: "bigint",
	value: String(n),
});
const money = (n: number): Cell => ({ type: "numeric", value: n.toFixed(2) });
const json = (v: unknown): Cell => ({
	type: "json",
	value: JSON.stringify(v).replace(/":/g, '": ').replace(/,"/g, ', "'),
});

const FIRST = [
	"Giulia",
	"Marco",
	"Sofia",
	"Luca",
	"Emma",
	"Noah",
	"Lea",
	"Jonas",
	"Clara",
	"Mateo",
	"Ines",
	"Hugo",
	"Alba",
	"Felix",
	"Nora",
	"Elias",
	"Mila",
	"Leon",
	"Anna",
	"Paul",
];
const LAST = [
	"Rossi",
	"Bianchi",
	"Müller",
	"Schmidt",
	"Martin",
	"Bernard",
	"García",
	"López",
	"de Vries",
	"Jansen",
	"Gruber",
	"Huber",
	"Keller",
	"Andersson",
	"Smith",
	"Moretti",
	"Fischer",
	"Dubois",
	"Romero",
	"Weber",
];
const COUNTRIES = ["IT", "DE", "FR", "ES", "NL", "AT", "CH", "SE", "GB", "US"];
const STATUSES = [
	"pending",
	"paid",
	"paid",
	"shipped",
	"shipped",
	"shipped",
	"delivered",
	"delivered",
	"refunded",
	"cancelled",
];
const WOODS = ["oak", "walnut", "ash", "beech", "cherry", "elm"];
const PIECES = [
	"lounge-chair",
	"dining-chair",
	"stool",
	"side-table",
	"bench",
	"shelf",
	"desk",
	"bed-frame",
	"sideboard",
	"coffee-table",
];
const PATHS = [
	"/",
	"/chairs",
	"/tables",
	"/lamps",
	"/cart",
	"/checkout",
	"/account",
	"/journal/caring-for-oak",
	"/products/oak-lounge-chair",
	"/search?q=walnut",
];
const ACTIONS = [
	"order.refund",
	"product.update",
	"price.change",
	"customer.merge",
	"stock.adjust",
	"coupon.create",
];

function storefront(seed: number): World {
	const r = prng(seed);
	const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;
	const hex = (n: number) =>
		Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");
	const day = 86_400_000;
	const start = LOADED - 420 * day;

	const customers = Array.from({ length: 1240 }, (_, i): Cell[] => {
		const first = pick(FIRST);
		const last = pick(LAST);
		return [
			i + 1,
			`${first}.${last}${i}@example.com`
				.toLowerCase()
				.replace(/[^a-z0-9.@]/g, ""),
			`${first} ${last}`,
			pick(COUNTRIES),
			r() < 0.38,
			money(r() < 0.1 ? 0 : r() * 2400),
			ts(start + i * (day / 3.1)),
			r() < 0.06 ? "Prefers delivery after 17:00" : null,
		];
	});

	const products = WOODS.flatMap((w, wi) =>
		PIECES.map((p, pi): Cell[] => [
			`${w.slice(0, 3).toUpperCase()}-${String(pi + 1).padStart(3, "0")}`,
			`${w[0]?.toUpperCase()}${w.slice(1)} ${p.replace("-", " ")}`,
			money(120 + ((wi * 7 + pi * 13) % 40) * 22.5),
			Math.floor(r() * 80),
			`{${w},${p.split("-").pop()}}`,
			Math.round((3 + r() * 40) * 10) / 10,
			pi % 4 === 0 ? `\\x89504e470d0a1a0a${hex(24)}` : null,
			json({
				finish: pick(["oiled", "lacquered", "raw"]),
				lead_time_days: 7 + pi,
			}),
			r() > 0.08,
		]),
	);
	const skus = products.map((p) => p[0] as string);

	const orders = Array.from({ length: 10_000 }, (_, i): Cell[] => {
		const placed = start + i * ((420 * day) / 10_000) + r() * 3_600_000;
		const status = pick(STATUSES);
		const shipped = ["shipped", "delivered"].includes(status);
		return [
			big(100_000 + i + 1),
			1 + Math.floor(r() * 1240),
			status,
			money(35 + r() * 1800),
			r() < 0.9 ? "EUR" : pick(["CHF", "GBP", "SEK"]),
			ts(placed),
			shipped ? ts(placed + (1 + r() * 4) * day) : null,
			r() < 0.3
				? json({ channel: pick(["web", "ios", "showroom"]), gift: r() < 0.2 })
				: null,
		];
	});

	const items = orders
		.slice(0, 150)
		.flatMap((o) =>
			Array.from({ length: 1 + Math.floor(r() * 3) }, (_, line): Cell[] => [
				o[0] ?? null,
				line + 1,
				pick(skus),
				1 + Math.floor(r() * 3),
				money(90 + r() * 900),
			]),
		);

	const views = Array.from({ length: 800 }, (_, i): Cell[] => [
		`${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`,
		pick(PATHS),
		r() < 0.4
			? pick([
					"https://www.google.com/",
					"https://instagram.com/",
					"https://www.pinterest.com/",
				])
			: null,
		ts(LOADED - (800 - i) * 97_000),
	]);

	const daily = Array.from({ length: 60 }, (_, i): Cell[] => [
		new Date(LOADED - (60 - i) * day).toISOString().slice(0, 10),
		18 + Math.floor(r() * 30),
		money(1400 + r() * 9000),
	]);

	const events = Array.from({ length: 300 }, (_, i): Cell[] => [
		big(i + 1),
		pick(["giulia@storefront.it", "marco@storefront.it", "deploy-bot"]),
		pick(ACTIONS),
		`${pick(["order", "product", "customer"])}:${Math.floor(r() * 9000)}`,
		ts(LOADED - (300 - i) * 3_100_000),
	]);

	return {
		database: "storefront",
		tables: [
			{
				schema: "public",
				name: "customers",
				kind: "table",
				columns: [
					serial("customers"),
					col("email", "text"),
					col("full_name", "text"),
					col("country", "character(2)", { nullable: true }),
					col("marketing_opt_in", "boolean", { default: "false" }),
					col("lifetime_value", "numeric(10,2)", { default: "0" }),
					col("created_at", "timestamp with time zone", { default: "now()" }),
					col("notes", "text", { nullable: true }),
				],
				rows: customers,
				ghosts: new Set([JSON.stringify({ id: 7 })]),
			},
			{
				schema: "public",
				name: "orders",
				kind: "table",
				columns: [
					serial("orders", "bigint"),
					col("customer_id", "integer"),
					col("status", "text", { default: "'pending'::text" }),
					col("total", "numeric(10,2)"),
					col("currency", "character(3)", { default: "'EUR'::bpchar" }),
					col("placed_at", "timestamp with time zone", { default: "now()" }),
					col("shipped_at", "timestamp with time zone", { nullable: true }),
					col("metadata", "jsonb", { nullable: true }),
				],
				rows: orders,
			},
			{
				schema: "public",
				name: "order_items",
				kind: "table",
				columns: [
					col("order_id", "bigint", { pk: true }),
					col("line", "smallint", { pk: true }),
					col("sku", "character varying(32)"),
					col("quantity", "integer", { default: "1" }),
					col("unit_price", "numeric(10,2)"),
				],
				rows: items,
			},
			{
				schema: "public",
				name: "products",
				kind: "table",
				columns: [
					col("sku", "character varying(32)", { pk: true }),
					col("title", "text"),
					col("price", "numeric(10,2)"),
					col("stock", "integer", { default: "0" }),
					col("tags", "text[]", { default: "'{}'::text[]" }),
					col("weight_kg", "real", { nullable: true }),
					col("thumbnail", "bytea", { nullable: true }),
					col("attributes", "jsonb", { default: "'{}'::jsonb" }),
					col("active", "boolean", { default: "true" }),
				],
				rows: products,
			},
			{
				schema: "public",
				name: "page_views",
				kind: "table",
				columns: [
					col("session_id", "uuid"),
					col("path", "text"),
					col("referrer", "text", { nullable: true }),
					col("viewed_at", "timestamp with time zone", { default: "now()" }),
				],
				rows: views,
			},
			{
				schema: "public",
				name: "order_totals_daily",
				kind: "view",
				columns: [
					col("day", "date", { nullable: true }),
					col("orders", "integer", { nullable: true }),
					col("revenue", "numeric", { nullable: true }),
				],
				rows: daily,
			},
			{
				schema: "public",
				name: "top_products",
				kind: "materialized_view",
				columns: [
					col("sku", "character varying(32)", { nullable: true }),
					col("units", "bigint", { nullable: true }),
				],
				rows: skus.slice(0, 20).map((s, i) => [s, big(900 - i * 37)]),
			},
			{
				schema: "audit",
				name: "events",
				kind: "table",
				columns: [
					serial("events", "bigint"),
					col("actor", "text"),
					col("action", "text"),
					col("target", "text"),
					col("at", "timestamp with time zone", { default: "now()" }),
				],
				rows: events,
				unanalyzed: true,
			},
		],
	};
}

const worlds = new Map<string, World>();
function worldOf(id: string): World {
	if (
		id === "svc_storefront_staging_postgres" &&
		!mockDb.deployments.some(
			(d) =>
				d.serviceId === id &&
				d.status === "healthy" &&
				Date.parse(d.createdAt) > LOADED,
		)
	)
		throw new ApiError(
			409,
			`getaddrinfo ENOTFOUND ls-svc-${id.slice(-8)} (a database deployed before the explorer existed needs a redeploy to join its network)`,
			"conflict",
			{ reason: "unreachable", engineCode: "ENOTFOUND" },
		);
	let w = worlds.get(id);
	if (!w) {
		w = storefront(id.length * 7919);
		if (id.startsWith("svc_booking")) w.database = "booking";
		worlds.set(id, w);
	}
	return w;
}

function tableOf(w: World, schema: string, table: string): MockTable {
	const t = w.tables.find((x) => x.schema === schema && x.name === table);
	if (!t)
		throw new ApiError(
			409,
			`relation "${schema}.${table}" does not exist`,
			"conflict",
			{ reason: "query", engineCode: "42P01" },
		);
	return t;
}

const editable = (t: MockTable) =>
	t.kind === "table" && t.columns.some((c) => c.primaryKey);

const num = (c: Cell | string) =>
	typeof c === "number"
		? c
		: c !== null &&
				typeof c === "object" &&
				(c.type === "bigint" || c.type === "numeric")
			? Number(c.value)
			: null;

function compare(a: Cell, b: Cell): number {
	if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
	const na = num(a);
	const nb = num(b);
	if (na !== null && nb !== null) return na - nb;
	return cellText(a).localeCompare(cellText(b));
}

const NUMERIC = /^(smallint|integer|bigint|real|double precision|numeric)/;

function matches(
	cell: Cell,
	column: DbColumn,
	op: string,
	value = "",
): boolean {
	if (op === "is_null") return cell === null;
	if (op === "not_null") return cell !== null;
	if (cell === null) return false;
	const text = cellText(cell);
	if (op === "contains") return text.includes(value);
	if (op === "starts_with") return text.startsWith(value);
	const c = NUMERIC.test(column.type)
		? (num(cell) ?? 0) - Number(value)
		: text.localeCompare(value);
	return {
		eq: c === 0,
		neq: c !== 0,
		lt: c < 0,
		gt: c > 0,
		lte: c <= 0,
		gte: c >= 0,
	}[op] as boolean;
}

function invalid(column: DbColumn, v: Cell): string | null {
	if (v === null)
		return column.nullable
			? null
			: `null value in column "${column.name}" violates not-null constraint`;
	const t = column.type;
	const text = cellText(v);
	const bad = `invalid input syntax for type ${t.replace(/\(.*\)/, "")}: "${text}"`;
	if (/^(smallint|integer|bigint)$/.test(t) && !/^-?\d+$/.test(text))
		return bad;
	if (/^(numeric|real|double)/.test(t) && !Number.isFinite(Number(text)))
		return bad;
	if (t === "boolean" && typeof v !== "boolean") return bad;
	if (t === "jsonb" || t === "json")
		try {
			JSON.parse(text);
		} catch {
			return `invalid input syntax for type json`;
		}
	return null;
}

function defaultFor(t: MockTable, column: DbColumn): Cell {
	const d = column.default;
	if (!d) return null;
	if (d.startsWith("nextval")) {
		const max = Math.max(0, ...t.rows.map((r) => num(r[0] ?? null) ?? 0));
		return column.type === "bigint" ? big(max + 1) : max + 1;
	}
	if (d === "now()") return ts(Date.now());
	if (d === "true" || d === "false") return d === "true";
	if (/^-?\d+$/.test(d))
		return column.type.startsWith("numeric") ? money(Number(d)) : Number(d);
	const literal = d.match(/^'(.*)'::/)?.[1] ?? d;
	return column.type === "jsonb" ? { type: "json", value: literal } : literal;
}

const keyOf = (t: MockTable, row: Cell[]) =>
	Object.fromEntries(
		t.columns.flatMap((c, i) =>
			c.primaryKey ? [[c.name, row[i] ?? null]] : [],
		),
	);

function write(t: MockTable, ops: RowPatch[]) {
	const rows = [...t.rows];
	const key = (row: Cell[], k: Record<string, Cell>) =>
		t.columns.every(
			(c, i) =>
				!c.primaryKey ||
				cellText(row[i] ?? null) === cellText(k[c.name] ?? null),
		) && !t.ghosts?.has(JSON.stringify(k));
	const written = ops.map((op, i) => {
		if (op.op !== "insert") {
			const hits = rows.flatMap((row, at) => (key(row, op.key) ? [at] : []));
			if (hits.length !== 1) {
				// The teammate's delete shows up on the next read.
				if (t.ghosts?.size) {
					t.rows = t.rows.filter(
						(row) => !t.ghosts?.has(JSON.stringify(keyOf(t, row))),
					);
					t.ghosts.clear();
				}
				throw new ApiError(
					409,
					`op ${i} (${op.op}) matched ${hits.length} rows, expected 1; nothing was written`,
					"conflict",
					{ reason: "stale" },
				);
			}
			const at = hits[0] as number;
			if (op.op === "delete") {
				rows.splice(at, 1);
				return null;
			}
			const next = t.columns.map((c, ci) =>
				c.name in op.values
					? (op.values[c.name] ?? null)
					: (rows[at]?.[ci] ?? null),
			);
			rows[at] = next;
			return next;
		}
		const next = t.columns.map((c) =>
			c.name in op.values
				? (op.values[c.name] ?? null)
				: defaultFor({ ...t, rows }, c),
		);
		rows.push(next);
		return next;
	});
	for (const row of written)
		row?.forEach((v, ci) => {
			const column = t.columns[ci] as DbColumn;
			const problem = invalid(column, v);
			if (problem)
				throw new ApiError(400, problem, "bad_request", { reason: "query" });
		});
	t.rows = rows;
	return { rows: written };
}

export const mockDatabase: DatabaseApi = {
	schema: async (id) => {
		const w = worldOf(id);
		const schemas = [...new Set(w.tables.map((t) => t.schema))];
		const value: DatabaseSchema = {
			engine: "postgres",
			database: w.database,
			schemas: schemas.map((name) => ({
				name,
				tables: w.tables
					.filter((t) => t.schema === name)
					.map((t) => ({
						name: t.name,
						kind: t.kind,
						rows: t.unanalyzed ? null : t.rows.length,
						editable: editable(t),
						columns: t.columns,
					})),
			})),
		};
		return delay(value);
	},
	rows: async (id, ref, { sort, filter, cursor }) => {
		const t = tableOf(worldOf(id), ref.schema, ref.table);
		const at = (name: string) => {
			const i = t.columns.findIndex((c) => c.name === name);
			if (i < 0)
				throw new ApiError(400, `unknown column ${name}`, "validation_failed");
			return i;
		};
		let rows = t.rows.filter((row) =>
			filter.every((f) => {
				const i = at(f.column);
				return matches(row[i] ?? null, t.columns[i] as DbColumn, f.op, f.value);
			}),
		);
		const order = sort.length
			? sort
			: t.columns
					.filter((c) => c.primaryKey)
					.map((c) => ({ column: c.name, desc: false }));
		if (order.length) {
			const keys = order.map((s) => ({ i: at(s.column), desc: s.desc }));
			rows = [...rows].sort((a, b) => {
				for (const k of keys) {
					const c = compare(a[k.i] ?? null, b[k.i] ?? null);
					if (c) return k.desc ? -c : c;
				}
				return 0;
			});
		}
		const offset = Number(cursor ?? 0);
		const page: RowsPage = {
			columns: t.columns,
			editable: editable(t),
			rows: rows.slice(offset, offset + PAGE),
			nextCursor: offset + PAGE < rows.length ? String(offset + PAGE) : null,
		};
		return delay(page);
	},
	write: async (id, ref, ops) => {
		const t = tableOf(worldOf(id), ref.schema, ref.table);
		if (id.startsWith("svc_booking"))
			throw new ApiError(
				403,
				"You need write on this service to change its rows.",
				"forbidden",
			);
		if (!editable(t))
			throw new ApiError(
				400,
				`${ref.schema}.${ref.table} has no primary key; rows can't be edited`,
				"bad_request",
			);
		return delay(write(t, ops), 300);
	},
};
