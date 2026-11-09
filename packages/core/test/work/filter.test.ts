import { describe, expect, test } from "bun:test";
import type { FilterNode } from "@logistack/contracts";
import {
	type MatchableTask,
	matchesTask,
	resolveRelativeDates,
	validateFilter,
} from "../../src/work/filter.ts";

const fields = [
	{ id: "budget", kind: "number" as const },
	{ id: "client", kind: "select" as const },
	{ id: "ok", kind: "checkbox" as const },
];

describe("validateFilter", () => {
	test("accepts nested and/or", () => {
		expect(
			validateFilter(
				{
					and: [
						{ key: "status", op: "any_of", value: ["wst_1"] },
						{
							or: [
								{ key: "assignee", op: "is", value: "me" },
								{ key: "field:budget", op: "gt", value: 10 },
							],
						},
					],
				},
				fields,
			),
		).toEqual({ ok: true });
	});
	test("rejects unknown field, wrong op, bad value", () => {
		expect(
			validateFilter({ key: "field:nope", op: "is", value: 1 }, fields).ok,
		).toBe(false);
		expect(
			validateFilter(
				{ key: "field:budget", op: "contains", value: "x" },
				fields,
			).ok,
		).toBe(false);
		expect(
			validateFilter(
				{ key: "dueDate", op: "relative", value: "someday" },
				fields,
			).ok,
		).toBe(false);
		expect(
			validateFilter({ key: "status", op: "any_of", value: [] }, fields).ok,
		).toBe(false);
		expect(
			validateFilter({ key: "blocked", op: "is", value: "yes" }, fields).ok,
		).toBe(false);
	});
	test("depth and count limits", () => {
		const deep: FilterNode = {
			and: [
				{
					and: [
						{ and: [{ and: [{ key: "text", op: "contains", value: "x" }] }] },
					],
				},
			],
		};
		expect(validateFilter(deep, fields).ok).toBe(false);
		const many: FilterNode = {
			or: Array.from({ length: 31 }, () => ({
				key: "text" as const,
				op: "contains" as const,
				value: "x",
			})),
		};
		expect(validateFilter(many, fields).ok).toBe(false);
	});
});

describe("resolveRelativeDates", () => {
	const rel = (value: string): FilterNode => ({
		key: "dueDate",
		op: "relative",
		value,
	});
	// Monday 2026-11-09.
	const now = new Date("2026-11-09T10:00:00Z");
	test.each([
		["today", { key: "dueDate", op: "on", value: "2026-11-09" }],
		[
			"this_week",
			{ key: "dueDate", op: "between", value: ["2026-11-09", "2026-11-15"] },
		],
		[
			"last_week",
			{ key: "dueDate", op: "between", value: ["2026-11-02", "2026-11-08"] },
		],
		[
			"next_week",
			{ key: "dueDate", op: "between", value: ["2026-11-16", "2026-11-22"] },
		],
		[
			"this_month",
			{ key: "dueDate", op: "between", value: ["2026-11-01", "2026-11-30"] },
		],
		[
			"next_7_days",
			{ key: "dueDate", op: "between", value: ["2026-11-09", "2026-11-16"] },
		],
		["overdue", { key: "dueDate", op: "before", value: "2026-11-09" }],
		["no_date", { key: "dueDate", op: "empty" }],
	])("%s", (value, expected) => {
		expect(resolveRelativeDates(rel(value), now)).toEqual(
			expected as FilterNode,
		);
	});
	test("across DST: the viewer's local day decides", () => {
		// 00:30 UTC on the spring-forward day is 01:30 in Rome, still the 29th.
		expect(
			resolveRelativeDates(
				rel("today"),
				new Date("2026-03-29T00:30:00Z"),
				"Europe/Rome",
			),
		).toEqual({ key: "dueDate", op: "on", value: "2026-03-29" });
		// 23:30 UTC after fall-back (UTC+1) is already the 26th in Rome.
		expect(
			resolveRelativeDates(
				rel("yesterday"),
				new Date("2026-10-25T23:30:00Z"),
				"Europe/Rome",
			),
		).toEqual({ key: "dueDate", op: "on", value: "2026-10-25" });
		// Same instant in New York is still the 25th.
		expect(
			resolveRelativeDates(
				rel("today"),
				new Date("2026-10-25T23:30:00Z"),
				"America/New_York",
			),
		).toEqual({ key: "dueDate", op: "on", value: "2026-10-25" });
	});
	test("February in a leap year", () => {
		expect(
			resolveRelativeDates(rel("this_month"), new Date("2028-02-10T00:00:00Z")),
		).toEqual({
			key: "dueDate",
			op: "between",
			value: ["2028-02-01", "2028-02-29"],
		});
	});
});

describe("matchesTask", () => {
	const task: MatchableTask = {
		id: "t1",
		statusId: "wst_1",
		statusCategory: "active",
		assigneeIds: ["u1", "u2"],
		priority: "high",
		listId: "wls_1",
		tagIds: ["tag_a"],
		startDate: "2026-11-05",
		dueDate: "2026-11-10",
		createdAt: "2026-11-01T23:30:00Z",
		updatedAt: new Date("2026-11-08T10:00:00Z"),
		completedAt: null,
		createdBy: "u1",
		title: "Fix checkout",
		descriptionText: "Stripe webhook fails",
		parentId: null,
		isMilestone: false,
		blocked: true,
		fields: { budget: 120, client: "acme" },
	};
	const ctx = { me: "u2", now: new Date("2026-11-09T10:00:00Z") };
	test.each<[string, FilterNode, boolean]>([
		["assignee me", { key: "assignee", op: "is", value: "me" }, true],
		[
			"assignee all_of",
			{ key: "assignee", op: "all_of", value: ["u1", "me"] },
			true,
		],
		[
			"status none_of",
			{ key: "status", op: "none_of", value: ["wst_1"] },
			false,
		],
		[
			"text contains (description)",
			{ key: "text", op: "contains", value: "stripe" },
			true,
		],
		[
			"due tomorrow",
			{ key: "dueDate", op: "relative", value: "tomorrow" },
			true,
		],
		[
			"due this week",
			{ key: "dueDate", op: "relative", value: "this_week" },
			true,
		],
		["overdue", { key: "dueDate", op: "relative", value: "overdue" }, false],
		["completedAt empty", { key: "completedAt", op: "empty" }, true],
		["field gt", { key: "field:budget", op: "gt", value: 100 }, true],
		[
			"field between",
			{ key: "field:budget", op: "between", value: [0, 100] },
			false,
		],
		["field select is", { key: "field:client", op: "is", value: "acme" }, true],
		[
			"checkbox missing is false",
			{ key: "field:ok", op: "is", value: false },
			true,
		],
		["blocked", { key: "blocked", op: "is", value: true }, true],
		["parent empty", { key: "parent", op: "empty" }, true],
		[
			"and/or",
			{
				and: [
					{ key: "priority", op: "is", value: "high" },
					{
						or: [
							{ key: "tag", op: "any_of", value: ["x"] },
							{ key: "list", op: "is", value: "wls_1" },
						],
					},
				],
			},
			true,
		],
	])("%s", (_, node, expected) => {
		expect(matchesTask(node, task, ctx)).toBe(expected);
	});
	test("timestamps compare as local dates", () => {
		const node: FilterNode = {
			key: "createdAt",
			op: "on",
			value: "2026-11-02",
		};
		expect(matchesTask(node, task, { ...ctx, tz: "Europe/Rome" })).toBe(true);
		expect(matchesTask(node, task, { ...ctx, tz: "UTC" })).toBe(false);
	});
});
