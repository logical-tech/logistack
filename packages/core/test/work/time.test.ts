import { describe, expect, test } from "bun:test";
import {
	formatDuration,
	overlaps,
	parseDuration,
	rollupTime,
	type TimeEntryLike,
} from "../../src/work/time.ts";

const e = (
	id: string,
	start: string,
	end: string | null,
	p: Partial<TimeEntryLike> = {},
): TimeEntryLike => ({
	id,
	userId: "u1",
	projectId: "p1",
	taskId: "t1",
	startedAt: start,
	endedAt: end,
	billable: true,
	...p,
});
const now = new Date("2026-11-10T12:00:00Z");

describe("rollupTime", () => {
	test("entries crossing midnight are split by local day", () => {
		const r = rollupTime(
			[e("a", "2026-11-09T22:00:00Z", "2026-11-10T02:00:00Z")],
			"day",
			{ from: "2026-11-01", to: "2026-11-30" },
			"UTC",
			now,
		);
		expect(r.rows).toEqual([
			{ key: "2026-11-09", seconds: 7200, billableSeconds: 7200, entries: 1 },
			{ key: "2026-11-10", seconds: 7200, billableSeconds: 7200, entries: 1 },
		]);
		expect(r.totals).toEqual({
			seconds: 14400,
			billableSeconds: 14400,
			entries: 1,
		});
	});
	test("time zone moves the day boundary", () => {
		const r = rollupTime(
			[e("a", "2026-11-09T22:00:00Z", "2026-11-10T02:00:00Z")],
			"day",
			{ from: "2026-11-01", to: "2026-11-30" },
			"Europe/Rome",
			now,
		);
		expect(r.rows.map((x) => [x.key, x.seconds])).toEqual([
			["2026-11-09", 3600],
			["2026-11-10", 10800],
		]);
	});
	test("running timer counts to now; range clips", () => {
		const r = rollupTime(
			[
				e("a", "2026-11-10T10:00:00Z", null),
				e("b", "2026-10-31T23:00:00Z", "2026-11-01T01:00:00Z", {
					billable: false,
				}),
			],
			"user",
			{ from: "2026-11-01", to: "2026-11-10" },
			"UTC",
			now,
		);
		expect(r.rows).toEqual([
			{ key: "u1", seconds: 7200 + 3600, billableSeconds: 7200, entries: 2 },
		]);
	});
	test("grouping by project, task, week", () => {
		const entries = [
			e("a", "2026-11-09T08:00:00Z", "2026-11-09T09:00:00Z"),
			e("b", "2026-11-16T08:00:00Z", "2026-11-16T10:00:00Z", {
				projectId: "p2",
				taskId: "t2",
			}),
		];
		const range = { from: "2026-11-01", to: "2026-11-30" };
		expect(
			rollupTime(entries, "project", range, "UTC", now).rows.map((r) => r.key),
		).toEqual(["p2", "p1"]);
		expect(
			rollupTime(entries, "week", range, "UTC", now).rows.map((r) => r.key),
		).toEqual(["2026-11-09", "2026-11-16"]);
	});
});

test("overlaps", () => {
	const list = [
		e("a", "2026-11-09T08:00:00Z", "2026-11-09T09:00:00Z"),
		e("r", "2026-11-10T11:00:00Z", null),
	];
	expect(
		overlaps(
			list,
			{
				id: "n",
				userId: "u1",
				startedAt: "2026-11-09T08:30:00Z",
				endedAt: "2026-11-09T10:00:00Z",
			},
			now,
		)?.id,
	).toBe("a");
	expect(
		overlaps(
			list,
			{
				id: "n",
				userId: "u1",
				startedAt: "2026-11-09T09:00:00Z",
				endedAt: "2026-11-09T10:00:00Z",
			},
			now,
		),
	).toBeNull();
	expect(
		overlaps(
			list,
			{
				id: "n",
				userId: "u2",
				startedAt: "2026-11-09T08:30:00Z",
				endedAt: "2026-11-09T10:00:00Z",
			},
			now,
		),
	).toBeNull();
	expect(
		overlaps(
			list,
			{
				id: "n",
				userId: "u1",
				startedAt: "2026-11-10T11:30:00Z",
				endedAt: "2026-11-10T11:45:00Z",
			},
			now,
		)?.id,
	).toBe("r");
});

test("formatDuration and parseDuration", () => {
	expect(formatDuration(5400)).toBe("1h 30m");
	expect(formatDuration(3600)).toBe("1h");
	expect(formatDuration(59)).toBe("0m");
	expect(parseDuration("1h30")).toBe(5400);
	expect(parseDuration("1h 30m")).toBe(5400);
	expect(parseDuration("90m")).toBe(5400);
	expect(parseDuration("1.5h")).toBe(5400);
	expect(parseDuration("1:30")).toBe(5400);
	expect(parseDuration("45")).toBe(2700);
	expect(parseDuration("abc")).toBeNull();
	expect(parseDuration("0m")).toBeNull();
});
