import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LIBSQL_ENV, libsqlCredentials } from "@logistack/core";
import { libsqlClient, toArg, toCell, whereOf } from "../src/db/libsql.ts";

test("cells round-trip through Hrana values", () => {
	expect(toCell({ type: "integer", value: "42" })).toBe(42);
	expect(toCell({ type: "integer", value: "9007199254740993" })).toEqual({
		type: "bigint",
		value: "9007199254740993",
	});
	expect(toCell({ type: "blob", base64: "AQI=" })).toEqual({
		type: "bytea",
		value: "\\x0102",
	});
	expect(toArg({ type: "bytea", value: "\\x0102" })).toEqual({
		type: "blob",
		base64: "AQI=",
	});
	expect(toArg(true)).toEqual({ type: "integer", value: "1" });
	expect(toArg(1.5)).toEqual({ type: "float", value: 1.5 });
});

test("filters bind values and refuse unknown columns", () => {
	const w = whereOf(
		[
			{ column: "name", op: "starts_with", value: "a" },
			{ column: "id", op: "gt", value: "3" },
			{ column: "note", op: "is_null" },
		],
		new Set(["id", "name", "note"]),
	);
	expect(w.sql).toBe(
		` WHERE substr(CAST("name" AS TEXT), 1, length(?)) = ? AND "id" > ? AND "note" IS NULL`,
	);
	expect(w.args).toHaveLength(3);
	expect(() =>
		whereOf([{ column: "x; drop", op: "eq", value: "" }], new Set(["id"])),
	).toThrow();
});

const hasDocker =
	Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" })
		.exitCode === 0;
const NAME = `ls-test-providers-libsql-${crypto.randomUUID().slice(0, 8)}`;
const IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.33";
/** Pulled when missing, retried past registry rate limits; skipped only if it never arrives. */
const hasImage = (() => {
	if (!hasDocker) return false;
	const present = () =>
		Bun.spawnSync(["docker", "image", "inspect", IMAGE], {
			stdout: "ignore",
			stderr: "ignore",
		}).exitCode === 0;
	for (let attempt = 1; attempt <= 4 && !present(); attempt++) {
		if (
			Bun.spawnSync(["docker", "pull", "-q", IMAGE], {
				stdout: "ignore",
				stderr: "ignore",
			}).exitCode === 0
		)
			break;
		Bun.sleepSync(2_000 * attempt);
	}
	return present();
})();

describe.skipIf(!hasImage)("libSQL explorer against sqld", () => {
	const creds = libsqlCredentials();
	let client: ReturnType<typeof libsqlClient>;

	beforeAll(async () => {
		const run = Bun.spawnSync([
			"docker",
			"run",
			"-d",
			"--name",
			NAME,
			"--label",
			"logistack.test=providers",
			"-e",
			`${LIBSQL_ENV.jwtKey}=${creds[LIBSQL_ENV.jwtKey]}`,
			"-p",
			"127.0.0.1::8080",
			IMAGE,
		]);
		if (run.exitCode !== 0) throw new Error(run.stderr.toString());
		const [host, port] = (
			Bun.spawnSync(["docker", "port", NAME, "8080/tcp"])
				.stdout.toString()
				.trim()
				.split("\n")[0] ?? ""
		).split(":") as [string, string];
		client = libsqlClient({
			engine: "libsql",
			host,
			port: Number(port),
			user: "",
			password: creds[LIBSQL_ENV.authToken] as string,
			database: "main",
		});
		for (let i = 0; ; i++)
			try {
				await client.introspect();
				break;
			} catch (e) {
				if (i > 60) throw e;
				await Bun.sleep(500);
			}
	}, 60_000);

	afterAll(() => {
		Bun.spawnSync(["docker", "rm", "-f", NAME]);
	});

	test("refuses a wrong token", async () => {
		const bad = libsqlClient({
			engine: "libsql",
			host: "127.0.0.1",
			port: Number(
				Bun.spawnSync(["docker", "port", NAME, "8080/tcp"])
					.stdout.toString()
					.trim()
					.split(":")
					.pop(),
			),
			user: "",
			password: "nope",
			database: "main",
		});
		await expect(bad.introspect()).rejects.toMatchObject({ reason: "auth" });
	});

	test("a script runs in one transaction and an error rolls it back", async () => {
		const ok = await client.query(
			`CREATE TABLE author (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
			 CREATE TABLE book (id INTEGER PRIMARY KEY, title TEXT, author_id INTEGER REFERENCES author(id), cover BLOB);
			 INSERT INTO author (name) VALUES ('Calvino'), ('Eco');
			 SELECT name FROM author ORDER BY id`,
			{ readOnly: false },
		);
		expect(ok.error).toBeNull();
		expect(ok.results.map((r) => r.command)).toEqual([
			"CREATE",
			"CREATE",
			"INSERT",
			"SELECT",
		]);
		expect(ok.results[2]?.affected).toBe(2);
		expect(ok.results[3]?.rows).toEqual([["Calvino"], ["Eco"]]);

		const failed = await client.query(
			"INSERT INTO author (name) VALUES ('Levi'); SELECT nope FROM author",
			{ readOnly: false },
		);
		expect(failed.error?.statement).toBe(1);
		const after = await client.query("SELECT count(*) AS n FROM author", {
			readOnly: true,
		});
		expect(after.results[0]?.rows).toEqual([[2]]);
	});

	test("a read-only run never persists", async () => {
		await client.query("DELETE FROM author", { readOnly: true });
		const n = await client.query("SELECT count(*) FROM author", {
			readOnly: true,
		});
		expect(n.results[0]?.rows).toEqual([[2]]);
	});

	test("introspect lists tables, keys and foreign keys", async () => {
		const s = await client.introspect();
		const tables = s.schemas[0]?.tables ?? [];
		expect(tables.map((t) => t.name)).toEqual(["author", "book"]);
		const book = tables.find((t) => t.name === "book");
		expect(book?.editable).toBe(true);
		expect(book?.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
		expect(book?.foreignKeys?.[0]).toMatchObject({
			refTable: "author",
			columns: ["author_id"],
			refColumns: ["id"],
		});
	});

	test("rows page, filter and sort; edits apply by primary key", async () => {
		const ref = { schema: "main", table: "book" };
		const written = await client.mutate(ref, [
			{ op: "insert", values: { title: "Il nome della rosa", author_id: 2 } },
			{
				op: "insert",
				values: {
					title: "Le città invisibili",
					author_id: 1,
					cover: { type: "bytea", value: "\\x0102" },
				},
			},
			{ op: "insert", values: { title: "Il barone rampante", author_id: 1 } },
		]);
		expect(written.rows[1]).toEqual([
			2,
			"Le città invisibili",
			1,
			{ type: "bytea", value: "\\x0102" },
		]);

		const first = await client.rows(ref, {
			limit: 2,
			sort: [{ column: "title", desc: false }],
			filter: [{ column: "author_id", op: "eq", value: "1" }],
		});
		expect(first.rows.map((r) => r[1])).toEqual([
			"Il barone rampante",
			"Le città invisibili",
		]);
		expect(first.nextCursor).toBeNull();

		const paged = await client.rows(ref, { limit: 2, sort: [], filter: [] });
		expect(paged.nextCursor).not.toBeNull();
		const rest = await client.rows(ref, {
			limit: 2,
			sort: [],
			filter: [],
			cursor: paged.nextCursor ?? undefined,
		});
		expect(rest.rows.map((r) => r[0])).toEqual([3]);

		await client.mutate(ref, [
			{ op: "update", key: { id: 3 }, values: { title: "Il barone" } },
			{ op: "delete", key: { id: 1 } },
		]);
		await expect(
			client.mutate(ref, [{ op: "delete", key: { id: 99 } }]),
		).rejects.toMatchObject({ reason: "stale" });
		const left = await client.rows(ref, { limit: 10, sort: [], filter: [] });
		expect(left.rows.map((r) => r[1])).toEqual([
			"Le città invisibili",
			"Il barone",
		]);
	});
});
