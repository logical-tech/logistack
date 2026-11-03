import { expect, test } from "bun:test";
import { leadingWord, splitSql } from "../src/sql.ts";

const texts = (s: string) => splitSql(s).map((x) => x.text);

test("splits on top-level semicolons, offsets point back into the script", () => {
	const script = "select 1;\n  select 2 ;\n\n-- just a comment\n;select 3";
	const parts = splitSql(script);
	expect(parts.map((p) => p.text)).toEqual([
		"select 1",
		"select 2",
		"select 3",
	]);
	for (const p of parts) expect(script.slice(p.from, p.to)).toBe(p.text);
});

test("semicolons inside quotes, dollar quotes and comments do not split", () => {
	expect(
		texts(
			`select 'a;''b'; select "x;y" from t; select E'\\';'; select $$;$$, $f$ ; $$ $f$`,
		),
	).toEqual([
		"select 'a;''b'",
		'select "x;y" from t',
		"select E'\\';'",
		"select $$;$$, $f$ ; $$ $f$",
	]);
	expect(
		texts("select 1 /* ; /* ; */ ; */ ; select 2 -- ;\n; select $1"),
	).toEqual(["select 1 /* ; /* ; */ ; */", "select 2 -- ;", "select $1"]);
	expect(
		texts(
			"create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql; select 1",
		),
	).toHaveLength(2);
});

test("an unterminated quote runs to the end", () => {
	expect(texts("select 'a; select 2")).toEqual(["select 'a; select 2"]);
});

test("leadingWord skips comments and parentheses", () => {
	expect(leadingWord("  -- hi\n/* x */ (Select 1)")).toBe("select");
	expect(leadingWord("COMMIT")).toBe("commit");
	expect(leadingWord("-- only")).toBe("");
});

test("mysql: backticks, backslash escapes and # comments do not split", () => {
	const my = (s: string) => splitSql(s, "mysql").map((x) => x.text);
	expect(
		my(
			"select `a;b` from t; select 'it\\'s;' , \"x\\\";\"; # c ;\nselect 1 -- ;\n; select 2--1; select $$;select $$",
		),
	).toEqual([
		"select `a;b` from t",
		"select 'it\\'s;' , \"x\\\";\"",
		"# c ;\nselect 1 -- ;",
		"select 2--1",
		"select $$",
		"select $$",
	]);
	expect(my("select 1 /* ; /* ; */ ; select 2")).toEqual([
		"select 1 /* ; /* ; */",
		"select 2",
	]);
	expect(leadingWord("# note\nUPDATE t set a = 1")).toBe("update");
});
