import { describe, expect, test } from "bun:test";
import {
	barGeometry,
	dateToX,
	scaleFor,
	visibleRange,
	xToDate,
} from "../../src/work/timeline.ts";

const origin = "2026-11-01";

describe("timeline", () => {
	test("zoom scales", () => {
		expect(scaleFor("day")).toEqual({ pxPerDay: 40, tick: "day" });
		expect(scaleFor("quarter").pxPerDay).toBe(2);
	});
	test("zoom round-trips for every level", () => {
		for (const zoom of ["day", "week", "month", "quarter"] as const) {
			const { pxPerDay } = scaleFor(zoom);
			for (const d of ["2026-10-01", "2026-11-01", "2027-02-28", "2028-02-29"])
				expect(xToDate(dateToX(d, origin, pxPerDay), origin, pxPerDay)).toBe(d);
		}
	});
	test("snapping to the nearest day", () => {
		expect(xToDate(59, origin, 40)).toBe("2026-11-02");
		expect(xToDate(61, origin, 40)).toBe("2026-11-03");
		expect(xToDate(-21, origin, 40)).toBe("2026-10-31");
	});
	test("visible range with overscan", () => {
		expect(visibleRange(400, 400, origin, 40)).toEqual({
			from: "2026-11-01",
			to: "2026-12-01",
		});
	});
	test("bar geometry", () => {
		expect(
			barGeometry(
				{ startDate: "2026-11-02", dueDate: "2026-11-04" },
				origin,
				10,
			),
		).toEqual({ x: 10, width: 30, kind: "bar" });
		expect(
			barGeometry(
				{ startDate: "2026-11-04", dueDate: "2026-11-04", isMilestone: true },
				origin,
				10,
			),
		).toEqual({ x: 30, width: 10, kind: "milestone" });
		expect(
			barGeometry({ startDate: null, dueDate: "2026-11-04" }, origin, 10),
		).toEqual({ x: 30, width: 10, kind: "due_only" });
		expect(
			barGeometry({ startDate: null, dueDate: null }, origin, 10),
		).toBeNull();
	});
});
