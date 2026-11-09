import { describe, expect, test } from "bun:test";
import type { WorkTaskListItem } from "@logistack/contracts";
import { buildRows, ticks } from "./layout";

const task = (
	id: string,
	o: Partial<WorkTaskListItem> = {},
): WorkTaskListItem => ({
	id,
	projectId: "prj",
	listId: "wls_a",
	parentId: null,
	number: 1,
	key: id,
	title: id,
	statusId: "s",
	priority: "none",
	startDate: "2026-11-02",
	dueDate: "2026-11-06",
	dueTime: null,
	isMilestone: false,
	estimateMinutes: null,
	position: "a",
	recurring: false,
	createdBy: null,
	completedAt: null,
	archivedAt: null,
	createdAt: "",
	updatedAt: "",
	assigneeIds: [],
	...o,
});

const opts = {
	rowsBy: "none" as const,
	nested: true,
	chronological: true,
	collapsed: new Set<string>(),
	lists: [],
	people: [],
};

describe("buildRows", () => {
	test("nests subtasks and sends undated tasks to the tray", () => {
		const { rows, unscheduled } = buildRows(
			[
				task("b", { startDate: "2026-11-05" }),
				task("a"),
				task("a1", { parentId: "a" }),
				task("a2", { parentId: "a", startDate: null, dueDate: null }),
				task("x", { startDate: null, dueDate: null }),
			],
			opts,
		);
		expect(
			rows.map((r) => (r.kind === "task" ? `${r.task.id}@${r.depth}` : r.key)),
		).toEqual(["a@0", "a1@1", "b@0"]);
		expect(unscheduled.map((t) => t.id)).toEqual(["a2", "x"]);
	});

	test("collapsed parents hide their subtree", () => {
		const { rows } = buildRows([task("a"), task("a1", { parentId: "a" })], {
			...opts,
			collapsed: new Set(["tl:a"]),
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ hasChildren: true, collapsed: true });
	});

	test("rows by assignee list a shared task under each person", () => {
		const { rows } = buildRows(
			[task("a", { assigneeIds: ["u1", "u2"] }), task("b")],
			{
				...opts,
				rowsBy: "assignee",
				people: [
					{
						userId: "u1",
						name: "One",
						avatar: null,
						assignable: true,
						guest: false,
					},
					{
						userId: "u2",
						name: "Two",
						avatar: null,
						assignable: true,
						guest: false,
					},
				],
			},
		);
		expect(rows.map((r) => r.key)).toEqual([
			"user:u1",
			"user:u1/a",
			"user:u2",
			"user:u2/a",
			"user:none",
			"user:none/b",
		]);
	});
});

describe("ticks", () => {
	test("weeks start on Monday, before the range if needed", () => {
		const w = ticks("2026-11-04", "2026-11-20", "week");
		expect(w.map((t) => t.date)).toEqual([
			"2026-11-02",
			"2026-11-09",
			"2026-11-16",
		]);
		expect(w[0]).toMatchObject({ label: "Nov 2", days: 7 });
	});

	test("months and quarters know their length", () => {
		expect(ticks("2026-12-15", "2027-02-01", "month")).toEqual([
			{ date: "2026-12-01", label: "Dec", days: 31 },
			{ date: "2027-01-01", label: "Jan", days: 31 },
			{ date: "2027-02-01", label: "Feb", days: 28 },
		]);
		expect(ticks("2026-11-09", "2026-11-09", "quarter")[0]).toMatchObject({
			date: "2026-10-01",
			label: "Q4",
			days: 92,
		});
	});
});
