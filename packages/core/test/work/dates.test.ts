import { describe, expect, test } from "bun:test";
import {
	addWorkingDays,
	dueBucket,
	isWorkingDay,
	localDate,
	startOfWeek,
	workingDaysBetween,
	zonedMidnight,
} from "../../src/work/dates.ts";

describe("working days", () => {
	test("Mon–Fri default skips weekends", () => {
		// 2026-11-06 is a Friday.
		expect(addWorkingDays("2026-11-06", 1)).toBe("2026-11-09");
		expect(addWorkingDays("2026-11-09", -1)).toBe("2026-11-06");
		expect(addWorkingDays("2026-11-06", 0)).toBe("2026-11-06");
		expect(addWorkingDays("2026-11-02", 10)).toBe("2026-11-16");
	});
	test("custom bitmask: Mon–Sat", () => {
		expect(isWorkingDay("2026-11-07", 63)).toBe(true);
		expect(addWorkingDays("2026-11-06", 1, 63)).toBe("2026-11-07");
		expect(addWorkingDays("2026-11-07", 1, 63)).toBe("2026-11-09");
	});
	test("only Sunday", () => {
		expect(addWorkingDays("2026-11-02", 1, 64)).toBe("2026-11-08");
	});
	test("year boundary", () => {
		// 2026-12-31 is a Thursday.
		expect(addWorkingDays("2026-12-31", 2)).toBe("2027-01-04");
		expect(workingDaysBetween("2026-12-31", "2027-01-04")).toBe(2);
	});
	test("between mirrors add in both directions", () => {
		for (const [a, b] of [
			["2026-11-02", "2026-11-20"],
			["2026-11-20", "2026-11-02"],
			["2026-11-06", "2026-11-09"],
		] as const) {
			const n = workingDaysBetween(a, b);
			expect(addWorkingDays(a, n)).toBe(b);
		}
		expect(workingDaysBetween("2026-11-09", "2026-11-06")).toBe(-1);
		expect(workingDaysBetween("2026-11-07", "2026-11-08")).toBe(0);
	});
	test("week starts on Monday", () => {
		expect(startOfWeek("2026-11-08")).toBe("2026-11-02");
		expect(startOfWeek("2026-11-09")).toBe("2026-11-09");
	});
});

describe("time zones", () => {
	test("local date across midnight", () => {
		const t = new Date("2026-11-09T23:30:00Z");
		expect(localDate(t, "UTC")).toBe("2026-11-09");
		expect(localDate(t, "Europe/Rome")).toBe("2026-11-10");
		expect(localDate(t, "America/New_York")).toBe("2026-11-09");
	});
	test("zoned midnight on DST days", () => {
		expect(zonedMidnight("2026-03-29", "Europe/Rome").toISOString()).toBe(
			"2026-03-28T23:00:00.000Z",
		);
		expect(zonedMidnight("2026-03-30", "Europe/Rome").toISOString()).toBe(
			"2026-03-29T22:00:00.000Z",
		);
		expect(zonedMidnight("2026-10-26", "Europe/Rome").toISOString()).toBe(
			"2026-10-25T23:00:00.000Z",
		);
	});
});

describe("dueBucket", () => {
	// Monday 2026-11-09, 10:00 UTC.
	const now = new Date("2026-11-09T10:00:00Z");
	test.each([
		[null, "none"],
		["2026-11-08", "overdue"],
		["2026-11-09", "today"],
		["2026-11-10", "tomorrow"],
		["2026-11-15", "this_week"],
		["2026-11-16", "next_week"],
		["2026-11-22", "next_week"],
		["2026-11-23", "later"],
	] as const)("%s → %s", (due, bucket) => {
		expect(dueBucket(due, now)).toBe(bucket);
	});
	test("uses the viewer's time zone", () => {
		const late = new Date("2026-11-09T23:30:00Z");
		expect(dueBucket("2026-11-09", late, "UTC")).toBe("today");
		expect(dueBucket("2026-11-09", late, "Europe/Rome")).toBe("overdue");
	});
	test("Sunday: tomorrow is next week's Monday", () => {
		const sun = new Date("2026-11-08T12:00:00Z");
		expect(dueBucket("2026-11-09", sun)).toBe("tomorrow");
		expect(dueBucket("2026-11-10", sun)).toBe("next_week");
	});
});
