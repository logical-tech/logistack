import { describe, expect, test } from "bun:test";
import { spreadTask } from "../src/routes/work/reports.ts";
import { csvField } from "../src/routes/work/time.ts";

describe("work extras units", () => {
	test("csvField quotes, doubles quotes and defuses formulas", () => {
		expect(csvField("plain")).toBe("plain");
		expect(csvField('a "b", c')).toBe('"a ""b"", c"');
		expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
		expect(csvField("-1,5")).toBe(`"'-1,5"`);
		expect(csvField(-2)).toBe("-2");
		expect(csvField("line\nbreak")).toBe('"line\nbreak"');
	});

	test("spreadTask spreads over working days and splits between assignees", () => {
		// Thu 12 → Tue 17 Nov 2026: Thu, Fri (week of 9th), Mon, Tue (week of 16th).
		const s = spreadTask(
			{
				startDate: "2026-11-12",
				dueDate: "2026-11-17",
				estimateMinutes: 480,
				assignees: 2,
			},
			31,
		);
		expect(Object.fromEntries(s)).toEqual({
			"2026-11-09": 120,
			"2026-11-16": 120,
		});
		// Due on a Sunday with no start: counted on that day.
		expect(
			Object.fromEntries(
				spreadTask(
					{
						startDate: null,
						dueDate: "2026-11-15",
						estimateMinutes: 60,
						assignees: 1,
					},
					31,
				),
			),
		).toEqual({ "2026-11-09": 60 });
	});
});
