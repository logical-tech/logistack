/* Table columns and their defaults: a view stores only what differs (order, width, hidden). */
import type {
	ColumnKey,
	GroupKey,
	SortKey,
	WorkField,
	WorkViewConfig,
} from "@logistack/contracts";

export const COLUMN_LABEL: Record<string, string> = {
	key: "ID",
	title: "Title",
	status: "Status",
	assignees: "Assignees",
	priority: "Priority",
	startDate: "Start",
	dueDate: "Due",
	tags: "Tags",
	list: "List",
	estimate: "Estimate",
	tracked: "Tracked",
	createdAt: "Created",
	updatedAt: "Updated",
};

/** Built-in columns in their default order; `true` = shown by default. */
const BUILTIN: [ColumnKey, boolean, number][] = [
	["key", true, 88],
	["title", true, 360],
	["status", true, 150],
	["assignees", true, 120],
	["priority", true, 110],
	["startDate", false, 110],
	["dueDate", true, 110],
	["tags", true, 180],
	["list", false, 150],
	["estimate", false, 100],
	["tracked", false, 100],
	["createdAt", false, 120],
	["updatedAt", false, 120],
];

export type Column = {
	key: ColumnKey;
	label: string;
	width: number;
	hidden: boolean;
	field?: WorkField;
};

export const columnLabel = (key: string, fields: WorkField[]) =>
	key.startsWith("field:")
		? (fields.find((f) => f.id === key.slice(6))?.name ?? "Field")
		: (COLUMN_LABEL[key] ?? key);

/**
 * Every column the view can show, in the view's order: saved columns first, then the ones it
 * doesn't mention (new fields appear hidden). Key and title can't be hidden.
 */
export function effectiveColumns(
	config: Pick<WorkViewConfig, "columns">,
	fields: WorkField[],
): Column[] {
	const all: Column[] = [
		...BUILTIN.map(([key, shown, width]) => ({
			key,
			label: COLUMN_LABEL[key] ?? key,
			width,
			hidden: !shown,
		})),
		...fields.map((f) => ({
			key: `field:${f.id}` as ColumnKey,
			label: f.name,
			width: f.kind === "long_text" ? 240 : 150,
			hidden: true,
			field: f,
		})),
	];
	const byKey = new Map(all.map((c) => [c.key, c]));
	const saved = config.columns.flatMap((s) => {
		const base = byKey.get(s.key);
		if (!base) return [];
		byKey.delete(s.key);
		return [
			{
				...base,
				width: s.width ?? base.width,
				hidden: s.hidden ?? base.hidden,
			},
		];
	});
	return [...saved, ...byKey.values()].map((c) =>
		c.key === "key" || c.key === "title" ? { ...c, hidden: false } : c,
	);
}

/** What a view stores for a column list. */
export const toConfigColumns = (cols: Column[]): WorkViewConfig["columns"] =>
	cols.map((c) => ({ key: c.key, width: c.width, hidden: c.hidden }));

export const SORT_LABEL: Record<string, string> = {
	position: "Manual",
	number: "ID",
	title: "Title",
	status: "Status",
	priority: "Priority",
	startDate: "Start date",
	dueDate: "Due date",
	createdAt: "Created",
	updatedAt: "Updated",
	completedAt: "Completed",
	estimate: "Estimate",
};

export const sortKeys = (
	fields: WorkField[],
): { key: SortKey; label: string }[] => [
	...Object.entries(SORT_LABEL).map(([key, label]) => ({
		key: key as SortKey,
		label,
	})),
	...fields
		.filter((f) => f.kind !== "long_text")
		.map((f) => ({ key: `field:${f.id}` as SortKey, label: f.name })),
];

export const GROUP_LABEL: Record<string, string> = {
	status: "Status",
	priority: "Priority",
	assignee: "Assignee",
	list: "List",
	tag: "Tag",
	dueBucket: "Due date",
};

export const groupKeys = (
	fields: WorkField[],
): { key: GroupKey; label: string }[] => [
	...Object.entries(GROUP_LABEL).map(([key, label]) => ({
		key: key as GroupKey,
		label,
	})),
	...fields
		.filter(
			(f) => f.kind === "select" || f.kind === "user" || f.kind === "checkbox",
		)
		.map((f) => ({ key: `field:${f.id}` as GroupKey, label: f.name })),
];
