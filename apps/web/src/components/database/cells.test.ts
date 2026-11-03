import { expect, test } from "bun:test";
import type { DbColumn } from "@logistack/contracts";
import {
	EMPTY_STAGED,
	fromText,
	isNumeric,
	nextSort,
	shortType,
	stageEdit,
	toCsv,
	toJson,
	toOps,
} from "./cells";

const col = (type: string): DbColumn => ({
	name: "c",
	type,
	nullable: true,
	default: null,
	primaryKey: false,
});

test("an edit keeps the original's tag and picks the column's JSON shape", () => {
	const big = { type: "bigint", value: "9007199254740993" } as const;
	expect(fromText("9007199254740995", col("bigint"), big)).toEqual({
		type: "bigint",
		value: "9007199254740995",
	});
	expect(fromText("12.50", col("numeric(10,2)"), null)).toEqual({
		type: "numeric",
		value: "12.50",
	});
	expect(fromText('{"a":1}', col("jsonb"), null)).toEqual({
		type: "json",
		value: '{"a":1}',
	});
	expect(fromText("42", col("integer"), 7)).toBe(42);
	expect(fromText("4x", col("integer"), 7)).toBe("4x");
	expect(fromText("false", col("boolean"), true)).toBe(false);
	expect(fromText("2026-11-03", col("date"), "2026-11-02")).toBe("2026-11-03");
});

test("staged edits become one ordered batch, and reverting an edit drops it", () => {
	const key = { id: 1 };
	let s = stageEdit(EMPTY_STAGED, key, "name", "Ada", "Ann");
	s = stageEdit(s, { id: 2 }, "name", "Bob", "Rob");
	s = stageEdit(s, { id: 2 }, "name", "Rob", "Rob");
	expect(Object.keys(s.edits)).toEqual([JSON.stringify(key)]);

	s = {
		...stageEdit(s, { id: 3 }, "name", "Cy", "Sy"),
		deletes: { [JSON.stringify({ id: 3 })]: { id: 3 } },
		inserts: [{ id: "n1", values: { name: "New" } }],
	};
	expect(toOps(s)).toEqual([
		{ op: "update", key: { id: 1 }, values: { name: "Ada" } },
		{ op: "delete", key: { id: 3 } },
		{ op: "insert", values: { name: "New" } },
	]);
});

test("column headers shorten Postgres type names", () => {
	expect(shortType("character varying(255)")).toBe("varchar(255)");
	expect(shortType("timestamp with time zone")).toBe("timestamptz");
	expect(shortType("timestamp(3) without time zone")).toBe("timestamp(3)");
	expect(shortType("double precision")).toBe("float8");
	expect(shortType("text[]")).toBe("text[]");
});

test("a header click cycles one column; shift adds and keeps the others", () => {
	expect(nextSort([], "a", false)).toEqual([{ column: "a", desc: false }]);
	expect(nextSort([{ column: "a", desc: false }], "a", false)).toEqual([
		{ column: "a", desc: true },
	]);
	expect(nextSort([{ column: "a", desc: true }], "a", false)).toEqual([]);
	expect(nextSort([{ column: "a", desc: false }], "b", false)).toEqual([
		{ column: "b", desc: false },
	]);
	const two = nextSort([{ column: "a", desc: false }], "b", true);
	expect(two).toEqual([
		{ column: "a", desc: false },
		{ column: "b", desc: false },
	]);
	expect(nextSort(nextSort(two, "a", true), "a", true)).toEqual([
		{ column: "b", desc: false },
	]);
});

test("results copy as CSV and JSON without losing duplicates or precision", () => {
	const columns = [
		{ name: "a", type: "int4" },
		{ name: "a", type: "text" },
		{ name: "big", type: "int8" },
	];
	const rows = [
		[
			1,
			'say "hi", then\nleave',
			{ type: "bigint" as const, value: "9007199254740993" },
		],
		[null, "", null],
	];
	expect(toCsv(columns, rows)).toBe(
		'a,a,big\r\n1,"say ""hi"", then\nleave",9007199254740993\r\n,,',
	);
	expect(JSON.parse(toJson(columns, rows))).toEqual([
		{ a: 1, a_2: 'say "hi", then\nleave', big: "9007199254740993" },
		{ a: null, a_2: "", big: null },
	]);
});

test("MySQL column types: numbers align right and edit as numbers", () => {
	const column = (type: string) => ({
		name: "n",
		type,
		nullable: true,
		default: null,
		primaryKey: false,
	});
	expect(isNumeric("int unsigned")).toBe(true);
	expect(isNumeric("decimal(30,10)")).toBe(true);
	expect(isNumeric("varchar(20)")).toBe(false);
	expect(fromText("7", column("int unsigned"), null)).toBe(7);
	expect(fromText("9007199254740993", column("bigint(20)"), null)).toEqual({
		type: "bigint",
		value: "9007199254740993",
	});
	expect(fromText("1.50", column("decimal(10,2)"), null)).toBe("1.50");
});
