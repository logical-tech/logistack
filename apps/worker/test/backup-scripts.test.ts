import { describe, expect, test } from "bun:test";
import { databaseEngines } from "@logistack/contracts";
import {
	dumpScript,
	judgeSanity,
	restoreScript,
} from "../src/backup-scripts.ts";

describe("backup scripts", () => {
	test("credentials reach the tools through env or a 0600 file, never a flag", () => {
		for (const engine of databaseEngines) {
			const s = dumpScript(engine);
			expect(s).not.toMatch(/--password[= ]|-p\$|-p"\$/);
			if (engine === "mysql" || engine === "mariadb" || engine === "mongo")
				expect(s).toContain("umask 077");
		}
	});

	test("sanity passes on tables or user databases only", () => {
		expect(judgeSanity("postgres", "3\n")).toEqual({
			ok: true,
			detail: "3 tables restored",
		});
		expect(judgeSanity("mysql", "0")).toMatchObject({ ok: false });
		expect(judgeSanity("postgres", "psql: error")).toMatchObject({ ok: false });
		expect(judgeSanity("mongo", "shop,crm")).toEqual({
			ok: true,
			detail: "2 database(s): shop, crm",
		});
		expect(judgeSanity("mongo", "")).toMatchObject({ ok: false });
	});

	test("redis and libsql restores go through the volume", () => {
		expect(() => restoreScript("redis")).toThrow(/volume/);
		expect(() => restoreScript("libsql")).toThrow(/volume/);
	});
});
