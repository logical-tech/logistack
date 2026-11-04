import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt } from "@logistack/core";
import { auditLog, envVar } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const ENGINES = [
	{ engine: "mysql", image: "mysql:8.4", passwordKey: "MYSQL_ROOT_PASSWORD" },
	{
		engine: "mariadb",
		image: "mariadb:11",
		passwordKey: "MARIADB_ROOT_PASSWORD",
	},
] as const;
type Engine = (typeof ENGINES)[number]["engine"];

const tag = `ls-test-dbx-${crypto.randomUUID().slice(0, 8)}`;
const names = ENGINES.map((e) => `${tag}-${e.engine}`);

function docker(...args: string[]) {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args[0]} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

/** Starts the engine and waits until it accepts root logins over TCP (init runs without networking). */
async function startEngine(name: string, image: string, passwordKey: string) {
	docker(
		"run",
		"-d",
		"--name",
		name,
		"--label",
		"logistack.test=dbx",
		"-p",
		"127.0.0.1::3306",
		"-e",
		`${passwordKey}=test`,
		image,
	);
	const [host, port] = (
		docker("port", name, "3306/tcp").split("\n")[0] ?? ""
	).split(":") as [string, string];
	const target = { host, port: Number(port) };
	const deadline = Date.now() + 150_000;
	for (;;) {
		try {
			const c = await mysql.createConnection({
				...target,
				user: "root",
				password: "test",
				multipleStatements: true,
			});
			await c.query("select 1");
			return { target, admin: c };
		} catch (e) {
			if (Date.now() > deadline) throw e;
			await Bun.sleep(500);
		}
	}
}

const SEED = (items: string) => `
	create database shop;
	use shop;
	create table orders (id bigint primary key, \`select\` text, total decimal(10,2) not null default 0);
	create table audit_trail (at datetime, note text);
	create view big_orders as select id, total from orders where total > 100;
	create table items (id int primary key, name varchar(100), qty int not null);
	insert into items values ${items};
	update items set name = 'O''Brien; drop table x' where id = 42;
	create table x (id int);
	create table \`a\`\`b\` (\`x\`\`y\` int primary key, \`q"r\` text, \`a.b\` int);
	insert into \`a\`\`b\` values (1, 'one', 10), (2, 'two', 20);
	create table notes (id int auto_increment primary key, body text);
	create table ledger (id int auto_increment primary key, note text);
	create table kinds (
		id int primary key, big bigint, num decimal(30,10), doc json, raw blob,
		at datetime(6), flag bit(8), small tinyint, label varchar(20)
	);
	insert into kinds values (
		1, 9007199254740993, 12345678901234567890.1234567890, '{"n": 12345678901234567890}',
		x'00ff10', '2024-01-02 03:04:05.123456', b'101', -3, 'héllo'
	);
	create function add_one(a int) returns int deterministic return a + 1;
	create procedure noop(in n text) select n;
	create database empty_one;
	analyze table items;
`;

describe.skipIf(!hasDocker)("database explorer on MySQL and MariaDB", () => {
	let h: Harness;
	let cookie: string;
	const svc = {} as Record<
		Engine,
		{
			id: string;
			target: { host: string; port: number };
			admin: mysql.Connection;
		}
	>;

	const setEnv = async (serviceId: string, key: string, value: string) => {
		await h.deps.db
			.delete(envVar)
			.where(and(eq(envVar.scopeId, serviceId), eq(envVar.key, key)));
		await h.deps.db.insert(envVar).values({
			scope: "service",
			scopeId: serviceId,
			key,
			valueEncrypted: await encrypt(h.deps.masterKey, value),
		});
	};

	beforeAll(async () => {
		const items = Array.from(
			{ length: 5000 },
			(_, i) => `(${i + 1}, 'item ${i + 1}', ${(i + 1) % 7})`,
		).join(",");
		const [engines, harness] = await Promise.all([
			Promise.all(
				ENGINES.map(async (e, i) => {
					const s = await startEngine(
						names[i] as string,
						e.image,
						e.passwordKey,
					);
					await s.admin.query(SEED(items));
					return s;
				}),
			),
			startHarness({ area: "dbx", label: "dbx" }),
		]);
		h = harness;
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const prj = await h.call("POST", "/api/projects", {
			headers: { cookie },
			body: { name: "Shop" },
		});
		const envId = (
			await h.call("GET", `/api/projects/${prj.json.id}/environments`, {
				headers: { cookie },
			})
		).json[0].id;
		for (const [i, e] of ENGINES.entries()) {
			const created = await h.call(
				"POST",
				`/api/environments/${envId}/services`,
				{
					headers: { cookie },
					body: {
						name: `${e.engine}-db`,
						spec: {
							kind: "database",
							engine: e.engine,
							version: e.image.split(":")[1],
							credentialsRef: "env",
							resources: {},
						},
					},
				},
			);
			expect(created.status).toBe(201);
			const s = engines[i] as (typeof engines)[number];
			svc[e.engine] = { id: created.json.id, ...s };
			await setEnv(created.json.id, e.passwordKey, "test");
			await setEnv(
				created.json.id,
				e.engine === "mysql" ? "MYSQL_DATABASE" : "MARIADB_DATABASE",
				"shop",
			);
		}
		h.deps.databaseEndpoint = (id) =>
			Object.values(svc).find((s) => s.id === id)?.target ?? {
				host: "127.0.0.1",
				port: 1,
			};
		h.deps.databaseStatementTimeoutMs = 2000;
	}, 240_000);

	afterAll(async () => {
		for (const s of Object.values(svc)) await s.admin.end().catch(() => {});
		await h?.close();
		for (const name of names)
			Bun.spawnSync(["docker", "rm", "-f", "-v", name], {
				stdout: "ignore",
				stderr: "ignore",
			});
	});

	describe.each(ENGINES.map((e) => [e.engine, e.passwordKey] as const))(
		"%s",
		(engine, passwordKey) => {
			const id = () => svc[engine].id;
			const admin = () => svc[engine].admin;
			const all = async (sql: string) =>
				(await admin().query(sql))[0] as Record<string, unknown>[];
			const one = async (sql: string) => (await all(sql))[0];
			const schema = () =>
				h.call("GET", `/api/databases/${id()}/schema`, {
					headers: { cookie },
				});
			type Params = {
				limit?: number;
				cursor?: string;
				sort?: unknown[];
				filter?: unknown[];
			};
			const rows = (table: string, p: Params = {}) => {
				const qs = new URLSearchParams();
				if (p.limit) qs.set("limit", String(p.limit));
				if (p.cursor) qs.set("cursor", p.cursor);
				if (p.sort) qs.set("sort", JSON.stringify(p.sort));
				if (p.filter) qs.set("filter", JSON.stringify(p.filter));
				return h.call(
					"GET",
					`/api/databases/${id()}/tables/shop/${encodeURIComponent(table)}/rows?${qs}`,
					{ headers: { cookie } },
				);
			};
			const write = (table: string, ops: unknown[]) =>
				h.call(
					"POST",
					`/api/databases/${id()}/tables/shop/${encodeURIComponent(table)}/rows`,
					{ headers: { cookie }, body: { ops } },
				);
			const query = (
				sql: string,
				opts: { readOnly?: boolean; runId?: string } = {},
			) =>
				h.call("POST", `/api/databases/${id()}/query`, {
					headers: { cookie },
					body: { sql, ...opts },
				});
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
			// A cross join no engine finishes inside the 2 s test timeout.
			const HEAVY =
				"select count(*) from items a, items b, items c where a.name < c.name";

			test("databases are the schemas, system ones hidden", async () => {
				const r = await schema();
				expect(r.status).toBe(200);
				expect(r.json).toMatchObject({ engine, database: "shop" });
				const names = r.json.schemas.map((s: { name: string }) => s.name);
				expect(names).toEqual(["empty_one", "shop"]);
				const shop = r.json.schemas[1];
				const byName = Object.fromEntries(
					shop.tables.map((t: { name: string }) => [t.name, t]),
				);
				expect(byName.orders).toMatchObject({
					kind: "table",
					editable: true,
					columns: [
						{
							name: "id",
							type: expect.stringMatching(/^bigint(\(20\))?$/),
							nullable: false,
							primaryKey: true,
							default: null,
						},
						{
							name: "select",
							type: "text",
							nullable: true,
							primaryKey: false,
							default: null,
						},
						{
							name: "total",
							type: "decimal(10,2)",
							nullable: false,
							default: "0.00",
						},
					],
				});
				expect(byName.notes.columns[0].default).toBe("auto_increment");
				expect(byName.items.rows).toBeGreaterThan(1000);
				expect(byName.audit_trail).toMatchObject({ editable: false });
				expect(byName.big_orders).toMatchObject({
					kind: "view",
					editable: false,
				});
			});

			test("pages by primary key keyset, every id exactly once", async () => {
				const filter = [{ column: "id", op: "lte", value: "1200" }];
				const { all, count } = await pages("items", { limit: 500, filter });
				expect(count).toBe(3);
				expect(all.map((r) => r[0])).toEqual(
					Array.from({ length: 1200 }, (_, i) => i + 1),
				);
			});

			test("pages by offset under a non-key sort, stable and complete", async () => {
				const { all } = await pages("items", {
					limit: 400,
					sort: [{ column: "qty", desc: true }],
					filter: [{ column: "id", op: "lte", value: "1000" }],
				});
				const ids = all.map((r) => r[0] as number);
				expect(ids).toEqual(
					Array.from({ length: 1000 }, (_, i) => i + 1).sort(
						(a, b) => (b % 7) - (a % 7) || a - b,
					),
				);
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
				const insensitive = await rows("items", {
					filter: [{ column: "name", op: "contains", value: "o'brien" }],
				});
				expect(insensitive.json.rows).toEqual([]);
				expect(
					await one(
						"select count(*) as n from information_schema.TABLES where TABLE_SCHEMA = 'shop' and TABLE_NAME = 'x'",
					),
				).toEqual({ n: 1 });
				const unknown = await rows("items", {
					filter: [
						{ column: "name` ; drop table x; --", op: "eq", value: "a" },
					],
				});
				expect(unknown.status).toBe(400);
			});

			test("backticks, quotes and dots in names address one table and column", async () => {
				const read = await rows("a`b", {
					sort: [{ column: "x`y", desc: true }],
					filter: [{ column: "a.b", op: "lte", value: "20" }],
				});
				expect(read.status).toBe(200);
				expect(read.json.columns.map((c: { name: string }) => c.name)).toEqual([
					"x`y",
					'q"r',
					"a.b",
				]);
				expect(read.json.rows).toEqual([
					[2, "two", 20],
					[1, "one", 10],
				]);
				const w = await write("a`b", [
					{ op: "insert", values: { "x`y": 3, 'q"r': "three" } },
					{ op: "update", key: { "x`y": 1 }, values: { 'q"r': "uno" } },
					{ op: "delete", key: { "x`y": 2 } },
				]);
				expect(w.status).toBe(200);
				expect(w.json.rows).toEqual([[3, "three", null], [1, "uno", 10], null]);
			});

			test("insert, update and delete in one transaction, audited", async () => {
				const w = await write("notes", [
					{ op: "insert", values: { body: "first" } },
					{ op: "insert", values: { body: "second" } },
					{ op: "update", key: { id: 1 }, values: { body: "edited" } },
					{ op: "update", key: { id: 1 }, values: { body: "edited" } },
					{ op: "delete", key: { id: 2 } },
				]);
				expect(w.status).toBe(200);
				expect(w.json.rows).toEqual([
					[1, "first"],
					[2, "second"],
					[1, "edited"],
					[1, "edited"],
					null,
				]);
				expect(
					await all("select id, body from shop.notes order by id"),
				).toEqual([{ id: 1, body: "edited" }]);
				const audit = await h.deps.db
					.select({ resourceId: auditLog.resourceId })
					.from(auditLog)
					.where(eq(auditLog.action, "database.rows_write"));
				expect(audit).toContainEqual({ resourceId: id() });
			});

			test("a stale key is a 409 and nothing in the batch is written", async () => {
				const w = await write("notes", [
					{ op: "insert", values: { body: "lost" } },
					{ op: "update", key: { id: 999 }, values: { body: "x" } },
				]);
				expect(w.status).toBe(409);
				expect(w.json.error.details.reason).toBe("stale");
				expect(
					(await write("notes", [{ op: "delete", key: { id: 999 } }])).status,
				).toBe(409);
				expect(
					await all("select id, body from shop.notes order by id"),
				).toEqual([{ id: 1, body: "edited" }]);
			});

			test("tables without a primary key and views are read-only", async () => {
				const noKey = await write("audit_trail", [
					{ op: "insert", values: { note: "x" } },
				]);
				expect(noKey.status).toBe(400);
				expect(noKey.json.error.message).toContain("no primary key");
				expect(
					(await write("big_orders", [{ op: "delete", key: { id: 1 } }]))
						.status,
				).toBe(400);
				expect((await rows("big_orders")).json.editable).toBe(false);
				expect((await rows("nope")).status).toBe(404);
			});

			test("values round-trip without losing precision", async () => {
				const snapshot = (id: number) =>
					one(
						`select concat_ws('|', big, num, doc, hex(raw), at, hex(flag), small, label) as t from shop.kinds where id = ${id}`,
					);
				const before = await snapshot(1);
				const r = await rows("kinds");
				const [row] = r.json.rows;
				expect(row).toEqual([
					1,
					{ type: "bigint", value: "9007199254740993" },
					{ type: "numeric", value: "12345678901234567890.1234567890" },
					{ type: "json", value: '{"n": 12345678901234567890}' },
					{ type: "bytea", value: "\\x00ff10" },
					"2024-01-02 03:04:05.123456",
					{ type: "bytea", value: "\\x05" },
					-3,
					"héllo",
				]);
				const cols = r.json.columns.map((c: { name: string }) => c.name);
				const values = Object.fromEntries(
					cols.slice(1).map((n: string, i: number) => [n, row[i + 1]]),
				);
				const w = await write("kinds", [
					{ op: "update", key: { id: 1 }, values },
					{ op: "insert", values: { ...values, id: 2 } },
				]);
				expect(w.status).toBe(200);
				expect(w.json.rows[0]).toEqual(row);
				expect(w.json.rows[1]).toEqual([2, ...row.slice(1)]);
				expect(await snapshot(1)).toEqual(before);
				expect(await snapshot(2)).toEqual(before);
				const big = await rows("kinds", {
					filter: [{ column: "big", op: "eq", value: "9007199254740993" }],
				});
				expect(big.json.rows).toHaveLength(2);
				const near = await rows("kinds", {
					filter: [{ column: "big", op: "eq", value: "9007199254740992" }],
				});
				expect(near.json.rows).toHaveLength(0);
			});

			test("an empty result keeps its header", async () => {
				const r = await query("select 1 as a, 'x' as a from dual where false");
				expect(r.status).toBe(200);
				expect(r.json.error).toBeNull();
				expect(r.json.results).toEqual([
					{
						from: 0,
						to: 45,
						command: "SELECT",
						columns: [
							{ name: "a", type: expect.stringMatching(/int/) },
							{ name: "a", type: "varchar" },
						],
						rows: [],
						truncated: false,
						affected: 0,
						durationMs: expect.any(Number),
					},
				]);
			});

			test("several statements return one result each, in order", async () => {
				const sql =
					"select 1 as x;\n# a comment; still one\nselect 'a;b' as `y;`, cast(9007199254740993 as signed) as z;\nshow tables like 'item%'";
				const r = await query(sql);
				expect(r.json.error).toBeNull();
				const [, b, c] = r.json.results;
				expect(r.json.results).toHaveLength(3);
				expect(sql.slice(b.from, b.to)).toStartWith("# a comment");
				expect(b.columns.map((x: { name: string }) => x.name)).toEqual([
					"y;",
					"z",
				]);
				expect(b.rows).toEqual([
					["a;b", { type: "bigint", value: "9007199254740993" }],
				]);
				expect(c).toMatchObject({ command: "SHOW", rows: [["items"]] });
			});

			test("read only refuses writes, DDL and ways out", async () => {
				const before = await one("select count(*) as n from shop.ledger");
				const r = await query("insert into ledger (note) values ('x')");
				expect(r.status).toBe(200);
				expect(r.json.error).toMatchObject({
					statement: 0,
					code: "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION",
				});
				const ddl = await query(
					"select 1; create table made_in_read_only (i int); insert into ledger (note) values ('x')",
				);
				expect(ddl.json.error).not.toBeNull();
				const commit = await query(
					"select 1; commit; insert into ledger (note) values ('x')",
				);
				expect(commit.json.error.statement).toBe(1);
				expect(await one("select count(*) as n from shop.ledger")).toEqual(
					before,
				);
				expect(
					await one(
						"select count(*) as n from information_schema.TABLES where TABLE_NAME = 'made_in_read_only'",
					),
				).toEqual({ n: 0 });
			});

			test("a syntax error names its statement", async () => {
				const r = await query("select 1;\n  selec 2;\nselect 3");
				expect(r.json.results).toHaveLength(1);
				expect(r.json.error).toMatchObject({
					statement: 1,
					code: "ER_PARSE_ERROR",
				});
			});

			test("rows past 1000 are cut and flagged, and the run goes on", async () => {
				const r = await query(
					"select a.id from items a, items b; select 2 as two",
				);
				expect(r.json.error).toBeNull();
				const [cut, next] = r.json.results;
				expect(cut.rows).toHaveLength(1000);
				expect(cut).toMatchObject({ truncated: true, affected: null });
				// MySQL types an integer literal BIGINT, MariaDB INT.
				expect([2, { type: "bigint", value: "2" }]).toContainEqual(
					next.rows[0][0],
				);
			});

			test("a statement past the timeout is stopped, even after lifting it", async () => {
				const t = performance.now();
				const r = await query(HEAVY);
				expect(r.json.error?.code).toMatch(/TIMEOUT/);
				const lift =
					engine === "mysql"
						? "set session max_execution_time = 0"
						: "set session max_statement_time = 0";
				const bypass = await query(`${lift}; ${HEAVY}`);
				expect(bypass.json.error).toMatchObject({
					statement: 1,
					code: "ER_QUERY_TIMEOUT",
				});
				expect(performance.now() - t).toBeLessThan(9000);
				const after = await query("select 1 as ok");
				expect(after.json.error).toBeNull();
			}, 20_000);

			// SLEEP() swallows the interrupt and returns 1; the run still reports the cancel.
			test.each([HEAVY, "select sleep(10); select 2"])(
				"the caller cancels their own run: %s",
				async (sql) => {
					const runId = crypto.randomUUID();
					const t = performance.now();
					const running = query(sql, { runId });
					await Bun.sleep(300);
					const cancel = await h.call(
						"DELETE",
						`/api/databases/${id()}/query/${runId}`,
						{ headers: { cookie } },
					);
					expect(cancel.status).toBe(204);
					const r = await running;
					expect(r.json.error).toMatchObject({
						statement: 0,
						code: "ER_QUERY_INTERRUPTED",
					});
					expect(r.json.results).toEqual([]);
					expect(performance.now() - t).toBeLessThan(1500);
				},
			);

			test("a write run commits as one and rolls back on error", async () => {
				const w = await query(
					"insert into ledger (note) values ('from the editor')",
					{ readOnly: false },
				);
				expect(w.json.error).toBeNull();
				expect(w.json.results[0]).toMatchObject({
					command: "INSERT",
					affected: 1,
				});
				const failed = await query(
					"insert into ledger (note) values ('lost'); insert into nope values (1)",
					{ readOnly: false },
				);
				expect(failed.json.error).toMatchObject({
					statement: 1,
					code: "ER_NO_SUCH_TABLE",
				});
				expect(await all("select note from shop.ledger")).toEqual([
					{ note: "from the editor" },
				]);
			});

			test("refused credentials are a 409 auth, unreachable a 409 too", async () => {
				await setEnv(id(), passwordKey, "wrong");
				const refused = await schema();
				expect(refused.status).toBe(409);
				expect(refused.json.error.details.reason).toBe("auth");
				await setEnv(id(), passwordKey, "test");
				expect((await schema()).status).toBe(200);
				const real = h.deps.databaseEndpoint;
				h.deps.databaseEndpoint = () => ({ host: "127.0.0.1", port: 1 });
				try {
					const r = await schema();
					expect(r.status).toBe(409);
					expect(r.json.error.details.reason).toBe("unreachable");
				} finally {
					h.deps.databaseEndpoint = real;
				}
			});

			test("stored routines show under their schema", async () => {
				const r = await schema();
				const shop = r.json.schemas.find(
					(s: { name: string }) => s.name === "shop",
				);
				expect(shop.routines).toEqual([
					{
						name: "add_one",
						kind: "function",
						// MariaDB keeps the display width.
						arguments: engine === "mysql" ? "a int" : "a int(11)",
						returns: engine === "mysql" ? "int" : "int(11)",
					},
					{
						name: "noop",
						kind: "procedure",
						arguments: "IN n text",
						returns: null,
					},
				]);
				expect(r.json.defaultDatabase).toBe("shop");
				expect(r.json.databases).toBeUndefined();
			});

			test("creates and drops a database; the default and system ones stay", async () => {
				const name = "ls_dbx_scratch";
				const made = await h.call("POST", `/api/databases/${id()}/databases`, {
					headers: { cookie },
					body: { name },
				});
				expect(made.status).toBe(201);
				const t = await h.call(
					"POST",
					`/api/databases/${id()}/query?database=${name}`,
					{
						headers: { cookie },
						body: {
							sql: "create table t (id int primary key)",
							readOnly: false,
						},
					},
				);
				expect(t.json.error).toBeNull();
				expect(
					(await schema()).json.schemas.find(
						(s: { name: string }) => s.name === name,
					)?.tables[0]?.name,
				).toBe("t");
				const drop = (n: string) =>
					h.call("DELETE", `/api/databases/${id()}/databases/${n}`, {
						headers: { cookie },
					});
				expect((await drop(name)).status).toBe(204);
				expect((await drop(name)).status).toBe(404);
				expect((await drop("shop")).status).toBe(400);
				expect((await drop("mysql")).status).toBe(400);
				expect(
					(await schema()).json.schemas.map((s: { name: string }) => s.name),
				).not.toContain(name);
			});
		},
	);
});
