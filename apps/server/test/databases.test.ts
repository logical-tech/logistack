import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt } from "@logistack/core";
import { auditLog, createDb, envVar } from "@logistack/db";
import { rowsQuery } from "@logistack/providers";
import { and, eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const dbSpec = {
	kind: "database",
	engine: "postgres",
	version: "18-alpine",
	credentialsRef: "env",
	resources: {},
};

describe.skipIf(!hasDocker)("database explorer API", () => {
	let h: Harness;
	let cookie: string;
	let envId: string;
	let dbId: string;
	let target: { host: string; port: number };
	let shop: ReturnType<typeof createDb>["$client"];
	let viewer: string;

	const setEnv = async (key: string, value: string) => {
		await h.deps.db
			.delete(envVar)
			.where(and(eq(envVar.scopeId, dbId), eq(envVar.key, key)));
		await h.deps.db.insert(envVar).values({
			scope: "service",
			scopeId: dbId,
			key,
			valueEncrypted: await encrypt(h.deps.masterKey, value),
		});
	};
	const schema = (id = dbId, headers: Record<string, string> = { cookie }) =>
		h.call("GET", `/api/databases/${id}/schema`, { headers });

	beforeAll(async () => {
		h = await startHarness({ area: "dbx", label: "dbx" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const prj = await h.call("POST", "/api/projects", {
			headers: { cookie },
			body: { name: "Shop" },
		});
		envId = (
			await h.call("GET", `/api/projects/${prj.json.id}/environments`, {
				headers: { cookie },
			})
		).json[0].id;
		dbId = (
			await h.call("POST", `/api/environments/${envId}/services`, {
				headers: { cookie },
				body: { name: "orders-db", spec: dbSpec },
			})
		).json.id;

		// The harness's own Postgres stands in for the service; a separate database keeps it apart.
		const url = new URL(h.config.DATABASE_URL);
		target = { host: url.hostname, port: Number(url.port) };
		const admin = createDb(h.config.DATABASE_URL, {
			onnotice: () => {},
		}).$client;
		await admin.unsafe("create database shop");
		await admin.end();
		url.pathname = "/shop";
		shop = createDb(url.toString(), { onnotice: () => {} }).$client;
		await shop.unsafe(`
			create table orders (id bigint primary key, "select" text, total numeric(10,2) not null default 0);
			create table audit_trail (at timestamptz, note text);
			create view big_orders as select id, total from orders where total > 100;
			create schema empty_one;
			analyze orders;
			create table items (id int primary key, name text, qty int not null);
			insert into items select i, 'item ' || i, i % 7 from generate_series(1, 20000) i;
			update items set name = 'O''Brien; drop table x' where id = 42;
			create table x (id int);
			analyze items;
			create table "select" ("select" text primary key, n int);
			insert into "select" values ('a', 1), ('b', 2);
			create table notes (id serial primary key, body text);
			create table kinds (
				id int primary key, big bigint, num numeric, raw bytea, doc jsonb, j json,
				at timestamptz, ts timestamp, d date, flag boolean, f float8, tags text[]
			);
			insert into kinds values (
				1, 9007199254740993, 12345678901234567890.123456789, '\\x00ff10',
				'{"n": 12345678901234567890}', '{ "b": 1,  "a": 2 }',
				'2024-01-02 03:04:05.123456+00', '2024-01-02 03:04:05.654321', '2024-01-02',
				true, 'NaN', '{a,"b c"}'
			);
		`);
		h.deps.databaseEndpoint = () => target;
		await setEnv("POSTGRES_PASSWORD", "test");
		await setEnv("POSTGRES_DB", "shop");

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
	}, 90_000);
	afterAll(async () => {
		await shop?.end();
		await h?.close();
	});

	test("returns schemas, tables, views and columns", async () => {
		const r = await schema();
		expect(r.status).toBe(200);
		expect(r.json.engine).toBe("postgres");
		expect(r.json.database).toBe("shop");
		const names = r.json.schemas.map((s: { name: string }) => s.name);
		expect(names).toContain("public");
		expect(names).toContain("empty_one");
		const pub = r.json.schemas.find(
			(s: { name: string }) => s.name === "public",
		);
		const byName = Object.fromEntries(
			pub.tables.map((t: { name: string }) => [t.name, t]),
		);
		expect(byName.orders).toMatchObject({
			kind: "table",
			editable: true,
			rows: 0,
			columns: [
				{
					name: "id",
					type: "bigint",
					nullable: false,
					primaryKey: true,
					default: null,
				},
				{ name: "select", type: "text", nullable: true, primaryKey: false },
				{
					name: "total",
					type: "numeric(10,2)",
					nullable: false,
					default: "0",
					primaryKey: false,
				},
			],
		});
		expect(byName.audit_trail).toMatchObject({
			kind: "table",
			editable: false,
			rows: null,
		});
		expect(byName.big_orders).toMatchObject({ kind: "view", editable: false });
		expect(
			byName.big_orders.columns.map((c: { name: string }) => c.name),
		).toEqual(["id", "total"]);
	});

	test("an unreachable database is a 409 that says why", async () => {
		h.deps.databaseEndpoint = () => ({ host: "127.0.0.1", port: 1 });
		try {
			const r = await schema();
			expect(r.status).toBe(409);
			expect(r.json.error.details.reason).toBe("unreachable");
			expect(r.json.error.message).toContain("redeploy");
		} finally {
			h.deps.databaseEndpoint = () => target;
		}
	});

	test("rotated credentials replace the pool; refused ones are a 409 auth", async () => {
		await setEnv("POSTGRES_PASSWORD", "wrong");
		const refused = await schema();
		expect(refused.status).toBe(409);
		expect(refused.json.error.details.reason).toBe("auth");
		await setEnv("POSTGRES_PASSWORD", "test");
		expect((await schema()).status).toBe(200);
	});

	test("only database services, only signed-in callers", async () => {
		const app = await h.call("POST", `/api/environments/${envId}/services`, {
			headers: { cookie },
			body: {
				name: "web",
				spec: {
					kind: "application",
					source: { type: "image", image: "nginx:1.27" },
					build: { type: "image" },
					ports: [{ target: 80, protocol: "tcp" }],
					replicas: 1,
					resources: {},
					placement: [],
				},
			},
		});
		expect((await schema(app.json.id)).status).toBe(400);
		expect((await schema(dbId, {})).status).toBe(401);
	});

	type Params = {
		limit?: number;
		cursor?: string;
		sort?: unknown[];
		filter?: unknown[];
	};
	const rows = (
		table: string,
		p: Params = {},
		headers: Record<string, string> = { cookie },
	) => {
		const qs = new URLSearchParams();
		if (p.limit) qs.set("limit", String(p.limit));
		if (p.cursor) qs.set("cursor", p.cursor);
		if (p.sort) qs.set("sort", JSON.stringify(p.sort));
		if (p.filter) qs.set("filter", JSON.stringify(p.filter));
		return h.call(
			"GET",
			`/api/databases/${dbId}/tables/public/${encodeURIComponent(table)}/rows?${qs}`,
			{ headers },
		);
	};
	const write = (
		table: string,
		ops: unknown[],
		headers: Record<string, string> = { cookie },
	) =>
		h.call(
			"POST",
			`/api/databases/${dbId}/tables/public/${encodeURIComponent(table)}/rows`,
			{ headers, body: { ops } },
		);
	const pages = async (table: string, p: Params) => {
		const all: unknown[][] = [];
		let cursor: string | undefined;
		let count = 0;
		do {
			const r = await rows(table, { ...p, cursor });
			expect(r.status).toBe(200);
			all.push(...r.json.rows);
			cursor = r.json.nextCursor ?? undefined;
			count++;
		} while (cursor);
		return { all, count };
	};

	test("pages by primary key keyset, every id exactly once", async () => {
		const first = await rows("items", {
			limit: 500,
			filter: [{ column: "id", op: "lte", value: "1200" }],
		});
		expect(first.json.columns.map((c: { name: string }) => c.name)).toEqual([
			"id",
			"name",
			"qty",
		]);
		expect(first.json.editable).toBe(true);
		const { all, count } = await pages("items", {
			limit: 500,
			filter: [{ column: "id", op: "lte", value: "1200" }],
		});
		expect(count).toBe(3);
		expect(all.map((r) => r[0])).toEqual(
			Array.from({ length: 1200 }, (_, i) => i + 1),
		);
	});

	test("pages by offset under a non-key sort, stable and complete", async () => {
		const { all, count } = await pages("items", {
			limit: 400,
			sort: [{ column: "qty", desc: true }],
			filter: [{ column: "id", op: "lte", value: "1000" }],
		});
		expect(count).toBe(3);
		const ids = all.map((r) => r[0] as number);
		expect(new Set(ids).size).toBe(1000);
		const expected = Array.from({ length: 1000 }, (_, i) => i + 1).sort(
			(a, b) => (b % 7) - (a % 7) || a - b,
		);
		expect(ids).toEqual(expected);
	});

	test("the keyset page seeks the primary key index", async () => {
		const page = await rows("items", { limit: 100 });
		const cursor = page.json.nextCursor;
		const deep = await rows("items", { limit: 100, cursor });
		expect(deep.json.rows[0][0]).toBe(101);
		const { query } = rowsQuery(
			shop,
			{ schema: "public", table: "items" },
			{ columns: ["id", "name", "qty"], key: ["id"] },
			{ limit: 100, cursor, sort: [], filter: [] },
		);
		const plan = (await shop`explain ${query}`)
			.map((r) => r["QUERY PLAN"])
			.join("\n");
		expect(plan).toContain("items_pkey");
		expect(plan).not.toContain("Seq Scan");
	});

	test("filter values are bound, never spliced into the statement", async () => {
		const value = "O'Brien; drop table x";
		for (const op of ["contains", "eq", "starts_with"]) {
			const r = await rows("items", {
				filter: [{ column: "name", op, value }],
			});
			expect(r.status).toBe(200);
			expect(r.json.rows).toEqual([[42, value, 0]]);
		}
		const [x] =
			await shop`select to_regclass('public.x') is not null as exists`;
		expect(x?.exists).toBe(true);
		const unknown = await rows("items", {
			filter: [{ column: 'name" ; drop table x; --', op: "eq", value: "a" }],
		});
		expect(unknown.status).toBe(400);
	});

	test("a table and a column named select", async () => {
		const read = await rows("select", {
			sort: [{ column: "select", desc: true }],
			filter: [{ column: "select", op: "neq", value: "z" }],
		});
		expect(read.status).toBe(200);
		expect(read.json.rows).toEqual([
			["b", 2],
			["a", 1],
		]);
		const w = await write("select", [
			{ op: "update", key: { select: "a" }, values: { n: 10 } },
		]);
		expect(w.status).toBe(200);
		expect(w.json.rows).toEqual([["a", 10]]);
	});

	test("insert, update and delete in one transaction, audited", async () => {
		const w = await write("notes", [
			{ op: "insert", values: { body: "first" } },
			{ op: "insert", values: { body: "second" } },
			{ op: "update", key: { id: 1 }, values: { body: "edited" } },
			{ op: "delete", key: { id: 2 } },
		]);
		expect(w.status).toBe(200);
		expect(w.json.rows).toEqual([
			[1, "first"],
			[2, "second"],
			[1, "edited"],
			null,
		]);
		expect([...(await shop`select id, body from notes order by id`)]).toEqual([
			{ id: 1, body: "edited" },
		]);
		const audit = await h.deps.db
			.select({ outcome: auditLog.outcome, resourceId: auditLog.resourceId })
			.from(auditLog)
			.where(eq(auditLog.action, "database.rows_write"));
		expect(audit).toContainEqual({ outcome: "success", resourceId: dbId });
	});

	test("a stale key is a 409 and nothing in the batch is written", async () => {
		const w = await write("notes", [
			{ op: "insert", values: { body: "lost" } },
			{ op: "update", key: { id: 999 }, values: { body: "x" } },
		]);
		expect(w.status).toBe(409);
		expect(w.json.error.details.reason).toBe("stale");
		const del = await write("notes", [{ op: "delete", key: { id: 999 } }]);
		expect(del.status).toBe(409);
		expect([...(await shop`select id, body from notes order by id`)]).toEqual([
			{ id: 1, body: "edited" },
		]);
		const partialKey = await write("notes", [
			{ op: "delete", key: { body: "edited" } },
		]);
		expect(partialKey.status).toBe(400);
	});

	test("tables without a primary key and views are read-only", async () => {
		const noKey = await write("audit_trail", [
			{ op: "insert", values: { note: "x" } },
		]);
		expect(noKey.status).toBe(400);
		expect(noKey.json.error.message).toContain("no primary key");
		const view = await write("big_orders", [{ op: "delete", key: { id: 1 } }]);
		expect(view.status).toBe(400);
		expect((await rows("big_orders")).json.editable).toBe(false);
		expect((await rows("nope")).status).toBe(404);
	});

	test("a viewer reads rows but cannot write them", async () => {
		expect((await rows("notes", {}, { cookie: viewer })).status).toBe(200);
		const w = await write("notes", [{ op: "delete", key: { id: 1 } }], {
			cookie: viewer,
		});
		expect(w.status).toBe(403);
		expect([...(await shop`select count(*)::int as n from notes`)]).toEqual([
			{ n: 1 },
		]);
	});

	test("values round-trip without losing precision", async () => {
		const snapshot = () =>
			shop`select kinds::text as t from kinds where id = 1`;
		const before = await snapshot();
		const r = await rows("kinds");
		const [row] = r.json.rows;
		expect(row).toEqual([
			1,
			{ type: "bigint", value: "9007199254740993" },
			{ type: "numeric", value: "12345678901234567890.123456789" },
			{ type: "bytea", value: "\\x00ff10" },
			{ type: "json", value: '{"n": 12345678901234567890}' },
			{ type: "json", value: '{ "b": 1,  "a": 2 }' },
			expect.stringContaining(".123456"),
			"2024-01-02 03:04:05.654321",
			"2024-01-02",
			true,
			"NaN",
			'{a,"b c"}',
		]);
		const names = r.json.columns.map((c: { name: string }) => c.name);
		const values = Object.fromEntries(
			names.slice(1).map((n: string, i: number) => [n, row[i + 1]]),
		);
		const w = await write("kinds", [
			{ op: "update", key: { id: 1 }, values },
			{ op: "insert", values: { ...values, id: 2 } },
		]);
		expect(w.status).toBe(200);
		expect(w.json.rows[0]).toEqual(row);
		expect(await snapshot()).toEqual(before);
		const [copy] =
			await shop`select (a.big, a.num, a.raw, a.doc, a.j::text, a.at, a.ts, a.d, a.flag, a.f, a.tags)::text
				= (b.big, b.num, b.raw, b.doc, b.j::text, b.at, b.ts, b.d, b.flag, b.f, b.tags)::text as same
				from kinds a, kinds b where a.id = 1 and b.id = 2`;
		expect(copy?.same).toBe(true);
	});
});
