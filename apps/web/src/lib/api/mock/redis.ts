/*
 * The Redis slice of the database explorer's mock world. storefront/production's redis holds
 * user profiles as JSON strings, sessions and rate counters with TTLs, a 10 000-field price
 * hash, an order event stream, an email queue, a featured-tags set, a weekly leaderboard and a
 * binary thumbnail key; db 1 holds job queues and db 3 feature flags. `cart:abandoned` was
 * deleted by a teammate after the list loaded: opening or editing it shows the stale conflict.
 * llm-gateway's redis answers writes and commands with 403, as for a member with read only.
 * Commands run a small subset (GET, HGET, TTL, DBSIZE, EXISTS, TYPE, SET, DEL) and deny the
 * same commands as the api.
 */
import type {
	DatabaseSchema,
	RedisBytes,
	RedisCommand,
	RedisKey,
	RedisKeysPage,
	RedisReply,
	RedisValue,
	RedisWrite,
	RespValue,
} from "@logistack/contracts";
import { bytesId, bytesText } from "@/components/database/redis";
import { ApiError } from "../adapter";

type Pair = { field: RedisBytes; value: RedisBytes };
type Data =
	| { type: "string"; v: RedisBytes }
	| { type: "hash"; v: Map<string, Pair> }
	| { type: "list"; v: RedisBytes[] }
	| { type: "set"; v: Map<string, RedisBytes> }
	| { type: "zset"; v: Map<string, { member: RedisBytes; score: number }> }
	| { type: "stream"; v: { id: string; fields: Pair[] }[] };
type Entry = { key: RedisBytes; expiresAt: number | null; data: Data };
type Db = Map<string, Entry>;

const PAGE = 200;
const DATABASES = 16;
const delay = <T>(value: T, ms = 120 + Math.random() * 200): Promise<T> =>
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

const FIRST = ["Giulia", "Marco", "Sofia", "Luca", "Chiara", "Matteo", "Anna"];
const LAST = ["Rossi", "Bianchi", "Esposito", "Romano", "Colombo", "Ricci"];
const SKU = ["MUG-01", "TEE-M", "TEE-L", "CAP-02", "BAG-07", "PEN-11"];
const b64 = (bytes: number[]): RedisBytes => ({
	type: "base64",
	value: btoa(String.fromCharCode(...bytes)),
});

function build(seed: number): Db[] {
	const r = prng(seed);
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T;
	const now = Date.now();
	const dbs: Db[] = Array.from({ length: DATABASES }, () => new Map());
	const put = (db: number, key: RedisBytes, data: Data, ttlMs?: number) =>
		dbs[db]?.set(bytesId(key), {
			key,
			expiresAt: ttlMs ? now + ttlMs : null,
			data,
		});
	const hash = (pairs: [string, string][]): Data => ({
		type: "hash",
		v: new Map(pairs.map(([f, v]) => [bytesId(f), { field: f, value: v }])),
	});

	for (let i = 1; i <= 1500; i++)
		put(0, `user:${i}`, {
			type: "string",
			v: JSON.stringify({
				id: i,
				name: `${pick(FIRST)} ${pick(LAST)}`,
				plan: pick(["free", "pro", "team"]),
				tags: [pick(SKU)],
				verified: r() > 0.3,
			}),
		});
	for (let i = 0; i < 60; i++) {
		const hex = () =>
			Math.floor(r() * 2 ** 24)
				.toString(16)
				.padStart(6, "0");
		const sid = hex() + hex();
		put(
			0,
			`session:${sid}`,
			hash([
				["user", String(1 + Math.floor(r() * 1500))],
				["ip", `10.0.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`],
				["ua", "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6)"],
			]),
			60_000 + Math.floor(r() * 7_200_000),
		);
	}
	for (let i = 0; i < 24; i++)
		put(
			0,
			`rate:ip:203.0.113.${i}`,
			{ type: "string", v: String(1 + Math.floor(r() * 90)) },
			5_000 + Math.floor(r() * 55_000),
		);
	for (let i = 1; i <= 40; i++)
		put(
			0,
			`cart:${1000 + i}`,
			hash(
				Array.from({ length: 1 + Math.floor(r() * 4) }, () => [
					pick(SKU),
					String(1 + Math.floor(r() * 3)),
				]),
			),
		);
	put(0, "cart:abandoned", hash([["MUG-01", "2"]]));
	put(
		0,
		"catalog:prices",
		hash(
			Array.from({ length: 10_000 }, (_, i) => [
				`sku:${String(i).padStart(5, "0")}`,
				(2 + r() * 180).toFixed(2),
			]),
		),
	);
	put(0, "orders:events", {
		type: "stream",
		v: Array.from({ length: 640 }, (_, i) => ({
			id: `${now - (640 - i) * 93_000}-0`,
			fields: [
				{ field: "order", value: String(5000 + i) },
				{ field: "event", value: pick(["created", "paid", "shipped"]) },
				{ field: "total", value: (8 + r() * 200).toFixed(2) },
			],
		})),
	});
	put(0, "queue:emails", {
		type: "list",
		v: Array.from({ length: 320 }, (_, i) =>
			JSON.stringify({ to: `customer${i}@example.com`, template: "receipt" }),
		),
	});
	put(0, "tags:featured", {
		type: "set",
		v: new Map(
			Array.from({ length: 80 }, (_, i) => [
				bytesId(`tag-${i}`),
				`tag-${i}` as RedisBytes,
			]),
		),
	});
	put(0, "leaderboard:weekly", {
		type: "zset",
		v: new Map(
			Array.from({ length: 500 }, (_, i) => {
				const m = `player:${i}`;
				return [bytesId(m), { member: m, score: Math.round(r() * 10_000) }];
			}),
		),
	});
	put(0, "config:checkout", {
		type: "string",
		v: '{"currency":"EUR","freeShippingOver":49,"methods":["card","paypal"]}',
	});
	put(0, b64([0x69, 0x6d, 0x67, 0x3a, 0xff, 0xd8, 0x74]), {
		type: "string",
		v: b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
	});
	for (let i = 0; i < 6; i++)
		put(1, `jobs:${pick(["mail", "resize", "export"])}:${i}`, {
			type: "list",
			v: [`{"attempt":${i}}`],
		});
	for (const f of ["new-checkout", "dark-mode", "beta-search"])
		put(3, `feature:${f}`, { type: "string", v: r() > 0.5 ? "on" : "off" });
	// SCAN order is the hash table's, not insertion order.
	return dbs.map(
		(db) =>
			new Map(
				[...db]
					.map((e) => [r(), e] as const)
					.sort((a, b) => a[0] - b[0])
					.map(([, e]) => e),
			),
	);
}

const worlds = new Map<string, { dbs: Db[]; ghosts: Set<string> }>();
function worldOf(id: string) {
	let w = worlds.get(id);
	if (!w) {
		w = {
			dbs: build(id.length * 7919),
			ghosts: new Set([bytesId("cart:abandoned")]),
		};
		worlds.set(id, w);
	}
	return w;
}

/** The database, with expired keys dropped as Redis would. */
function dbOf(id: string, n: number): Db {
	const db = worldOf(id).dbs[n];
	if (!db)
		throw new ApiError(400, `there is no logical database ${n}`, "bad_request");
	const now = Date.now();
	for (const [k, e] of db) if (e.expiresAt && e.expiresAt <= now) db.delete(k);
	return db;
}

const readOnly = (id: string) => id.includes("llm-gateway");
const forbidden = () =>
	new ApiError(
		403,
		"You need write on this service to change its keys.",
		"forbidden",
	);
const stale = (message: string) =>
	new ApiError(409, message, "conflict", { reason: "stale" });

function globRegex(glob: string) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] as string;
		if (ch === "*") re += ".*";
		else if (ch === "?") re += ".";
		else if (ch === "\\") re += `\\${glob[++i] ?? "\\"}`;
		else if (ch === "[") {
			const end = glob.indexOf("]", i);
			re += end > i ? glob.slice(i, end + 1) : "\\[";
			if (end > i) i = end;
		} else re += ch.replace(/[.+^${}()|]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "s");
}

const size = (e: Entry) =>
	48 +
	JSON.stringify(e.data.v instanceof Map ? [...e.data.v.values()] : e.data.v)
		.length;

const describe = (e: Entry): RedisKey => ({
	key: e.key,
	type: e.data.type,
	ttlMs: e.expiresAt ? e.expiresAt - Date.now() : null,
	bytes: size(e),
});

export async function redisSchema(id: string): Promise<DatabaseSchema> {
	return delay({
		engine: "redis",
		database: "0",
		schemas: Array.from({ length: DATABASES }, (_, i) => ({
			name: String(i),
			tables: [],
			keys: dbOf(id, i).size,
		})),
	});
}

export async function mockKeys(
	id: string,
	q: { db: number; match: string; cursor?: string },
): Promise<RedisKeysPage> {
	const re = globRegex(q.match);
	const all = [...dbOf(id, q.db).values()];
	// SCAN walks the keyspace, not the matches; like the api, keep walking until a page matched.
	const keys: RedisKey[] = [];
	let at = Number(q.cursor || 0);
	while (at < all.length && keys.length < PAGE) {
		// Redis matches bytes; atob gives binary keys one char per byte.
		for (const e of all.slice(at, at + PAGE))
			if (re.test(typeof e.key === "string" ? e.key : atob(e.key.value)))
				keys.push(describe(e));
		at += PAGE;
	}
	return delay({ keys, cursor: at < all.length ? String(at) : null });
}

function entryOf(id: string, db: number, key: RedisBytes) {
	const k = bytesId(key);
	const w = worldOf(id);
	const e = dbOf(id, db).get(k);
	if (!e || w.ghosts.has(k)) {
		dbOf(id, db).delete(k);
		throw new ApiError(404, "no such key", "not_found", { reason: "missing" });
	}
	return e;
}

export async function mockKeyValue(
	id: string,
	q: { db: number; key: RedisBytes; cursor?: string },
): Promise<RedisValue> {
	const { data } = entryOf(id, q.db, q.key);
	const at = Number(q.cursor || 0);
	const page = <T>(xs: T[]) => ({
		slice: xs.slice(at, at + PAGE),
		length: xs.length,
		cursor: at + PAGE < xs.length ? String(at + PAGE) : null,
	});
	switch (data.type) {
		case "string":
			return delay({
				type: "string",
				value: data.v,
				truncated: false,
				length: bytesText(data.v).length,
			});
		case "hash": {
			const p = page([...data.v.values()]);
			return delay({
				type: "hash",
				entries: p.slice,
				length: p.length,
				cursor: p.cursor,
			});
		}
		case "list": {
			const p = page(data.v);
			return delay({
				type: "list",
				items: p.slice,
				length: p.length,
				cursor: p.cursor,
			});
		}
		case "set": {
			const p = page([...data.v.values()]);
			return delay({
				type: "set",
				members: p.slice,
				length: p.length,
				cursor: p.cursor,
			});
		}
		case "zset": {
			const p = page([...data.v.values()].sort((a, b) => a.score - b.score));
			return delay({
				type: "zset",
				members: p.slice.map((m) => ({
					member: m.member,
					score: String(m.score),
				})),
				length: p.length,
				cursor: p.cursor,
			});
		}
		case "stream": {
			const p = page(data.v);
			return delay({
				type: "stream",
				entries: p.slice,
				length: p.length,
				cursor: p.cursor,
			});
		}
	}
}

const OP_TYPE: Partial<Record<RedisWrite["op"], Data["type"]>> = {
	hset: "hash",
	hdel: "hash",
	sadd: "set",
	srem: "set",
	zadd: "zset",
	zrem: "zset",
	lset: "list",
};

export async function mockWriteKey(id: string, op: RedisWrite) {
	await delay(null, 260);
	if (readOnly(id)) throw forbidden();
	const db = dbOf(id, op.db);
	const k = bytesId(op.key);
	const ghost = worldOf(id).ghosts.has(k);
	const e = ghost ? undefined : db.get(k);
	if (ghost) db.delete(k);
	if (op.op === "set") {
		if (e && e.data.type !== "string")
			throw stale(`the key now holds a ${e.data.type}, not a string`);
		db.set(k, {
			key: op.key,
			expiresAt: op.ttlMs ? Date.now() + op.ttlMs : (e?.expiresAt ?? null),
			data: { type: "string", v: op.value },
		});
		return { key: describe(db.get(k) as Entry) };
	}
	if (!e) throw stale("the key no longer exists");
	const want = OP_TYPE[op.op];
	if (want && e.data.type !== want)
		throw stale(`the key now holds a ${e.data.type}, not a ${want}`);
	const d = e.data;
	const gone = (removed: boolean) => {
		if (!removed) throw stale("it was already removed");
	};
	switch (op.op) {
		case "hset":
			if (d.type === "hash")
				d.v.set(bytesId(op.field), { field: op.field, value: op.value });
			break;
		case "hdel":
			if (d.type === "hash") gone(d.v.delete(bytesId(op.field)));
			break;
		case "sadd":
			if (d.type === "set") d.v.set(bytesId(op.member), op.member);
			break;
		case "srem":
			if (d.type === "set") gone(d.v.delete(bytesId(op.member)));
			break;
		case "zadd":
			if (d.type === "zset")
				d.v.set(bytesId(op.member), { member: op.member, score: op.score });
			break;
		case "zrem":
			if (d.type === "zset") gone(d.v.delete(bytesId(op.member)));
			break;
		case "lset":
			if (d.type === "list") {
				const i = op.index < 0 ? d.v.length + op.index : op.index;
				if (i < 0 || i >= d.v.length)
					throw new ApiError(400, "ERR index out of range", "bad_request", {
						reason: "query",
					});
				d.v[i] = op.value;
			}
			break;
		case "expire":
			e.expiresAt = Date.now() + op.ttlMs;
			break;
		case "persist":
			e.expiresAt = null;
			break;
		case "delete":
			db.delete(k);
			return { key: null };
		case "rename": {
			const to = bytesId(op.to);
			if (db.has(to)) throw stale("a key with the new name already exists");
			db.delete(k);
			db.set(to, { ...e, key: op.to });
			return { key: describe(db.get(to) as Entry) };
		}
	}
	const empty =
		d.v instanceof Map ? !d.v.size : Array.isArray(d.v) && !d.v.length;
	if (empty) {
		db.delete(k);
		return { key: null };
	}
	return { key: describe(e) };
}

const DENIED =
	/^(FLUSHALL|FLUSHDB|CONFIG|DEBUG|SHUTDOWN|MONITOR|SYNC|PSYNC|REPLICAOF|SLAVEOF|MODULE|ACL|SCRIPT|EVAL\w*|FUNCTION|FCALL\w*|CLIENT|MIGRATE|SAVE|BGSAVE|BGREWRITEAOF|KEYS|P?S?SUBSCRIBE|SELECT|MULTI|WAIT)$/;

export async function mockCommand(
	id: string,
	{ db = 0, argv }: RedisCommand,
): Promise<RedisReply> {
	await delay(null, 90);
	if (readOnly(id)) throw forbidden();
	const [name = "", ...args] = argv.map(bytesText);
	const cmd = name.toUpperCase();
	if (DENIED.test(cmd))
		throw new ApiError(
			400,
			`database command: ${cmd} is not allowed from the explorer`,
			"bad_request",
			{
				reason: "query",
			},
		);
	const keys = dbOf(id, db);
	const e = args[0] ? keys.get(bytesId(args[0])) : undefined;
	const str = (v: RedisBytes): RespValue => ({ type: "string", value: v });
	const reply = ((): RespValue => {
		switch (cmd) {
			case "PING":
				return str("PONG");
			case "DBSIZE":
				return { type: "integer", value: keys.size };
			case "EXISTS":
				return { type: "integer", value: e ? 1 : 0 };
			case "TYPE":
				return str(e?.data.type ?? "none");
			case "TTL":
				return {
					type: "integer",
					value: !e
						? -2
						: e.expiresAt
							? Math.round((e.expiresAt - Date.now()) / 1000)
							: -1,
				};
			case "GET":
				if (!e) return { type: "null" };
				return e.data.type === "string"
					? str(e.data.v)
					: {
							type: "error",
							value:
								"WRONGTYPE Operation against a key holding the wrong kind of value",
						};
			case "HGET": {
				if (!e) return { type: "null" };
				if (e.data.type !== "hash")
					return {
						type: "error",
						value:
							"WRONGTYPE Operation against a key holding the wrong kind of value",
					};
				const v = e.data.v.get(bytesId(args[1] ?? ""));
				return v ? str(v.value) : { type: "null" };
			}
			case "HGETALL":
				if (e?.data.type !== "hash") return { type: "array", items: [] };
				return {
					type: "array",
					items: [...e.data.v.values()]
						.slice(0, 50)
						.flatMap((p) => [str(p.field), str(p.value)]),
				};
			case "SET":
				keys.set(bytesId(args[0] ?? ""), {
					key: args[0] ?? "",
					expiresAt: null,
					data: { type: "string", v: args[1] ?? "" },
				});
				return str("OK");
			case "DEL":
				return {
					type: "integer",
					value: args.filter((a) => keys.delete(bytesId(a))).length,
				};
			default:
				return {
					type: "error",
					value: `ERR the mock server doesn't run '${name}'`,
				};
		}
	})();
	return { reply, durationMs: 0.2 + Math.random() };
}
