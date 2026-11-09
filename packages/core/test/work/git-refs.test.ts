import { describe, expect, test } from "bun:test";
import { parseWorkRefs } from "../../src/work/git-refs.ts";

const keys = ["SHOP", "BLOG"];

describe("parseWorkRefs", () => {
	test("plain mention doesn't close", () => {
		expect(parseWorkRefs("SHOP-12: tidy checkout", keys)).toEqual([
			{ key: "SHOP", number: 12, closes: false },
		]);
	});
	test("closing keywords", () => {
		for (const kw of ["Fixes", "fix", "Closed", "resolves:", "RESOLVED"])
			expect(parseWorkRefs(`${kw} SHOP-12`, keys)).toEqual([
				{ key: "SHOP", number: 12, closes: true },
			]);
	});
	test("lists after a keyword close every item", () => {
		expect(parseWorkRefs("Fixes SHOP-12, SHOP-13 and BLOG-2", keys)).toEqual([
			{ key: "SHOP", number: 12, closes: true },
			{ key: "SHOP", number: 13, closes: true },
			{ key: "BLOG", number: 2, closes: true },
		]);
		expect(
			parseWorkRefs("SHOP-12, SHOP-13", keys).every((r) => !r.closes),
		).toBe(true);
		expect(parseWorkRefs("Fixes SHOP-1 and also touches SHOP-2", keys)).toEqual(
			[
				{ key: "SHOP", number: 1, closes: true },
				{ key: "SHOP", number: 2, closes: false },
			],
		);
	});
	test("GitHub-style #n ignored, unknown keys ignored", () => {
		expect(parseWorkRefs("closes #12, see NOPE-3", keys)).toEqual([]);
	});
	test("case rules: messages strict, branches insensitive", () => {
		expect(parseWorkRefs("fixes shop-42", keys)).toEqual([]);
		expect(
			parseWorkRefs("feature/shop-42-login", keys, { caseInsensitive: true }),
		).toEqual([{ key: "SHOP", number: 42, closes: false }]);
	});
	test("duplicates merge, closing wins", () => {
		expect(parseWorkRefs("SHOP-1 then fixes SHOP-1", keys)).toEqual([
			{ key: "SHOP", number: 1, closes: true },
		]);
	});
	test("no partial key matches", () => {
		expect(parseWorkRefs("XSHOP-1 SHOP-12345678901", keys)).toEqual([]);
	});
});
