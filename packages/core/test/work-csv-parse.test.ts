import { expect, test } from "bun:test";
import { detectDelimiter, parseCsv, parseCsvDate } from "../src/index.ts";

test("parseCsv handles quotes, doubled quotes, newlines in fields and CRLF", () => {
	expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n\n1,\n')).toEqual([
		["a", "b"],
		["x, y", 'say "hi"\nthere'],
		["1", ""],
	]);
});

test("detectDelimiter picks the even split", () => {
	expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
	expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
	expect(detectDelimiter("title,due\nx,2026-01-01")).toBe(",");
});

test("parseCsvDate rejects impossible dates", () => {
	expect(parseCsvDate("31/12/2026", "DD/MM/YYYY")).toBe("2026-12-31");
	expect(parseCsvDate("12/31/2026", "MM/DD/YYYY")).toBe("2026-12-31");
	expect(parseCsvDate("2026-02-30")).toBeNull();
	expect(parseCsvDate("soon")).toBeNull();
});
