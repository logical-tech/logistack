import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { pendingMigrations, runMigrations } from "../src/migrate.ts";

const meta = (folderMillis: number, hash: string) => ({
	folderMillis,
	hash,
	sql: [],
	bps: true,
});

describe("pendingMigrations", () => {
	test("applies an older-timestamped migration recorded after a far-future one", () => {
		// The 0.7.0 bug: 0051–0058 carry far-future timestamps, so drizzle skipped 0064/0065.
		const journal = [meta(100, "a"), meta(900, "future"), meta(200, "late")];
		const applied = [
			{ hash: "a", created_at: "100" },
			{ hash: "future", created_at: "900" },
		];
		expect(pendingMigrations(journal, applied).map((m) => m.hash)).toEqual([
			"late",
		]);
	});

	test("treats an edited file as applied when its timestamp is recorded", () => {
		const journal = [meta(100, "edited-hash")];
		expect(
			pendingMigrations(journal, [{ hash: "original-hash", created_at: 100 }]),
		).toEqual([]);
	});

	test("treats a renumbered file as applied when its hash is recorded", () => {
		const journal = [meta(300, "same-sql")];
		expect(
			pendingMigrations(journal, [{ hash: "same-sql", created_at: 250 }]),
		).toEqual([]);
	});

	test("keeps journal order", () => {
		const journal = [meta(3, "c"), meta(1, "a"), meta(2, "b")];
		expect(pendingMigrations(journal, []).map((m) => m.hash)).toEqual([
			"c",
			"a",
			"b",
		]);
	});
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("runMigrations against real Postgres", () => {
	test("applies a migration skipped behind far-future timestamps, once, under concurrency", async () => {
		const admin = postgres(url as string, { max: 1, onnotice: () => {} });
		const name = `ls_test_db_migrate_${Date.now()}`;
		await admin.unsafe(`create database ${name}`);
		const target = new URL(url as string);
		target.pathname = `/${name}`;
		const dbUrl = target.toString();
		const db = postgres(dbUrl, { max: 1, onnotice: () => {} });
		try {
			const journal = readMigrationFiles({
				migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
			});
			await runMigrations(dbUrl, journal.slice(0, -1));
			// The 0.7.0 state: recorded timestamps later than the next migration's.
			await db`update drizzle.__drizzle_migrations set created_at = created_at + 10000000000`;
			await Promise.all([runMigrations(dbUrl), runMigrations(dbUrl)]);
			const rows = await db<{ count: string }[]>`
				select count(*) from drizzle.__drizzle_migrations`;
			expect(Number(rows[0]?.count)).toBe(journal.length);
			const work = await db<{ count: string }[]>`
				select count(*) from information_schema.tables where table_name = 'work_org_settings'`;
			expect(Number(work[0]?.count)).toBe(1);
		} finally {
			await db.end();
			await admin.unsafe(`drop database if exists ${name} with (force)`);
			await admin.end();
		}
	});
});
