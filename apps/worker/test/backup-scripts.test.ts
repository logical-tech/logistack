import { describe, expect, test } from "bun:test";
import { judgeSanity } from "../src/backup-scripts.ts";

describe("backup scripts", () => {
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
});
