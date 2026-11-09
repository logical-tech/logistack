/*
 * Board grouping: which columns (or swimlanes) a group key produces, which of
 * them a task sits in, and what a drop between two of them writes.
 */
import {
	type DueBucket,
	type GroupKey,
	type WorkColor,
	type WorkPriority,
	type WorkTaskCreate,
	type WorkTaskListItem,
	workPriorities,
} from "@logistack/contracts";
import {
	addDays,
	daysBetween,
	dueBucket,
	localDate,
	startOfWeek,
} from "@logistack/core/work";
import type { ProjectMeta } from "../common/data";

export type Group = {
	key: string;
	label: string;
	color: WorkColor | null;
	/** Drops into this group write something unambiguous. */
	droppable: boolean;
	wipLimit: number | null;
	/** Hint under the header (e.g. why a column is empty). */
	userId?: string;
};

export const PRIORITY_LABEL: Record<WorkPriority, string> = {
	urgent: "Urgent",
	high: "High",
	normal: "Normal",
	low: "Low",
	none: "No priority",
};
const PRIORITY_COLOR: Record<WorkPriority, WorkColor | null> = {
	urgent: "red",
	high: "amber",
	normal: "blue",
	low: "gray",
	none: null,
};
export const BUCKET_LABEL: Record<DueBucket, string> = {
	overdue: "Overdue",
	today: "Today",
	tomorrow: "Tomorrow",
	this_week: "Later this week",
	next_week: "Next week",
	later: "Later",
	none: "No due date",
};
const BUCKETS: DueBucket[] = [
	"overdue",
	"today",
	"tomorrow",
	"this_week",
	"next_week",
	"later",
	"none",
];

const group = (
	key: string,
	label: string,
	o: Partial<Omit<Group, "key" | "label">> = {},
): Group => ({
	key,
	label,
	color: null,
	droppable: true,
	wipLimit: null,
	...o,
});

/** Board columns (or lanes) for `key`; null when the key can't be drawn as a board. */
export function groupsFor(
	key: GroupKey,
	meta: ProjectMeta,
	now: Date,
): Group[] | null {
	switch (key) {
		case "status":
			return meta.statuses.map((s) =>
				group(s.id, s.name, { color: s.color, wipLimit: s.wipLimit }),
			);
		case "priority":
			return workPriorities.map((p) =>
				group(p, PRIORITY_LABEL[p], { color: PRIORITY_COLOR[p] }),
			);
		case "assignee":
			return [
				group("none", "Unassigned"),
				...meta.people
					.filter((p) => p.assignable)
					.map((p) => group(p.userId, p.name, { userId: p.userId })),
			];
		case "list":
			return meta.lists.map((l) => group(l.id, l.name, { color: l.color }));
		case "tag":
			return [
				...meta.tags.map((t) =>
					group(t.id, t.name, { color: t.color, droppable: false }),
				),
				group("none", "No tag", { droppable: false }),
			];
		case "dueBucket":
			return BUCKETS.map((b) =>
				group(b, BUCKET_LABEL[b], {
					droppable: b === "none" || bucketDate(b, now) !== null,
					color: b === "overdue" ? "red" : null,
				}),
			);
		default: {
			const field = meta.fields.find((f) => `field:${f.id}` === key);
			if (!field) return null;
			const c = field.config;
			if (c.kind === "select" || c.kind === "multi_select")
				return [
					...c.options.map((o) =>
						group(o.id, o.label, {
							color: o.color ?? null,
							droppable: c.kind === "select",
						}),
					),
					group("none", `No ${field.name.toLowerCase()}`, {
						droppable: c.kind === "select",
					}),
				];
			if (c.kind === "checkbox")
				return [group("true", "Checked"), group("false", "Unchecked")];
			if (c.kind === "user" && !c.multiple)
				return [
					group("none", `No ${field.name.toLowerCase()}`),
					...meta.people.map((p) =>
						group(p.userId, p.name, { userId: p.userId }),
					),
				];
			return null;
		}
	}
}

/** The groups a task belongs to (a task with two assignees sits in two columns). */
export function groupValues(
	t: WorkTaskListItem,
	key: GroupKey,
	now: Date,
): string[] {
	switch (key) {
		case "status":
			return [t.statusId];
		case "priority":
			return [t.priority];
		case "assignee":
			return t.assigneeIds?.length ? t.assigneeIds : ["none"];
		case "list":
			return [t.listId];
		case "tag":
			return t.tagIds?.length ? t.tagIds : ["none"];
		case "dueBucket":
			return [dueBucket(t.dueDate, now)];
		default: {
			const v = t.fields?.[key.slice(6)];
			if (Array.isArray(v)) return v.length ? v.map(String) : ["none"];
			if (typeof v === "boolean") return [String(v)];
			return [v === null || v === undefined ? "none" : String(v)];
		}
	}
}

/** The date a drop into a due bucket sets, or null when the bucket has no unambiguous day. */
export function bucketDate(b: DueBucket, now: Date): string | null {
	const today = localDate(now);
	const monday = startOfWeek(today);
	switch (b) {
		case "today":
			return today;
		case "tomorrow":
			return addDays(today, 1);
		case "this_week": {
			// Friday, else Sunday, as long as it is still after tomorrow.
			for (const d of [addDays(monday, 4), addDays(monday, 6)])
				if (daysBetween(today, d) > 1) return d;
			return null;
		}
		case "next_week":
			return addDays(monday, 7);
		case "later":
			return addDays(monday, 14);
		default:
			return null;
	}
}

/** What dropping a task from group `from` into group `to` writes. */
export type GroupWrite =
	| { kind: "move"; statusId?: string; listId?: string }
	| {
			kind: "patch";
			patch: {
				priority?: WorkPriority;
				dueDate?: string | null;
				startDate?: null;
			};
	  }
	| { kind: "assignee"; remove: string | null; add: string | null }
	| { kind: "field"; fieldId: string; value: unknown };

export function writeFor(
	key: GroupKey,
	groups: readonly Group[],
	t: WorkTaskListItem,
	from: string,
	to: string,
	now: Date,
): GroupWrite | null {
	if (from === to) return null;
	const target = groups.find((g) => g.key === to);
	if (!target?.droppable) return null;
	switch (key) {
		case "status":
			return { kind: "move", statusId: to };
		case "list":
			return { kind: "move", listId: to };
		case "priority":
			return { kind: "patch", patch: { priority: to as WorkPriority } };
		case "dueBucket": {
			const due = to === "none" ? null : bucketDate(to as DueBucket, now);
			if (to !== "none" && !due) return null;
			// A start after the new due date would make an inverted bar.
			const clearStart = !!due && !!t.startDate && t.startDate > due;
			return {
				kind: "patch",
				patch: { dueDate: due, ...(clearStart ? { startDate: null } : {}) },
			};
		}
		case "assignee":
			return {
				kind: "assignee",
				remove: from === "none" ? null : from,
				add: to === "none" ? null : to,
			};
		case "tag":
			return null;
		default: {
			const fieldId = key.slice(6);
			const value =
				to === "none"
					? null
					: to === "true"
						? true
						: to === "false"
							? false
							: to;
			return { kind: "field", fieldId, value };
		}
	}
}

/** The task as it looks after `write`, for optimistic placement. */
export function applyWrite<T extends WorkTaskListItem>(t: T, w: GroupWrite): T {
	switch (w.kind) {
		case "move":
			return {
				...t,
				...(w.statusId ? { statusId: w.statusId } : {}),
				...(w.listId ? { listId: w.listId } : {}),
			};
		case "patch":
			return { ...t, ...w.patch };
		case "assignee": {
			const ids = (t.assigneeIds ?? []).filter(
				(id) => id !== w.remove && id !== w.add,
			);
			return { ...t, assigneeIds: w.add ? [...ids, w.add] : ids };
		}
		case "field":
			return { ...t, fields: { ...t.fields, [w.fieldId]: w.value } };
	}
}

/** Defaults for a task created from a column's "+" (and its lane, if any). */
export function createDefaults(
	key: GroupKey,
	value: string,
	now: Date,
	/** The field is a multi-select: its value is a list. */
	multi = false,
): Partial<WorkTaskCreate> {
	if (value === "none" && key !== "dueBucket") return {};
	switch (key) {
		case "status":
			return { statusId: value };
		case "list":
			return { listId: value };
		case "priority":
			return { priority: value as WorkPriority };
		case "assignee":
			return { assignees: [value] };
		case "tag":
			return { tags: [value] };
		case "dueBucket": {
			const due = bucketDate(value as DueBucket, now);
			return due ? { dueDate: due } : {};
		}
		default:
			return {
				fields: {
					[key.slice(6)]: multi
						? [value]
						: value === "true"
							? true
							: value === "false"
								? false
								: value,
				},
			};
	}
}
