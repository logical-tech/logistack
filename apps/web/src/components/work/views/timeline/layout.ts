/** Timeline rows (the left tree) and header ticks. Pure, so both are testable. */
import type {
	WorkColor,
	WorkList,
	WorkPerson,
	WorkTaskListItem,
} from "@logistack/contracts";
import { addDays, daysBetween, startOfWeek } from "@logistack/core/work";

export type TimelineRow =
	| {
			kind: "group";
			key: string;
			label: string;
			color: WorkColor | null;
			count: number;
			collapsed: boolean;
	  }
	| {
			kind: "task";
			key: string;
			task: WorkTaskListItem;
			depth: number;
			hasChildren: boolean;
			collapsed: boolean;
	  };

const dated = (t: WorkTaskListItem) => !!(t.startDate || t.dueDate);
const anchor = (t: WorkTaskListItem) => t.startDate ?? t.dueDate ?? "9999";

/**
 * Rows grouped by list, by assignee (a task with two assignees shows under both) or flat;
 * subtasks nest under their parent when `nested`. Tasks with no dates anywhere in their
 * subtree go to the unscheduled tray instead. `collapsed` holds `tl:<rowKey>` entries.
 */
export function buildRows(
	tasks: readonly WorkTaskListItem[],
	opts: {
		rowsBy: "list" | "assignee" | "none";
		nested: boolean;
		chronological: boolean;
		collapsed: ReadonlySet<string>;
		lists: readonly WorkList[];
		people: readonly WorkPerson[];
	},
): { rows: TimelineRow[]; unscheduled: WorkTaskListItem[] } {
	const ids = new Set(tasks.map((t) => t.id));
	const children = new Map<string, WorkTaskListItem[]>();
	const roots: WorkTaskListItem[] = [];
	for (const t of tasks) {
		if (opts.nested && t.parentId && ids.has(t.parentId))
			children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
		else roots.push(t);
	}
	const order = (list: WorkTaskListItem[]) =>
		opts.chronological
			? [...list].sort((a, b) => anchor(a).localeCompare(anchor(b)))
			: list;
	const hasDates = (t: WorkTaskListItem): boolean =>
		dated(t) || (children.get(t.id) ?? []).some(hasDates);
	const byId = new Map(tasks.map((t) => [t.id, t]));
	// An undated subtask of an undated parent rides along with its parent in the tray.
	const unscheduled = tasks.filter((t) => {
		if (hasDates(t)) return false;
		const parent = opts.nested && t.parentId ? byId.get(t.parentId) : undefined;
		return !parent || hasDates(parent);
	});

	const rows: TimelineRow[] = [];
	const pushTask = (t: WorkTaskListItem, depth: number, prefix: string) => {
		if (!hasDates(t)) return;
		const key = `${prefix}${t.id}`;
		const kids = order(children.get(t.id) ?? []).filter(hasDates);
		const collapsed = opts.collapsed.has(`tl:${key}`);
		rows.push({
			kind: "task",
			key,
			task: t,
			depth,
			hasChildren: kids.length > 0,
			collapsed,
		});
		if (!collapsed) for (const k of kids) pushTask(k, depth + 1, prefix);
	};
	const pushGroup = (
		key: string,
		label: string,
		color: WorkColor | null,
		members: WorkTaskListItem[],
	) => {
		const shown = order(members).filter(hasDates);
		if (!shown.length) return;
		const collapsed = opts.collapsed.has(`tl:${key}`);
		rows.push({
			kind: "group",
			key,
			label,
			color,
			count: shown.length,
			collapsed,
		});
		if (!collapsed) for (const t of shown) pushTask(t, 0, `${key}/`);
	};

	if (opts.rowsBy === "list") {
		for (const l of opts.lists)
			pushGroup(
				`list:${l.id}`,
				l.name,
				l.color,
				roots.filter((t) => t.listId === l.id),
			);
		const known = new Set(opts.lists.map((l) => l.id));
		pushGroup(
			"list:other",
			"Other lists",
			null,
			roots.filter((t) => !known.has(t.listId)),
		);
	} else if (opts.rowsBy === "assignee") {
		for (const p of opts.people)
			pushGroup(
				`user:${p.userId}`,
				p.name,
				null,
				roots.filter((t) => t.assigneeIds?.includes(p.userId)),
			);
		pushGroup(
			"user:none",
			"Unassigned",
			null,
			roots.filter((t) => !t.assigneeIds?.length),
		);
	} else {
		for (const t of order(roots)) pushTask(t, 0, "");
	}
	return { rows, unscheduled };
}

export type Tick = { date: string; label: string; days: number };
export type TickUnit = "day" | "week" | "month" | "quarter" | "year";

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
const ym = (d: string) => [Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1];
const firstOfMonth = (y: number, m: number) =>
	`${y + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, "0")}-01`;

function unitStart(date: string, unit: TickUnit): string {
	const [y = 0, m = 0] = ym(date);
	switch (unit) {
		case "day":
			return date;
		case "week":
			return startOfWeek(date);
		case "month":
			return firstOfMonth(y, m);
		case "quarter":
			return firstOfMonth(y, m - (m % 3));
		case "year":
			return `${y}-01-01`;
	}
}
function nextUnit(date: string, unit: TickUnit): string {
	const [y = 0, m = 0] = ym(date);
	switch (unit) {
		case "day":
			return addDays(date, 1);
		case "week":
			return addDays(date, 7);
		case "month":
			return firstOfMonth(y, m + 1);
		case "quarter":
			return firstOfMonth(y, m + 3);
		case "year":
			return `${y + 1}-01-01`;
	}
}
function tickLabel(date: string, unit: TickUnit): string {
	const [y = 0, m = 0] = ym(date);
	switch (unit) {
		case "day":
			return String(Number(date.slice(8, 10)));
		case "week":
			return `${MONTHS[m]} ${Number(date.slice(8, 10))}`;
		case "month":
			return MONTHS[m] ?? "";
		case "quarter":
			return `Q${Math.floor(m / 3) + 1}`;
		case "year":
			return String(y);
	}
}

/** Ticks covering [from, to], each starting on its unit boundary (the first may start before `from`). */
export function ticks(from: string, to: string, unit: TickUnit): Tick[] {
	const out: Tick[] = [];
	for (let d = unitStart(from, unit); d <= to; ) {
		const n = nextUnit(d, unit);
		out.push({ date: d, label: tickLabel(d, unit), days: daysBetween(d, n) });
		d = n;
	}
	return out;
}

/** Header rows per zoom: the top band names the context, the bottom band the grid unit. */
export const HEADER_UNITS: Record<
	"day" | "week" | "month" | "quarter",
	{ top: TickUnit; bottom: TickUnit; topLabel: (d: string) => string }
> = {
	day: {
		top: "month",
		bottom: "day",
		topLabel: (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`,
	},
	week: {
		top: "month",
		bottom: "week",
		topLabel: (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`,
	},
	month: { top: "year", bottom: "month", topLabel: (d) => d.slice(0, 4) },
	quarter: { top: "year", bottom: "quarter", topLabel: (d) => d.slice(0, 4) },
};
