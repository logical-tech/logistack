import {
	type DatabaseSchema,
	REDIS_STRING_MAX,
	type RedisBytes,
	type RedisKey,
	type RedisValue,
	type RedisWrite,
	type RespValue,
} from "@logistack/contracts";
import { Redis, ReplyError } from "ioredis";
import {
	type DatabaseConnection,
	DatabaseError,
	type KeyValueClient,
} from "./index.ts";

/** Commands the command box may run: reads, and writes of keys' data. Nothing else. */
const ALLOWED = new Set(
	`GET MGET STRLEN GETRANGE SUBSTR LCS EXISTS TYPE TTL PTTL EXPIRETIME PEXPIRETIME DBSIZE SCAN
	RANDOMKEY TOUCH OBJECT MEMORY PING ECHO TIME INFO
	HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSTRLEN HSCAN HRANDFIELD
	LRANGE LLEN LINDEX LPOS
	SMEMBERS SISMEMBER SMISMEMBER SCARD SSCAN SRANDMEMBER SINTER SUNION SDIFF SINTERCARD
	ZRANGE ZRANGEBYSCORE ZRANGEBYLEX ZREVRANGE ZREVRANGEBYSCORE ZREVRANGEBYLEX ZSCORE ZMSCORE
	ZCARD ZCOUNT ZLEXCOUNT ZRANK ZREVRANK ZSCAN ZRANDMEMBER
	XRANGE XREVRANGE XLEN XINFO XPENDING
	GETBIT BITCOUNT BITPOS PFCOUNT GEOPOS GEODIST GEOHASH GEOSEARCH
	SET SETNX SETEX PSETEX GETSET GETDEL GETEX MSET MSETNX APPEND SETRANGE
	INCR INCRBY INCRBYFLOAT DECR DECRBY DEL UNLINK COPY RENAME RENAMENX
	EXPIRE PEXPIRE EXPIREAT PEXPIREAT PERSIST
	HSET HSETNX HMSET HDEL HINCRBY HINCRBYFLOAT
	LPUSH RPUSH LPUSHX RPUSHX LPOP RPOP LSET LINSERT LREM LTRIM LMOVE RPOPLPUSH
	SADD SREM SPOP SMOVE SINTERSTORE SUNIONSTORE SDIFFSTORE
	ZADD ZREM ZINCRBY ZPOPMIN ZPOPMAX ZREMRANGEBYRANK ZREMRANGEBYSCORE ZREMRANGEBYLEX
	ZRANGESTORE ZUNIONSTORE ZINTERSTORE
	XADD XDEL XTRIM XACK
	SETBIT BITOP PFADD PFMERGE GEOADD`.split(/\s+/),
);

/**
 * Denied even if someone adds them above: server-wide, blocking, scripting, replication and
 * connection-state commands. SELECT, MULTI and WATCH would change the shared connection.
 */
const DENIED = new Set(
	`FLUSHALL FLUSHDB CONFIG DEBUG SHUTDOWN MONITOR SYNC PSYNC REPLICAOF SLAVEOF MODULE ACL
	SCRIPT EVAL EVALSHA EVAL_RO EVALSHA_RO FUNCTION FCALL FCALL_RO CLIENT MIGRATE SAVE BGSAVE
	BGREWRITEAOF KEYS SUBSCRIBE PSUBSCRIBE SSUBSCRIBE UNSUBSCRIBE PUNSUBSCRIBE SUNSUBSCRIBE
	PUBLISH WAIT WAITAOF SELECT SWAPDB MOVE MULTI EXEC WATCH UNWATCH DISCARD AUTH HELLO RESET
	QUIT BLPOP BRPOP BLMOVE BLMPOP BRPOPLPUSH BZPOPMIN BZPOPMAX BZMPOP XREAD XREADGROUP`.split(
		/\s+/,
	),
);

/** Why `argv` may not run, or null when it may. Case-insensitive, like Redis. */
export function deniedCommand(argv: string[]): string | null {
	const name = (argv[0] ?? "").toUpperCase();
	if (DENIED.has(name) || !ALLOWED.has(name))
		return `${name || "an empty command"} is not allowed from the explorer`;
	// MEMORY DOCTOR/PURGE/MALLOC-STATS reach the whole server; USAGE reads one key.
	if (name === "MEMORY" && (argv[1] ?? "").toUpperCase() !== "USAGE")
		return "only MEMORY USAGE is allowed from the explorer";
	return null;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Bytes as UTF-8 text when they are valid UTF-8, else tagged base64. */
export function redisBytes(b: Buffer): RedisBytes {
	try {
		return utf8.decode(b);
	} catch {
		return { type: "base64", value: b.toString("base64") };
	}
}

export const rawBytes = (v: RedisBytes) =>
	typeof v === "string" ? Buffer.from(v) : Buffer.from(v.value, "base64");

const text = (v: RedisBytes) => rawBytes(v).toString();

function resp(v: unknown): RespValue {
	if (v === null || v === undefined) return { type: "null" };
	if (typeof v === "number") return { type: "integer", value: v };
	if (Buffer.isBuffer(v)) return { type: "string", value: redisBytes(v) };
	if (Array.isArray(v)) return { type: "array", items: v.map(resp) };
	if (v instanceof Error) return { type: "error", value: v.message };
	return { type: "string", value: String(v) };
}

const UNREACHABLE = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ECONNRESET",
	"EPIPE",
]);

const authFailed = (message: string) => /NOAUTH|WRONGPASS/.test(message);

function wrap(op: string, e: unknown): DatabaseError {
	if (e instanceof DatabaseError) return e;
	const message = e instanceof Error ? e.message : String(e);
	if (authFailed(message)) return new DatabaseError(op, message, "auth");
	const err = e as { name?: string; code?: string };
	if (
		err.name === "MaxRetriesPerRequestError" ||
		UNREACHABLE.has(err.code ?? "") ||
		/Connection is closed|connect ETIMEDOUT/.test(message)
	)
		return new DatabaseError(op, message, "unreachable");
	if (message === "Command timed out")
		return new DatabaseError(op, message, "query", "timeout");
	return new DatabaseError(
		op,
		message,
		"query",
		e instanceof ReplyError ? message.split(" ")[0] : undefined,
	);
}

/** The type each op edits; null means any existing key. `set` is checked on its own. */
const OP_TYPE: Record<RedisWrite["op"], string | null> = {
	set: "string",
	hset: "hash",
	hdel: "hash",
	sadd: "set",
	srem: "set",
	zadd: "zset",
	zrem: "zset",
	lset: "list",
	expire: null,
	persist: null,
	delete: null,
	rename: null,
};

/** Ops that answer 0 when the field or member was already gone. */
const REMOVES = new Set<RedisWrite["op"]>(["hdel", "srem", "zrem"]);

function opArgv(op: RedisWrite, k: Buffer): (string | Buffer)[] {
	switch (op.op) {
		case "set":
			// Without a TTL an edit keeps the key's current one rather than clearing it.
			return op.ttlMs
				? ["SET", k, rawBytes(op.value), "PX", String(op.ttlMs)]
				: ["SET", k, rawBytes(op.value), "KEEPTTL"];
		case "hset":
			return ["HSET", k, rawBytes(op.field), rawBytes(op.value)];
		case "hdel":
			return ["HDEL", k, rawBytes(op.field)];
		case "sadd":
			return ["SADD", k, rawBytes(op.member)];
		case "srem":
			return ["SREM", k, rawBytes(op.member)];
		case "zadd":
			return ["ZADD", k, String(op.score), rawBytes(op.member)];
		case "zrem":
			return ["ZREM", k, rawBytes(op.member)];
		case "lset":
			return ["LSET", k, String(op.index), rawBytes(op.value)];
		case "expire":
			return ["PEXPIRE", k, String(op.ttlMs)];
		case "persist":
			return ["PERSIST", k];
		case "delete":
			return ["DEL", k];
		case "rename":
			return ["RENAMENX", k, rawBytes(op.to)];
	}
}

/** Pairs a flat [a, b, a, b] reply. */
function pairs(flat: Buffer[]): [Buffer, Buffer][] {
	const out: [Buffer, Buffer][] = [];
	for (let i = 0; i + 1 < flat.length; i += 2)
		out.push([flat[i] as Buffer, flat[i + 1] as Buffer]);
	return out;
}

export function redisClient(conn: DatabaseConnection): KeyValueClient {
	const options = {
		host: conn.host,
		port: conn.port,
		password: conn.password,
		connectionName: "logistack-explorer",
		connectTimeout: 5000,
		commandTimeout: conn.statementTimeoutMs ?? 30_000,
		// One retry, then the command fails, so a dead host answers `unreachable` instead of hanging.
		maxRetriesPerRequest: 1,
		retryStrategy: (n: number) => Math.min(n * 250, 2000),
	};
	// shortcut: one connection per logical database, kept until the credentials change; add an idle close if many dbs get opened.
	const conns = new Map<number, Redis>();
	const connect = (db: number) => {
		let c = conns.get(db);
		if (!c) {
			c = new Redis({ ...options, db });
			// Failures reach the caller through its command; the event would only be unhandled noise.
			c.on("error", () => {});
			conns.set(db, c);
		}
		return c;
	};
	let databases: Promise<number> | undefined;
	/** How many logical databases the server has. CONFIG is often renamed away; 16 is Redis's default. */
	const dbCount = () => {
		databases ??= connect(0)
			.call("CONFIG", ["GET", "databases"])
			.then(
				(r) => Math.min(Number((r as string[])[1]) || 16, 256),
				(e) => {
					databases = undefined;
					if (e instanceof ReplyError && !authFailed((e as Error).message))
						return 16;
					throw e;
				},
			);
		return databases;
	};
	/**
	 * The connection to logical database `db`. Checked first: ioredis falls back to db 0 when its
	 * SELECT fails, which would show, or write, the wrong database's keys.
	 */
	const on = async (op: string, db: number) => {
		try {
			if (db < (await dbCount())) return connect(db);
		} catch (e) {
			throw wrap(op, e);
		}
		throw new DatabaseError(op, `there is no logical database ${db}`, "query");
	};

	/** TYPE, PTTL and MEMORY USAGE of each key, in one round trip; keys gone meanwhile drop out. */
	async function describe(c: Redis, keys: Buffer[]): Promise<RedisKey[]> {
		const rows = await Promise.all(
			keys.map((k) =>
				Promise.all([
					c.type(k),
					c.pttl(k),
					c.call("MEMORY", ["USAGE", k]).catch(() => null),
				]),
			),
		);
		return rows.flatMap(([type, ttl, bytes], i) =>
			type === "none" || ttl === -2
				? []
				: [
						{
							key: redisBytes(keys[i] as Buffer),
							type,
							ttlMs: ttl < 0 ? null : ttl,
							bytes: typeof bytes === "number" ? bytes : null,
						},
					],
		);
	}

	return {
		kind: "kv",
		async introspect(): Promise<DatabaseSchema> {
			try {
				const [info, n] = await Promise.all([
					connect(0).info("keyspace"),
					dbCount(),
				]);
				const keys = new Map(
					[...info.matchAll(/^db(\d+):keys=(\d+)/gm)].map((m) => [
						Number(m[1]),
						Number(m[2]),
					]),
				);
				return {
					engine: "redis",
					database: "0",
					schemas: Array.from({ length: n }, (_, i) => ({
						name: String(i),
						tables: [],
						keys: keys.get(i) ?? 0,
					})),
				};
			} catch (e) {
				throw wrap("introspect", e);
			}
		},

		async keys(db, { match, cursor, count }) {
			const c = await on("keys", db);
			const found = new Map<string, Buffer>();
			let at = cursor ?? "0";
			// A sparse pattern can come back empty for many batches; keep going briefly before answering.
			const until = Date.now() + 250;
			try {
				do {
					const [next, batch] = (await c.callBuffer("SCAN", [
						at,
						"MATCH",
						match,
						"COUNT",
						String(count),
					])) as [Buffer, Buffer[]];
					at = next.toString();
					for (const k of batch) found.set(k.toString("base64"), k);
				} while (at !== "0" && found.size < count && Date.now() < until);
				return {
					keys: await describe(c, [...found.values()]),
					cursor: at === "0" ? null : at,
				};
			} catch (e) {
				throw wrap("keys", e);
			}
		},

		async value(db, key, { cursor, count }): Promise<RedisValue> {
			const c = await on("value", db);
			const k = rawBytes(key);
			const offset = Number(cursor ?? 0);
			const scan = async (cmd: string, len: string) => {
				const [length, [next, flat]] = await Promise.all([
					c.call(len, [k]) as Promise<number>,
					c.callBuffer(cmd, [
						k,
						cursor ?? "0",
						"COUNT",
						String(count),
					]) as Promise<[Buffer, Buffer[]]>,
				]);
				const at = next.toString();
				return { length, flat, cursor: at === "0" ? null : at };
			};
			const window = async (cmd: string[], len: string) => {
				if (!Number.isSafeInteger(offset) || offset < 0)
					throw new DatabaseError("value", "cursor is not an offset", "query");
				const [length, flat] = (await Promise.all([
					c.call(len, [k]),
					c.callBuffer(cmd[0] as string, [
						k,
						String(offset),
						String(offset + count - 1),
						...cmd.slice(1),
					]),
				])) as [number, Buffer[]];
				return { length, flat, more: offset + count < length };
			};
			try {
				const type = await c.type(k);
				switch (type) {
					case "none":
						throw new DatabaseError("value", "no such key", "missing");
					case "string": {
						const [length, value] = (await Promise.all([
							c.strlen(k),
							c.callBuffer("GETRANGE", [k, "0", String(REDIS_STRING_MAX - 1)]),
						])) as [number, Buffer];
						return {
							type,
							value: redisBytes(value),
							truncated: length > REDIS_STRING_MAX,
							length,
						};
					}
					case "hash": {
						const r = await scan("HSCAN", "HLEN");
						return {
							type,
							entries: pairs(r.flat).map(([f, v]) => ({
								field: redisBytes(f),
								value: redisBytes(v),
							})),
							length: r.length,
							cursor: r.cursor,
						};
					}
					case "set": {
						const r = await scan("SSCAN", "SCARD");
						return {
							type,
							members: r.flat.map(redisBytes),
							length: r.length,
							cursor: r.cursor,
						};
					}
					case "list": {
						const r = await window(["LRANGE"], "LLEN");
						return {
							type,
							items: r.flat.map(redisBytes),
							length: r.length,
							cursor: r.more ? String(offset + count) : null,
						};
					}
					case "zset": {
						// By rank, so members read in score order (ZSCAN's order is the hash table's).
						const r = await window(["ZRANGE", "WITHSCORES"], "ZCARD");
						return {
							type,
							members: pairs(r.flat).map(([m, s]) => ({
								member: redisBytes(m),
								score: s.toString(),
							})),
							length: r.length,
							cursor: r.more ? String(offset + count) : null,
						};
					}
					case "stream": {
						const [length, entries] = (await Promise.all([
							c.xlen(k),
							c.callBuffer("XRANGE", [
								k,
								cursor ? `(${cursor}` : "-",
								"+",
								"COUNT",
								String(count + 1),
							]),
						])) as [number, [Buffer, Buffer[]][]];
						const page = entries.slice(0, count);
						return {
							type,
							entries: page.map(([id, flat]) => ({
								id: id.toString(),
								fields: pairs(flat).map(([f, v]) => ({
									field: redisBytes(f),
									value: redisBytes(v),
								})),
							})),
							length,
							cursor:
								entries.length > count
									? (page.at(-1)?.[0].toString() ?? null)
									: null,
						};
					}
					default:
						throw new DatabaseError(
							"value",
							`${type} values can't be shown; use the command box`,
							"unsupported",
						);
				}
			} catch (e) {
				throw wrap("value", e);
			}
		},

		async write(op) {
			const k = rawBytes(op.key);
			const stale = (why: string) => new DatabaseError("write", why, "stale");
			// WATCH is per connection, so each write takes its own instead of the shared one.
			const w = (await on("write", op.db)).duplicate();
			w.on("error", () => {});
			try {
				await w.watch(k);
				const type = await w.type(k);
				const want = OP_TYPE[op.op];
				if (op.op === "set") {
					if (type !== "none" && type !== "string")
						throw stale(`the key now holds a ${type}, not a string`);
				} else if (type === "none") throw stale("the key no longer exists");
				else if (want && type !== want)
					throw stale(`the key now holds a ${type}, not a ${want}`);
				const [cmd, ...args] = opArgv(op, k);
				const result = await w
					.multi()
					.callBuffer(cmd as string, args)
					.exec();
				// EXEC returns null when the watched key changed after the check.
				if (!result) throw stale("the key changed while saving");
				const [err, reply] = result[0] as [Error | null, unknown];
				if (err) throw err;
				if (reply === 0 && op.op === "rename")
					throw stale("a key with the new name already exists");
				if (reply === 0 && REMOVES.has(op.op))
					throw stale("it was already removed");
				const after = op.op === "rename" ? rawBytes(op.to) : k;
				const [key] = await describe(connect(op.db), [after]);
				return { key: key ?? null };
			} catch (e) {
				throw wrap("write", e);
			} finally {
				w.disconnect();
			}
		},

		async command(db, argv) {
			const words = argv.map(text);
			const denied = deniedCommand(words);
			if (denied) throw new DatabaseError("command", denied, "query");
			const started = performance.now();
			try {
				const reply = await (await on("command", db)).callBuffer(
					(words[0] as string).toUpperCase(),
					argv.slice(1).map(rawBytes),
				);
				return { reply: resp(reply), durationMs: performance.now() - started };
			} catch (e) {
				if (e instanceof ReplyError && !authFailed((e as Error).message))
					return {
						reply: { type: "error", value: (e as Error).message },
						durationMs: performance.now() - started,
					};
				throw wrap("command", e);
			}
		},

		async close() {
			for (const c of conns.values()) c.disconnect();
			conns.clear();
		},
	};
}
