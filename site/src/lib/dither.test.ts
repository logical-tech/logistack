import { describe, expect, test } from "bun:test";
import { type DitherSpec, ditherCells, hex, type Shape } from "./dither";

const colors = [hex("#4FD08B"), hex("#4CC3D9"), hex("#3A66F0")] as const;
const shapes: Shape[] = [
	"arc",
	"wave",
	"mosaic",
	"rings",
	"stripes",
	"signal",
	"plus",
	"sunrise",
	"orb",
	"spiral",
	"diamond",
	"bloom",
	"bridge",
];
const key = (spec: DitherSpec) =>
	ditherCells(spec, 240, 240)
		.map((c) => `${c.x},${c.y}`)
		.join(" ");

describe("ditherCells", () => {
	test("every shape lights some cells but not the whole box", () => {
		for (const shape of shapes) {
			const lit = ditherCells({ shape, cell: 8, colors }, 240, 240).length;
			expect(lit, shape).toBeGreaterThan(20);
			expect(lit, shape).toBeLessThan(30 * 30);
		}
	});

	test("no two shapes draw the same pattern", () => {
		const patterns = new Set(
			shapes.map((shape) => key({ shape, cell: 8, colors })),
		);
		expect(patterns.size).toBe(shapes.length);
	});

	test("the same spec always yields the same cells", () => {
		expect(key({ shape: "spiral", cell: 8, colors, seed: 5 })).toBe(
			key({ shape: "spiral", cell: 8, colors, seed: 5 }),
		);
	});

	test("cells stay inside the box", () => {
		for (const c of ditherCells(
			{ shape: "arc", cell: 11, colors },
			1440,
			420,
		)) {
			expect(c.x + c.size).toBeLessThanOrEqual(1440);
			expect(c.y + c.size).toBeLessThanOrEqual(420);
		}
	});
});
