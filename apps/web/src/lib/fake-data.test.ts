import { expect, test } from "bun:test";
import { faker } from "@faker-js/faker/locale/en";
import {
	AUTO,
	GENERATORS,
	generateRows,
	PRESETS,
	presetDdl,
	presetDropSql,
	REFERENCE,
	suggest,
} from "./fake-data";

const col = (name: string, type: string, extra = {}) => ({
	name,
	type,
	primaryKey: false,
	default: null,
	...extra,
});

test("suggestions read the name first, then the type", () => {
	expect(suggest(col("email", "text"))).toBe("email");
	expect(suggest(col("first_name", "varchar(255)"))).toBe("first_name");
	expect(suggest(col("created_at", "timestamp"))).toBe("past");
	expect(suggest(col("price", "numeric(10,2)"))).toBe("price");
	expect(suggest(col("is_active", "boolean"))).toBe("boolean");
	expect(suggest(col("flags", "tinyint(1)"))).toBe("boolean");
	expect(suggest(col("whatever", "uuid"))).toBe("uuid");
	expect(suggest(col("country", "character(2)"))).toBe("country_code");
	expect(suggest(col("country", "varchar(80)"))).toBe("country");
	expect(suggest(col("x", "integer"))).toBe("int_small");
	expect(
		suggest(col("id", "bigint", { primaryKey: true }), { singleKey: true }),
	).toBe(AUTO);
	expect(suggest(col("id", "integer", { default: "nextval('s')" }))).toBe(AUTO);
	expect(suggest(col("author_id", "bigint"), { reference: true })).toBe(
		REFERENCE,
	);
});

test("rows follow the plan: auto left out, references from the pool, unique emails", () => {
	faker.seed(1);
	const rows = generateRows(
		faker,
		[
			{ name: "id", type: "bigint", generator: AUTO, nulls: 0 },
			{ name: "first_name", type: "text", generator: "first_name", nulls: 0 },
			{ name: "email", type: "text", generator: "email", nulls: 0 },
			{ name: "owner_id", type: "bigint", generator: REFERENCE, nulls: 0 },
			{ name: "is_active", type: "boolean", generator: "boolean", nulls: 0 },
			{ name: "flag", type: "tinyint(1)", generator: "boolean", nulls: 0 },
			{ name: "seen", type: "date", generator: "past", nulls: 0 },
			{ name: "short", type: "varchar(4)", generator: "paragraph", nulls: 0 },
		],
		300,
		{ owner_id: [7, 8] },
	);
	expect(rows).toHaveLength(300);
	expect(rows.every((r) => !("id" in r))).toBe(true);
	expect(new Set(rows.map((r) => r.email)).size).toBe(300);
	expect(rows.every((r) => r.owner_id === 7 || r.owner_id === 8)).toBe(true);
	expect(typeof rows[0]?.is_active).toBe("boolean");
	expect([0, 1]).toContain(rows[0]?.flag as number);
	expect(String(rows[0]?.seen)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	expect(rows.every((r) => String(r.short).length <= 4)).toBe(true);
});

test("every generator produces a value", () => {
	for (const g of GENERATORS)
		expect(() =>
			g.make(faker, { i: 0, row: {}, column: { name: "c", type: "text" } }),
		).not.toThrow();
});

test("preset DDL quotes per dialect and puts parents first", () => {
	const shop = PRESETS.find((p) => p.id === "shop");
	if (!shop) throw new Error("no shop preset");
	const pg = presetDdl(shop, "postgres", "public", "demo_");
	expect(pg).toContain('CREATE TABLE "public"."demo_customers"');
	expect(pg).toContain('REFERENCES "public"."demo_customers" ("id")');
	expect(pg.indexOf("demo_customers")).toBeLessThan(pg.indexOf("demo_orders"));
	expect(presetDdl(shop, "mysql", "shop")).toContain("`shop`.`orders`");
	expect(presetDdl(shop, "sqlite", "main")).toContain('CREATE TABLE "orders"');
	for (const p of PRESETS)
		for (const [i, t] of p.tables.entries())
			for (const c of t.columns)
				if (c.references)
					expect(
						p.tables.slice(0, i).some((x) => x.name === c.references),
					).toBe(true);
});

test("the undo drops children before parents", () => {
	const shop = PRESETS.find((p) => p.id === "shop");
	if (!shop) throw new Error("no shop preset");
	const sql = presetDropSql(shop, "postgres", "public", "x_");
	expect(sql.indexOf('"x_order_items"')).toBeLessThan(
		sql.indexOf('"x_customers"'),
	);
});
