import { describe, expect, test } from "bun:test";
import type { WorkFieldConfig } from "@logistack/contracts";
import {
	mapClickUpField,
	mapClickUpStatus,
	mapClickUpTask,
	nearestWorkColor,
} from "../../src/work/clickup-map.ts";

describe("mapClickUpStatus", () => {
	test.each([
		[{ status: "to do", type: "open" }, "backlog"],
		[{ status: "in review", type: "custom" }, "active"],
		[{ status: "complete", type: "done" }, "done"],
		[{ status: "closed", type: "closed" }, "done"],
		[{ status: "Cancelled", type: "closed" }, "cancelled"],
		[{ status: "won't do", type: "closed" }, "cancelled"],
	] as const)("%o → %s", (s, category) => {
		expect(mapClickUpStatus(s).category).toBe(category);
	});
	test("name and colour", () => {
		expect(
			mapClickUpStatus({
				status: "in review",
				type: "custom",
				color: "#ff0000",
			}),
		).toEqual({ name: "In review", category: "active", color: "red" });
		expect(nearestWorkColor("#0f0")).toBe("green");
		expect(nearestWorkColor(null)).toBe("gray");
	});
});

describe("mapClickUpField", () => {
	const kind = (type: string, type_config: Record<string, unknown> = {}) => {
		const r = mapClickUpField({ id: "f", name: "F", type, type_config });
		return "skip" in r ? "skip" : r.config;
	};
	test("each field type", () => {
		expect(kind("short_text")).toEqual({ kind: "text" });
		expect(kind("text")).toEqual({ kind: "long_text" });
		expect(kind("number", { precision: 2 })).toEqual({
			kind: "number",
			decimals: 2,
		});
		expect(kind("currency", { currency_type: "eur", precision: 2 })).toEqual({
			kind: "currency",
			currency: "EUR",
			decimals: 2,
		});
		expect(
			kind("drop_down", {
				options: [{ id: "o1", name: "Hot", color: "#e50000", orderindex: 0 }],
			}),
		).toEqual({
			kind: "select",
			options: [{ id: "o1", label: "Hot", color: "red" }],
		});
		expect(kind("labels", { options: [{ id: "l1", label: "A" }] })).toEqual({
			kind: "multi_select",
			options: [{ id: "l1", label: "A", color: "gray" }],
		});
		expect(kind("date")).toEqual({ kind: "date", withTime: false });
		expect(kind("checkbox")).toEqual({ kind: "checkbox" });
		expect(kind("url")).toEqual({ kind: "url" });
		expect(kind("email")).toEqual({ kind: "email" });
		expect(kind("phone")).toEqual({ kind: "phone" });
		expect(kind("emoji", { count: 12 })).toEqual({
			kind: "rating",
			max: 10,
			icon: "star",
		});
		expect(kind("users")).toEqual({ kind: "user", multiple: true });
		expect(kind("manual_progress")).toEqual({ kind: "percent", decimals: 0 });
		for (const t of [
			"automatic_progress",
			"formula",
			"rollup",
			"tasks",
			"location",
			"button",
			"votes",
		])
			expect(kind(t)).toBe("skip");
	});
});

describe("mapClickUpTask", () => {
	const select: WorkFieldConfig = {
		kind: "select",
		options: [
			{ id: "o1", label: "Hot", color: "red" },
			{ id: "o2", label: "Cold", color: "blue" },
		],
	};
	const maps = {
		statuses: { "in progress": "wst_2" },
		fields: {
			cf_sel: { fieldId: "wfd_sel", config: select },
			cf_date: {
				fieldId: "wfd_date",
				config: { kind: "date", withTime: false } as WorkFieldConfig,
			},
			cf_money: {
				fieldId: "wfd_money",
				config: {
					kind: "currency",
					currency: "EUR",
					decimals: 2,
				} as WorkFieldConfig,
			},
			cf_people: {
				fieldId: "wfd_people",
				config: { kind: "user", multiple: true } as WorkFieldConfig,
			},
		},
		users: { "101": "usr_sara" },
		tz: "Europe/Rome",
		fallbackStatusId: "wst_1",
	};
	test("priority, dates in workspace tz, fields, people", () => {
		const d = mapClickUpTask(
			{
				id: "abc",
				name: "Checkout",
				url: "https://app.clickup.com/t/abc",
				status: { status: "In Progress" },
				priority: { id: "2", priority: "high" },
				// 2026-11-09T23:30Z = 10 Nov 00:30 in Rome.
				due_date: String(Date.parse("2026-11-09T23:30:00Z")),
				due_date_time: true,
				start_date: String(Date.parse("2026-11-02T08:00:00Z")),
				markdown_description: "Do **it**",
				assignees: [{ id: 101 }, { id: 202 }],
				tags: [{ name: "web" }],
				time_estimate: 5_400_000,
				custom_fields: [
					{ id: "cf_sel", value: 1 },
					{ id: "cf_date", value: String(Date.parse("2026-12-01T10:00:00Z")) },
					{ id: "cf_money", value: 12.5 },
					{ id: "cf_people", value: [{ id: 101 }, { id: 202 }] },
					{ id: "cf_unmapped", value: "x" },
				],
			},
			maps,
		);
		expect(d).toMatchObject({
			externalId: "abc",
			statusId: "wst_2",
			priority: "high",
			dueDate: "2026-11-10",
			dueTime: "00:30",
			startDate: "2026-11-02",
			estimateMinutes: 90,
			assigneeIds: ["usr_sara"],
			unmatchedAssignees: ["202"],
			tagNames: ["web"],
			fields: {
				wfd_sel: "o2",
				wfd_date: "2026-12-01",
				wfd_money: "12.50",
				wfd_people: ["usr_sara"],
			},
		});
		expect(d.description?.content?.[0]?.content?.[1]).toEqual({
			type: "text",
			text: "it",
			marks: [{ type: "bold" }],
		});
	});
	test("missing priority and unknown status", () => {
		const d = mapClickUpTask(
			{ id: "x", name: " ", status: { status: "weird" }, priority: null },
			maps,
		);
		expect(d).toMatchObject({
			priority: "none",
			statusId: "wst_1",
			title: "Untitled",
			dueDate: null,
			description: null,
		});
		expect(
			mapClickUpTask(
				{ id: "y", name: "t", status: { status: "x" }, priority: { id: "1" } },
				maps,
			).priority,
		).toBe("urgent");
	});
});
