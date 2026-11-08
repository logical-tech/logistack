import { describe, expect, test } from "bun:test";
import type { RecurrenceRule } from "@logistack/contracts";
import {
	consumeOccurrence,
	describeRule,
	nextOccurrence,
} from "../../src/work/recurrence.ts";

const rule = (r: Partial<RecurrenceRule>): RecurrenceRule => ({
	freq: "daily",
	interval: 1,
	mode: "on_complete",
	ends: { kind: "never" },
	copy: {
		subtasks: false,
		checklist: true,
		fields: true,
		assignees: true,
		description: true,
	},
	...r,
});
const due = (d: string) => ({ startDate: null, dueDate: d });
const next = (r: RecurrenceRule, d: string) =>
	nextOccurrence(r, due(d))?.dueDate ?? null;

describe("nextOccurrence", () => {
	test("daily and interval", () => {
		expect(next(rule({}), "2026-12-31")).toBe("2027-01-01");
		expect(next(rule({ interval: 3 }), "2026-11-09")).toBe("2026-11-12");
	});
	test("keeps the start→due span", () => {
		expect(
			nextOccurrence(rule({ freq: "weekly" }), {
				startDate: "2026-11-09",
				dueDate: "2026-11-11",
			}),
		).toEqual({ startDate: "2026-11-16", dueDate: "2026-11-18" });
	});
	test("weekday sets", () => {
		// Mon/Wed/Fri; 2026-11-09 is a Monday.
		const r = rule({ freq: "weekly", byWeekday: [1, 3, 5] });
		expect(next(r, "2026-11-09")).toBe("2026-11-11");
		expect(next(r, "2026-11-13")).toBe("2026-11-16");
		const biweekly = rule({ freq: "weekly", interval: 2, byWeekday: [1] });
		expect(next(biweekly, "2026-11-09")).toBe("2026-11-23");
	});
	test("month end: 31st → 30th, 28th, 29th", () => {
		const r = rule({
			freq: "monthly",
			monthly: { kind: "dayOfMonth", day: 31 },
		});
		expect(next(r, "2027-01-31")).toBe("2027-02-28");
		expect(next(r, "2027-02-28")).toBe("2027-03-31");
		expect(next(r, "2027-03-31")).toBe("2027-04-30");
		expect(next(r, "2028-01-31")).toBe("2028-02-29");
		expect(
			next(
				rule({ freq: "monthly", monthly: { kind: "dayOfMonth", day: -1 } }),
				"2027-01-31",
			),
		).toBe("2027-02-28");
		expect(next(rule({ freq: "monthly" }), "2026-12-15")).toBe("2027-01-15");
	});
	test("nth weekday", () => {
		// 2nd Tuesday, last Friday.
		expect(
			next(
				rule({
					freq: "monthly",
					monthly: { kind: "nthWeekday", n: 2, weekday: 2 },
				}),
				"2026-11-10",
			),
		).toBe("2026-12-08");
		expect(
			next(
				rule({
					freq: "monthly",
					monthly: { kind: "nthWeekday", n: -1, weekday: 5 },
				}),
				"2026-11-27",
			),
		).toBe("2026-12-25");
	});
	test("leap years", () => {
		expect(next(rule({ freq: "yearly" }), "2028-02-29")).toBe("2029-02-28");
		expect(next(rule({ freq: "yearly", interval: 4 }), "2028-02-29")).toBe(
			"2032-02-29",
		);
	});
	test("until", () => {
		const r = rule({
			freq: "weekly",
			ends: { kind: "on", date: "2026-11-20" },
		});
		expect(next(r, "2026-11-09")).toBe("2026-11-16");
		expect(next(r, "2026-11-16")).toBeNull();
	});
	test("after n occurrences", () => {
		let r = rule({ ends: { kind: "after", count: 3 } });
		let d = "2026-11-09";
		const dates = [d];
		for (;;) {
			const n = nextOccurrence(r, due(d));
			if (!n?.dueDate) break;
			d = n.dueDate;
			dates.push(d);
			r = consumeOccurrence(r);
		}
		expect(dates).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
	});
	test("skip weekends", () => {
		expect(next(rule({ skipWeekends: true }), "2026-11-13")).toBe("2026-11-16");
	});
	test("no dates → null", () => {
		expect(
			nextOccurrence(rule({}), { startDate: null, dueDate: null }),
		).toBeNull();
	});
});

test("describeRule", () => {
	expect(describeRule(rule({}))).toBe("Every day");
	expect(
		describeRule(rule({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5] })),
	).toBe("Every weekday");
	expect(
		describeRule(rule({ freq: "weekly", interval: 2, byWeekday: [3, 1] })),
	).toBe("Every 2 weeks on Mon, Wed");
	expect(
		describeRule(
			rule({ freq: "monthly", monthly: { kind: "dayOfMonth", day: 31 } }),
		),
	).toBe("Every month on the 31st");
	expect(
		describeRule(
			rule({
				freq: "monthly",
				monthly: { kind: "nthWeekday", n: -1, weekday: 5 },
				ends: { kind: "after", count: 5 },
			}),
		),
	).toBe("Every month on the last Friday, 5 times");
	expect(
		describeRule(
			rule({ freq: "yearly", ends: { kind: "on", date: "2030-01-01" } }),
		),
	).toBe("Every year, until 2030-01-01");
});
