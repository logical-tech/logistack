import { expect, test } from "bun:test";
import { parseDotenv } from "./dotenv";

test("assignments, export, comments, quotes and escapes", () => {
	const r = parseDotenv(
		[
			"# database",
			"export DATABASE_URL=postgres://u:p@db:5432/app",
			"PORT = 8080 # inline comment",
			`GREETING="hello # not a comment\\nworld"`,
			"LITERAL='no $expansion \\n here'",
			"EMPTY=",
			"",
			"DATABASE_URL=postgres://override",
		].join("\n"),
	);
	expect(r.invalid).toEqual([]);
	expect(Object.fromEntries(r.variables.map((v) => [v.key, v.value]))).toEqual({
		DATABASE_URL: "postgres://override",
		PORT: "8080",
		GREETING: "hello # not a comment\nworld",
		LITERAL: "no $expansion \\n here",
		EMPTY: "",
	});
});

test("a double-quoted value spans lines until its closing quote", () => {
	const r = parseDotenv('KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1');
	expect(r.variables).toEqual([
		{ key: "KEY", value: "-----BEGIN-----\nabc\n-----END-----" },
		{ key: "NEXT", value: "1" },
	]);
});

test("invalid lines are reported by number and skipped", () => {
	const r = parseDotenv('just text\n1BAD=x\nOK=1\nOPEN="never closed');
	expect(r.invalid).toEqual([1, 2, 4]);
	expect(r.variables).toEqual([{ key: "OK", value: "1" }]);
});
