import { expect, test } from "bun:test";
import { parseHumanDate } from "../../src/work/human-date.ts";

// Monday 2026-11-09.
const now = new Date("2026-11-09T10:00:00Z");
test.each([
	["today", "2026-11-09"],
	["Tomorrow", "2026-11-10"],
	["yesterday", "2026-11-08"],
	["fri", "2026-11-13"],
	["friday", "2026-11-13"],
	["mon", "2026-11-16"],
	["next fri", "2026-11-20"],
	["next week", "2026-11-16"],
	["next month", "2026-12-01"],
	["in 3 days", "2026-11-12"],
	["in 2 weeks", "2026-11-23"],
	["in 1 month", "2026-12-09"],
	["2027-02-28", "2027-02-28"],
	["dec 3", "2026-12-03"],
	["3 December", "2026-12-03"],
	["jan 5", "2027-01-05"],
	["feb 29 2028", "2028-02-29"],
])("%s → %s", (input, date) => {
	expect(parseHumanDate(input, now)).toEqual({ date });
});
test.each(["", "someday", "month", "2027-02-30", "feb 30", "in 2 years"])(
	"%s → null",
	(input) => {
		expect(parseHumanDate(input, now)).toBeNull();
	},
);
test("time zone decides today", () => {
	expect(
		parseHumanDate("today", new Date("2026-11-09T23:30:00Z"), "Europe/Rome"),
	).toEqual({ date: "2026-11-10" });
});
