/*
 * Groups of tasks for a `groupBy` key, in a stable order, each with the values a task created in
 * that group should get. Shared by the table (sections) and usable by the board (columns).
 */
import type {
	DueBucket,
	GroupKey,
	WorkColor,
	WorkTaskListItem,
} from "@logistack/contracts";
import { dueBucket } from "@logistack/core/work";
import { PRIORITIES } from "./lib";
import type { NewTaskInput, WorkProjectContext } from "./views/types";

export type TaskGroup = {
	/** Stable id, also what `collapsedGroups` stores. */
	key: string;
	label: string;
	color?: WorkColor | null;
	/** Status groups draw the status icon. */
	statusId?: string;
	personId?: string;
	tasks: WorkTaskListItem[];
	/** What "+ Add task" in this group sets. */
	defaults: Partial<NewTaskInput>;
};

const BUCKETS: [DueBucket, string][] = [
	["overdue", "Overdue"],
	["today", "Today"],
	["tomorrow", "Tomorrow"],
	["this_week", "This week"],
	["next_week", "Next week"],
	["later", "Later"],
	["none", "No due date"],
];

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The group keys one task belongs to (two assignees → two groups). */
export function taskGroupKeys(
	t: WorkTaskListItem,
	groupBy: GroupKey,
	now = new Date(),
): string[] {
	switch (groupBy) {
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
			return [dueBucket(t.dueDate, now, tz())];
		default: {
			const v = t.fields?.[groupBy.slice(6)];
			if (Array.isArray(v)) return v.length ? v.map(String) : ["none"];
			if (v === true) return ["true"];
			return v === undefined || v === null || v === false
				? ["none"]
				: [String(v)];
		}
	}
}

/** Every group in display order; empty groups are kept for statuses and priorities (drop targets). */
export function groupTasks(
	tasks: WorkTaskListItem[],
	groupBy: GroupKey | null,
	project: Pick<
		WorkProjectContext,
		"statuses" | "lists" | "tags" | "people" | "fields"
	>,
	now = new Date(),
): TaskGroup[] {
	if (!groupBy)
		return [{ key: "all", label: "All tasks", tasks, defaults: {} }];

	let groups: Omit<TaskGroup, "tasks">[];
	let keepEmpty = false;
	switch (groupBy) {
		case "status":
			keepEmpty = true;
			groups = project.statuses.map((s) => ({
				key: s.id,
				label: s.name,
				color: s.color,
				statusId: s.id,
				defaults: { statusId: s.id },
			}));
			break;
		case "priority":
			keepEmpty = true;
			groups = PRIORITIES.map((p) => ({
				key: p.id,
				label: p.label,
				defaults: { priority: p.id },
			}));
			break;
		case "assignee":
			groups = [
				...project.people.map((p) => ({
					key: p.userId,
					label: p.name,
					personId: p.userId,
					defaults: { assignees: [p.userId] },
				})),
				{ key: "none", label: "Unassigned", defaults: {} },
			];
			break;
		case "list":
			groups = project.lists.map((l) => ({
				key: l.id,
				label: l.name,
				color: l.color,
				defaults: { listId: l.id },
			}));
			break;
		case "tag":
			groups = [
				...project.tags.map((t) => ({
					key: t.id,
					label: t.name,
					color: t.color,
					defaults: { tags: [t.id] },
				})),
				{ key: "none", label: "No tags", defaults: {} },
			];
			break;
		case "dueBucket":
			groups = BUCKETS.map(([key, label]) => ({ key, label, defaults: {} }));
			break;
		default: {
			const fieldId = groupBy.slice(6);
			const field = project.fields.find((f) => f.id === fieldId);
			const c = field?.config;
			const set = (v: unknown) => ({ fields: { [fieldId]: v } });
			groups =
				c?.kind === "select" || c?.kind === "multi_select"
					? c.options.map((o) => ({
							key: o.id,
							label: o.label,
							color: o.color,
							defaults: set(c.kind === "multi_select" ? [o.id] : o.id),
						}))
					: c?.kind === "user"
						? project.people.map((p) => ({
								key: p.userId,
								label: p.name,
								personId: p.userId,
								defaults: set(c.multiple ? [p.userId] : p.userId),
							}))
						: c?.kind === "checkbox"
							? [
									{
										key: "true",
										label: `${field?.name}: yes`,
										defaults: set(true),
									},
								]
							: [];
			groups.push({
				key: "none",
				label: `No ${field?.name ?? "value"}`,
				defaults: {},
			});
		}
	}

	const byKey = new Map(groups.map((g) => [g.key, [] as WorkTaskListItem[]]));
	for (const t of tasks)
		for (const k of taskGroupKeys(t, groupBy, now)) {
			const list = byKey.get(k) ?? byKey.get("none");
			list?.push(t);
		}
	return groups
		.map((g) => ({ ...g, tasks: byKey.get(g.key) ?? [] }))
		.filter((g) => keepEmpty || g.tasks.length > 0);
}
