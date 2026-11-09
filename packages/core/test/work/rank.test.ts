import { describe, expect, test } from "bun:test";
import {
	needsRebalance,
	rankBetween,
	rankN,
	rebalance,
} from "../../src/work/rank.ts";

// Postgres `collate "C"` compares bytes, like JS `<` on ASCII strings.
const sortedC = (keys: string[]) =>
	[...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("rank", () => {
	test("between null/null", () => {
		const k = rankBetween();
		expect(k.length).toBe(1);
	});
	test("before first and after last", () => {
		const k = rankBetween();
		const before = rankBetween(null, k);
		const after = rankBetween(k, null);
		expect(before < k && k < after).toBe(true);
	});
	test("between two neighbours", () => {
		const a = rankBetween();
		const b = rankBetween(a, null);
		const m = rankBetween(a, b);
		expect(a < m && m < b).toBe(true);
	});
	test("many inserts at the same spot stay short and ordered", () => {
		const first = rankBetween();
		let hi = rankBetween(first, null);
		const keys = [first, hi];
		for (let i = 0; i < 50; i++) {
			hi = rankBetween(first, hi);
			keys.push(hi);
		}
		expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(12);
		expect(new Set(keys).size).toBe(keys.length);
		const ordered = sortedC(keys);
		expect(ordered[0]).toBe(first);
	});
	test("repeated prepend and append", () => {
		let lo = rankBetween();
		let hi = lo;
		for (let i = 0; i < 200; i++) {
			const nlo = rankBetween(null, lo);
			const nhi = rankBetween(hi, null);
			expect(nlo < lo && nhi > hi).toBe(true);
			lo = nlo;
			hi = nhi;
		}
		expect(hi.length).toBeLessThan(10);
	});
	test("rankN gives n ordered keys inside the bounds", () => {
		const a = rankBetween();
		const b = rankBetween(a, null);
		const keys = rankN(a, b, 20);
		expect(keys).toHaveLength(20);
		expect(sortedC(keys)).toEqual(keys);
		expect(keys.every((k) => k > a && k < b)).toBe(true);
	});
	test("rebalance spreads short keys", () => {
		const keys = rebalance(1000);
		expect(new Set(keys).size).toBe(1000);
		expect(sortedC(keys)).toEqual(keys);
		expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(3);
		expect(needsRebalance("a".repeat(25))).toBe(true);
		expect(needsRebalance(keys[0] as string)).toBe(false);
	});
	test("rejects inverted bounds", () => {
		expect(() => rankBetween("b", "a")).toThrow();
	});
});
