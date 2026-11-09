import { describe, expect, test } from "bun:test";
import { roundedPath, routeArrow } from "./arrows";

describe("routeArrow", () => {
	test("forward link turns once, just after the blocker", () => {
		expect(routeArrow({ x: 100, y: 16 }, { x: 200, y: 80 })).toEqual([
			{ x: 100, y: 16 },
			{ x: 110, y: 16 },
			{ x: 110, y: 80 },
			{ x: 200, y: 80 },
		]);
	});

	test("same row and room to spare is a straight line", () => {
		expect(routeArrow({ x: 100, y: 16 }, { x: 140, y: 16 })).toEqual([
			{ x: 100, y: 16 },
			{ x: 140, y: 16 },
		]);
	});

	test("backward link loops through the gap below the blocker row", () => {
		const route = routeArrow({ x: 200, y: 16 }, { x: 150, y: 80 });
		expect(route.map((p) => p.y)).toEqual([16, 16, 32, 32, 80, 80]);
		expect(route[1]?.x).toBe(210);
		expect(route[3]?.x).toBe(140);
		expect(route.at(-1)).toEqual({ x: 150, y: 80 });
	});

	test("backward link to a row above goes through the gap above", () => {
		const route = routeArrow({ x: 200, y: 80 }, { x: 150, y: 16 });
		expect(route[2]?.y).toBe(64);
	});

	test("too tight to turn forward also loops", () => {
		expect(routeArrow({ x: 100, y: 16 }, { x: 115, y: 80 })).toHaveLength(6);
	});
});

describe("roundedPath", () => {
	test("rounds every corner with a quadratic curve", () => {
		const d = roundedPath(
			[
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 10, y: 40 },
				{ x: 50, y: 40 },
			],
			4,
		);
		expect(d).toBe("M0 0 L6 0 Q10 0 10 4 L10 36 Q10 40 14 40 L50 40");
	});

	test("never rounds more than half of a short segment", () => {
		const d = roundedPath(
			[
				{ x: 0, y: 0 },
				{ x: 4, y: 0 },
				{ x: 4, y: 20 },
			],
			10,
		);
		expect(d).toBe("M0 0 L2 0 Q4 0 4 2 L4 20");
	});

	test("drops collinear and repeated points", () => {
		expect(
			roundedPath([
				{ x: 0, y: 0 },
				{ x: 5, y: 0 },
				{ x: 5, y: 0 },
				{ x: 20, y: 0 },
			]),
		).toBe("M0 0 L20 0");
	});
});
