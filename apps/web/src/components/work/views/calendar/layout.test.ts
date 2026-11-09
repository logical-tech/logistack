import { describe, expect, test } from "bun:test";
import { hiddenPerDay, layoutWeek, monthGrid } from "./layout";

const week = "2026-11-09"; // a Monday
const item = (id: string, start: string, end = start) => ({ id, start, end });

describe("monthGrid", () => {
	test("six weeks from the Monday on or before the 1st", () => {
		const g = monthGrid("2026-11-20");
		expect(g).toHaveLength(42);
		expect(g[0]).toBe("2026-10-26");
		expect(g[6]).toBe("2026-11-01");
		expect(g[41]).toBe("2026-12-06");
	});
});

describe("layoutWeek", () => {
	test("non-overlapping items share a lane", () => {
		const s = layoutWeek(
			[
				item("a", "2026-11-09", "2026-11-10"),
				item("b", "2026-11-11", "2026-11-12"),
			],
			week,
		);
		expect(s.map((x) => [x.item.id, x.col, x.span, x.lane])).toEqual([
			["a", 0, 2, 0],
			["b", 2, 2, 0],
		]);
	});

	test("overlaps stack, longer first on the same start", () => {
		const s = layoutWeek(
			[
				item("short", "2026-11-10"),
				item("long", "2026-11-10", "2026-11-13"),
				item("mid", "2026-11-12"),
			],
			week,
		);
		const lane = Object.fromEntries(s.map((x) => [x.item.id, x.lane]));
		expect(lane).toEqual({ long: 0, short: 1, mid: 1 });
	});

	test("spans wrapping across weeks are clipped at the edges", () => {
		const s = layoutWeek([item("wrap", "2026-11-04", "2026-11-18")], week);
		expect(s[0]).toMatchObject({
			col: 0,
			span: 7,
			clippedStart: true,
			clippedEnd: true,
		});
		expect(layoutWeek([item("x", "2026-11-01")], week)).toHaveLength(0);
	});

	test("a freed lane is reused by a later item", () => {
		const s = layoutWeek(
			[
				item("a", "2026-11-09", "2026-11-10"),
				item("b", "2026-11-09", "2026-11-15"),
				item("c", "2026-11-11"),
			],
			week,
		);
		// b (longer) takes lane 0, a lane 1; c starts after a ends and reuses lane 1.
		expect(s.find((x) => x.item.id === "c")?.lane).toBe(1);
	});
});

describe("hiddenPerDay", () => {
	test("counts segments past the visible lanes on each day they cover", () => {
		const s = layoutWeek(
			[
				item("a", "2026-11-10"),
				item("b", "2026-11-10"),
				item("c", "2026-11-10", "2026-11-11"),
			],
			week,
		);
		// c (two days) sits in lane 0; a and b stack above it on Tuesday only.
		expect(hiddenPerDay(s, 2)).toEqual([0, 1, 0, 0, 0, 0, 0]);
		expect(hiddenPerDay(s, 0)).toEqual([0, 3, 1, 0, 0, 0, 0]);
	});
});
