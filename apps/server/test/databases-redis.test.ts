import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt } from "@logistack/core";
import { auditLog, envVar } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const name = `ls-test-dbx-${crypto.randomUUID().slice(0, 8)}-redis`;
const PASSWORD = "test redis password";

function docker(...args: string[]) {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args[0]} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

async function startRedis() {
	docker(
		"run",
		"-d",
		"--name",
		name,
		"--label",
		"logistack.test=dbx",
		"-p",
		"127.0.0.1::6379",
		"redis:7-alpine",
		"redis-server",
		"--requirepass",
		PASSWORD,
	);
	const [host, port] = (
		docker("port", name, "6379/tcp").split("\n")[0] ?? ""
	).split(":") as [string, string];
	const target = { host, port: Number(port) };
	const deadline = Date.now() + 60_000;
	for (;;) {
		const c = new Redis({ ...target, password: PASSWORD, lazyConnect: true });
		c.on("error", () => {});
		try {
			await c.connect();
			await c.ping();
			return { target, admin: c };
		} catch (e) {
			c.disconnect();
			if (Date.now() > deadline) throw e;
			await Bun.sleep(300);
		}
	}
}

type Bytes = string | { type: "base64"; value: string };
const b64 = (b: Buffer) => ({ type: "base64", value: b.toString("base64") });

describe.skipIf(!hasDocker)("database explorer on Redis", () => {
	let h: Harness;
	let cookie: string;
	let viewer: string;
	let id: string;
	let admin: Redis;
	let target: { host: string; port: number };

	const setEnv = async (key: string, value: string) => {
		await h.deps.db
			.delete(envVar)
			.where(and(eq(envVar.scopeId, id), eq(envVar.key, key)));
		await h.deps.db.insert(envVar).values({
			scope: "service",
			scopeId: id,
			key,
			valueEncrypted: await encrypt(h.deps.masterKey, value),
		});
	};
	const schema = () =>
		h.call("GET", `/api/databases/${id}/schema`, { headers: { cookie } });
	const keys = (
		q: Record<string, string | number>,
		headers: Record<string, string> = { cookie },
	) =>
		h.call(
			"GET",
			`/api/databases/${id}/keys?${new URLSearchParams(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])))}`,
			{ headers },
		);
	const value = (key: Bytes, q: Record<string, string | number> = {}) =>
		h.call(
			"GET",
			`/api/databases/${id}/keys/value?${new URLSearchParams({
				...(typeof key === "string"
					? { key }
					: { key: key.value, encoding: "base64" }),
				...Object.fromEntries(
					Object.entries(q).map(([k, v]) => [k, String(v)]),
				),
			})}`,
			{ headers: { cookie } },
		);
	const write = (
		op: Record<string, unknown>,
		headers: Record<string, string> = { cookie },
	) =>
		h.call("POST", `/api/databases/${id}/keys`, {
			headers,
			body: { db: 0, ...op },
		});
	const command = (
		argv: Bytes[],
		db = 0,
		headers: Record<string, string> = { cookie },
	) =>
		h.call("POST", `/api/databases/${id}/command`, {
			headers,
			body: { db, argv },
		});
	/** Every page of a value, as one list of items, plus the page count. */
	const pages = async <T>(
		key: Bytes,
		pick: (page: Record<string, unknown>) => T[],
		count = 100,
	) => {
		const all: T[] = [];
		let cursor: string | null = null;
		let n = 0;
		do {
			const r = await value(key, { count, ...(cursor ? { cursor } : {}) });
			expect(r.status).toBe(200);
			all.push(...pick(r.json));
			cursor = r.json.cursor;
			n++;
		} while (cursor);
		return { all, pages: n };
	};

	beforeAll(async () => {
		const [redis, harness] = await Promise.all([
			startRedis(),
			startHarness({ area: "dbx", label: "dbx" }),
		]);
		({ admin, target } = redis);
		h = harness;

		const seed = admin.pipeline();
		for (let i = 0; i < 10_000; i++) seed.set(`user:${i}`, `u${i}`);
		for (let i = 0; i < 50; i++) seed.set(`session:${i}`, "s", "EX", 3600);
		for (let i = 0; i < 10_000; i += 500)
			seed.hset(
				"big:hash",
				...Array.from({ length: 500 }, (_, j) => [
					`f${i + j}`,
					`v${i + j}`,
				]).flat(),
			);
		for (let i = 0; i < 250; i++) seed.rpush("q:list", `item ${i}`);
		for (let i = 0; i < 300; i++) seed.sadd("s:set", `m${i}`);
		for (let i = 0; i < 250; i++) seed.zadd("z:board", 250 - i, `p${i}`);
		for (let i = 0; i < 250; i++)
			seed.xadd("events", `${1000 + i}-0`, "kind", "click", "n", String(i));
		seed.set("doc:json", JSON.stringify({ a: 1, b: [true, null] }));
		seed.set("big:string", "x".repeat(1024 * 1024 + 10));
		await seed.exec();
		await admin.select(3);
		await admin.set("only:in:3", "three");
		await admin.select(0);

		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const prj = await h.call("POST", "/api/projects", {
			headers: { cookie },
			body: { name: "Cache" },
		});
		const envId = (
			await h.call("GET", `/api/projects/${prj.json.id}/environments`, {
				headers: { cookie },
			})
		).json[0].id;
		const created = await h.call(
			"POST",
			`/api/environments/${envId}/services`,
			{
				headers: { cookie },
				body: {
					name: "cache",
					spec: {
						kind: "database",
						engine: "redis",
						version: "7",
						credentialsRef: "env",
						resources: {},
					},
				},
			},
		);
		expect(created.status).toBe(201);
		id = created.json.id;
		await setEnv("REDIS_PASSWORD", PASSWORD);
		h.deps.databaseEndpoint = () => target;
		h.deps.databaseStatementTimeoutMs = 2000;

		const user = { name: "viewer", email: "viewer@example.com" };
		const password = "viewer password 12";
		const invite = await h.call("POST", "/api/invitations", {
			headers: { cookie },
			body: { email: user.email, role: "viewer" },
		});
		expect(invite.status).toBe(201);
		await h.call("POST", "/api/auth/sign-up/email", {
			body: { ...user, password },
		});
		viewer = await h.signIn(user.email, password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			headers: { cookie: viewer },
			body: { invitationId: invite.json.id },
		});
	}, 180_000);

	afterAll(async () => {
		admin?.disconnect();
		await h?.close();
		Bun.spawnSync(["docker", "rm", "-f", "-v", name], {
			stdout: "ignore",
			stderr: "ignore",
		});
	});

	test("logical databases are schemas with their key counts", async () => {
		const r = await schema();
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ engine: "redis", database: "0" });
		expect(r.json.schemas).toHaveLength(16);
		expect(r.json.schemas[0]).toEqual({
			name: "0",
			tables: [],
			keys: await admin.dbsize(),
		});
		expect(r.json.schemas[3]).toEqual({ name: "3", tables: [], keys: 1 });
		expect(r.json.schemas[5].keys).toBe(0);
	});

	test("SCAN with MATCH pages every matching key once and never runs KEYS", async () => {
		await admin.config("RESETSTAT");
		await admin.config("SET", "slowlog-log-slower-than", "0");
		await admin.config("SET", "slowlog-max-len", "100000");
		await admin.slowlog("RESET");
		const seen: string[] = [];
		let cursor: string | null = null;
		let batches = 0;
		do {
			const r = await keys({
				match: "user:1*",
				count: 200,
				...(cursor ? { cursor } : {}),
			});
			expect(r.status).toBe(200);
			for (const k of r.json.keys) {
				expect(k.type).toBe("string");
				expect(k.ttlMs).toBeNull();
				expect(k.bytes).toBeGreaterThan(0);
				seen.push(k.key);
			}
			cursor = r.json.cursor;
			batches++;
		} while (cursor);
		const expected = Array.from({ length: 10_000 }, (_, i) => `user:${i}`)
			.filter((k) => k.startsWith("user:1"))
			.sort();
		expect([...seen].sort()).toEqual(expected);
		expect(new Set(seen).size).toBe(seen.length);
		expect(batches).toBeGreaterThan(1);
		const stats = await admin.info("commandstats");
		expect(stats).toContain("cmdstat_scan:");
		expect(stats).not.toContain("cmdstat_keys:");
		const slow = (await admin.slowlog("GET", 100_000)) as unknown[][];
		const names = slow.map((e) => String((e[3] as string[])[0]).toUpperCase());
		expect(names).toContain("SCAN");
		expect(names).not.toContain("KEYS");
		await admin.config("SET", "slowlog-log-slower-than", "10000");
		await admin.config("SET", "slowlog-max-len", "128");
	});

	test("keys carry their TTL, and each logical database only its own keys", async () => {
		const s = await keys({ match: "session:*", count: 1000 });
		expect(s.json.keys).toHaveLength(50);
		for (const k of s.json.keys) {
			expect(k.ttlMs).toBeGreaterThan(3_500_000);
			expect(k.ttlMs).toBeLessThanOrEqual(3_600_000);
		}
		const three = await keys({ db: 3, match: "*", count: 1000 });
		expect(three.json).toEqual({
			keys: [expect.objectContaining({ key: "only:in:3", type: "string" })],
			cursor: null,
		});
		expect(
			(await keys({ db: 0, match: "only:*", count: 1000 })).json.keys,
		).toEqual([]);
		const v = await value("only:in:3", { db: 3 });
		expect(v.json).toEqual({
			type: "string",
			value: "three",
			truncated: false,
			length: 5,
		});
		expect((await value("only:in:3", { db: 0 })).status).toBe(404);
		// ioredis would fall back to db 0 on a failed SELECT; the explorer refuses first.
		expect((await keys({ db: 20, match: "*" })).status).toBe(400);
		const far = await h.call("POST", `/api/databases/${id}/keys`, {
			headers: { cookie },
			body: { db: 20, op: "delete", key: "user:1" },
		});
		expect(far.status).toBe(400);
		expect(await admin.exists("user:1")).toBe(1);
	});

	test("a 10 000-field hash pages through HSCAN", async () => {
		await admin.config("RESETSTAT");
		const { all, pages: n } = await pages(
			"big:hash",
			(p) => p.entries as { field: string; value: string }[],
			500,
		);
		const fields = new Map(all.map((e) => [e.field, e.value]));
		expect(fields.size).toBe(10_000);
		expect(fields.get("f1234")).toBe("v1234");
		expect(n).toBeGreaterThan(5);
		expect(await admin.info("commandstats")).toMatch(/cmdstat_hscan:calls=\d+/);
		expect((await value("big:hash")).json.length).toBe(10_000);
	});

	test("lists, sets, sorted sets and streams page by their own commands", async () => {
		const list = await pages("q:list", (p) => p.items as string[]);
		expect(list.all).toEqual(
			Array.from({ length: 250 }, (_, i) => `item ${i}`),
		);
		expect(list.pages).toBe(3);

		const set = await pages("s:set", (p) => p.members as string[]);
		expect(new Set(set.all)).toEqual(
			new Set(Array.from({ length: 300 }, (_, i) => `m${i}`)),
		);

		const z = await pages(
			"z:board",
			(p) => p.members as { member: string; score: string }[],
		);
		expect(z.all).toHaveLength(250);
		expect(z.all[0]).toEqual({ member: "p249", score: "1" });
		expect(z.all.at(-1)).toEqual({ member: "p0", score: "250" });
		expect(z.pages).toBe(3);

		const s = await pages(
			"events",
			(p) =>
				p.entries as {
					id: string;
					fields: { field: string; value: string }[];
				}[],
		);
		expect(s.all.map((e) => e.id)).toEqual(
			Array.from({ length: 250 }, (_, i) => `${1000 + i}-0`),
		);
		expect(s.all[7]?.fields).toEqual([
			{ field: "kind", value: "click" },
			{ field: "n", value: "7" },
		]);
		expect(s.pages).toBe(3);

		const big = await value("big:string");
		expect(big.json.truncated).toBe(true);
		expect(big.json.length).toBe(1024 * 1024 + 10);
		expect(big.json.value).toHaveLength(1024 * 1024);
	});

	test("binary keys and values round-trip as tagged base64", async () => {
		const key = Buffer.from([0x62, 0x69, 0x6e, 0x3a, 0xff, 0x00, 0x41]);
		const bytes = Buffer.from([0x80, 0x81, 0x00, 0xfe]);
		await admin.set(key, bytes);
		const found = await keys({ match: "bin:*", count: 1000 });
		expect(found.json.keys).toEqual([
			{ key: b64(key), type: "string", ttlMs: null, bytes: expect.any(Number) },
		]);
		expect((await value(b64(key) as Bytes)).json.value).toEqual(b64(bytes));

		const next = Buffer.from([0xc3, 0x28, 0x01]);
		const w = await write({ op: "set", key: b64(key), value: b64(next) });
		expect(w.status).toBe(200);
		expect(await admin.getBuffer(key)).toEqual(next);
		await write({ op: "delete", key: b64(key) });
	});

	test("every write op applies and returns the key after it", async () => {
		const set = await write({
			op: "set",
			key: "w:str",
			value: "one",
			ttlMs: 60_000,
		});
		expect(set.status).toBe(200);
		expect(set.json.key).toMatchObject({ key: "w:str", type: "string" });
		expect(await admin.get("w:str")).toBe("one");
		// An edit without a TTL keeps the key's TTL.
		await write({ op: "set", key: "w:str", value: "two" });
		expect(await admin.get("w:str")).toBe("two");
		expect(await admin.pttl("w:str")).toBeGreaterThan(0);

		await admin.hset("w:hash", "a", "1", "b", "2");
		expect(
			(await write({ op: "hset", key: "w:hash", field: "c", value: "3" }))
				.status,
		).toBe(200);
		expect(
			(await write({ op: "hdel", key: "w:hash", field: "a" })).status,
		).toBe(200);
		expect(await admin.hgetall("w:hash")).toEqual({ b: "2", c: "3" });

		await admin.sadd("w:set", "x");
		await write({ op: "sadd", key: "w:set", member: "y" });
		await write({ op: "srem", key: "w:set", member: "x" });
		expect(await admin.smembers("w:set")).toEqual(["y"]);

		await admin.zadd("w:z", 1, "a");
		await write({ op: "zadd", key: "w:z", member: "b", score: 2.5 });
		await write({ op: "zrem", key: "w:z", member: "a" });
		expect(await admin.zrange("w:z", 0, -1, "WITHSCORES")).toEqual([
			"b",
			"2.5",
		]);

		await admin.rpush("w:list", "a", "b", "c");
		await write({ op: "lset", key: "w:list", index: 1, value: "B" });
		expect(await admin.lrange("w:list", 0, -1)).toEqual(["a", "B", "c"]);
		const range = await write({
			op: "lset",
			key: "w:list",
			index: 9,
			value: "z",
		});
		expect(range.status).toBe(400);

		const exp = await write({ op: "expire", key: "w:list", ttlMs: 90_000 });
		expect(exp.json.key.ttlMs).toBeGreaterThan(80_000);
		const ttl = await admin.pttl("w:list");
		expect(ttl).toBeGreaterThan(80_000);
		expect(ttl).toBeLessThanOrEqual(90_000);
		const per = await write({ op: "persist", key: "w:list" });
		expect(per.json.key.ttlMs).toBeNull();
		expect(await admin.pttl("w:list")).toBe(-1);

		const ren = await write({ op: "rename", key: "w:list", to: "w:list2" });
		expect(ren.json.key).toMatchObject({ key: "w:list2", type: "list" });
		expect(await admin.exists("w:list")).toBe(0);
		const del = await write({ op: "delete", key: "w:list2" });
		expect(del.json).toEqual({ key: null });
		expect(await admin.exists("w:list2")).toBe(0);

		const audit = await h.deps.db
			.select({ outcome: auditLog.outcome, diff: auditLog.diff })
			.from(auditLog)
			.where(eq(auditLog.action, "database.key_write"));
		expect(audit).toContainEqual({
			outcome: "success",
			diff: { db: 0, op: "delete", key: "w:list2" },
		});
	});

	test("a key that vanished or changed type is a 409 stale and nothing is written", async () => {
		const stale = async (op: Record<string, unknown>) => {
			const r = await write(op);
			expect(r.status).toBe(409);
			expect(r.json.error.details.reason).toBe("stale");
		};
		await stale({ op: "hset", key: "gone:hash", field: "a", value: "1" });
		expect(await admin.exists("gone:hash")).toBe(0);
		await admin.set("now:string", "s");
		await stale({ op: "hset", key: "now:string", field: "a", value: "1" });
		await admin.hset("now:hash", "a", "1");
		await stale({ op: "set", key: "now:hash", value: "clobber" });
		expect(await admin.hgetall("now:hash")).toEqual({ a: "1" });
		await stale({ op: "hdel", key: "now:hash", field: "missing" });
		await stale({ op: "delete", key: "gone:key" });
		await stale({ op: "expire", key: "gone:key", ttlMs: 1000 });
		await admin.set("taken", "t");
		await stale({ op: "rename", key: "now:string", to: "taken" });
		expect(await admin.get("now:string")).toBe("s");
		expect(await admin.get("taken")).toBe("t");
	});

	test("the command box runs allowlisted commands and renders the reply", async () => {
		await admin.hset("cmd:h", "name", "Ada");
		const get = await command(["HGET", "cmd:h", "name"]);
		expect(get.status).toBe(200);
		expect(get.json.reply).toEqual({ type: "string", value: "Ada" });
		expect((await command(["hgetall", "cmd:h"])).json.reply).toEqual({
			type: "array",
			items: [
				{ type: "string", value: "name" },
				{ type: "string", value: "Ada" },
			],
		});
		expect((await command(["DBSIZE"], 3)).json.reply).toEqual({
			type: "integer",
			value: 1,
		});
		expect((await command(["GET", "nope"])).json.reply).toEqual({
			type: "null",
		});
		const wrong = await command(["LLEN", "cmd:h"]);
		expect(wrong.status).toBe(200);
		expect(wrong.json.reply.type).toBe("error");
		expect(wrong.json.reply.value).toStartWith("WRONGTYPE");
		expect((await command(["SET", "cmd:new", "1"])).json.reply).toEqual({
			type: "string",
			value: "OK",
		});
		const audit = await h.deps.db
			.select({ diff: auditLog.diff })
			.from(auditLog)
			.where(eq(auditLog.action, "database.command"));
		expect(audit).toContainEqual({
			diff: { db: 0, argv: ["SET", "cmd:new", "1"] },
		});
	});

	test("denied commands are a 400 in any case and the keys survive", async () => {
		const before = await admin.dbsize();
		for (const argv of [
			["FLUSHALL"],
			["flushall"],
			["FlushDb"],
			["CONFIG", "GET", "requirepass"],
			["EVAL", "return redis.call('FLUSHALL')", "0"],
			["keys", "*"],
			["SELECT", "3"],
			["MEMORY", "PURGE"],
			["CLIENT", "KILL", "TYPE", "normal"],
			["SUBSCRIBE", "x"],
			["NOT_A_COMMAND"],
		]) {
			const r = await command(argv);
			expect(r.status, argv.join(" ")).toBe(400);
			expect(r.json.error.message).toContain("allowed from the explorer");
		}
		expect(await admin.dbsize()).toBe(before);
		expect((await command(["MEMORY", "usage", "cmd:h"])).json.reply.type).toBe(
			"integer",
		);
	});

	test("a viewer reads keys but cannot write or run commands", async () => {
		expect((await keys({ match: "user:1" }, { cookie: viewer })).status).toBe(
			200,
		);
		expect(
			(await write({ op: "delete", key: "user:1" }, { cookie: viewer })).status,
		).toBe(403);
		expect(
			(await command(["GET", "user:1"], 0, { cookie: viewer })).status,
		).toBe(403);
		expect(await admin.exists("user:1")).toBe(1);
	});

	test("SQL and document routes are a 400 on a Redis service", async () => {
		const q = await h.call("POST", `/api/databases/${id}/query`, {
			headers: { cookie },
			body: { sql: "select 1" },
		});
		expect(q.status).toBe(400);
	});

	test("refused credentials are a 409 auth, unreachable a 409 too", async () => {
		await setEnv("REDIS_PASSWORD", "wrong");
		try {
			const refused = await schema();
			expect(refused.status).toBe(409);
			expect(refused.json.error.details.reason).toBe("auth");
		} finally {
			await setEnv("REDIS_PASSWORD", PASSWORD);
		}
		expect((await schema()).status).toBe(200);
		const real = h.deps.databaseEndpoint;
		h.deps.databaseEndpoint = () => ({ host: "127.0.0.1", port: 1 });
		try {
			const r = await keys({ match: "*" });
			expect(r.status).toBe(409);
			expect(r.json.error.details.reason).toBe("unreachable");
		} finally {
			h.deps.databaseEndpoint = real;
		}
	}, 20_000);
});
