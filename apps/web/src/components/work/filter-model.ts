/*
 * The filter builder's model: the UI edits two levels (a top-level and/or of conditions and
 * condition groups, section 7) and converts to and from `FilterNode`. Pure, tested on its own.
 */
import {
	FILTER_MAX_CONDITIONS,
	type FilterCondition,
	type FilterKey,
	type FilterNode,
	type FilterOp,
	type RelativeDate,
	type WorkField,
	type WorkFieldKind,
} from "@logistack/contracts";
import { BUILTIN_OPS, fieldFilterOps } from "@logistack/core/work";

export type Mode = "and" | "or";
export type UiGroup = { mode: Mode; conditions: FilterCondition[] };
export type UiFilter = { mode: Mode; items: (FilterCondition | UiGroup)[] };

export const isGroup = (x: FilterCondition | UiGroup): x is UiGroup =>
	"conditions" in x;

const isCondition = (n: FilterNode): n is FilterCondition => "key" in n;

export const emptyFilter = (): UiFilter => ({ mode: "and", items: [] });

/** Any node the API accepts; deeper nesting than two levels is flattened into groups. */
export function toUi(node: FilterNode | null | undefined): UiFilter {
	if (!node) return emptyFilter();
	if (isCondition(node)) return { mode: "and", items: [node] };
	const mode: Mode = "and" in node ? "and" : "or";
	const children = "and" in node ? node.and : node.or;
	return {
		mode,
		items: children.map((c) =>
			isCondition(c)
				? c
				: {
						mode: "and" in c ? ("and" as const) : ("or" as const),
						conditions: flatten(c),
					},
		),
	};
}

function flatten(n: FilterNode): FilterCondition[] {
	if (isCondition(n)) return [n];
	return ("and" in n ? n.and : n.or).flatMap(flatten);
}

/** Null for an empty filter; one condition stays bare; empty groups are dropped. */
export function toNode(ui: UiFilter): FilterNode | null {
	const items: FilterNode[] = ui.items.flatMap((i): FilterNode[] => {
		if (!isGroup(i)) return [i];
		if (!i.conditions.length) return [];
		if (i.conditions.length === 1) return [i.conditions[0] as FilterCondition];
		return [i.mode === "and" ? { and: i.conditions } : { or: i.conditions }];
	});
	if (!items.length) return null;
	if (items.length === 1) return items[0] as FilterNode;
	return ui.mode === "and" ? { and: items } : { or: items };
}

export const countConditions = (ui: UiFilter) =>
	ui.items.reduce((n, i) => n + (isGroup(i) ? i.conditions.length : 1), 0);

export const canAddCondition = (ui: UiFilter) =>
	countConditions(ui) < FILTER_MAX_CONDITIONS;

/** Combines two filters with AND (a view's saved filter and the search box). */
export function andNodes(
	...nodes: (FilterNode | null | undefined)[]
): FilterNode | null {
	const list = nodes.filter((n): n is FilterNode => !!n);
	if (!list.length) return null;
	return list.length === 1 ? (list[0] as FilterNode) : { and: list };
}

/** What kind of value editor a key needs. */
export type ValueKind =
	| "status"
	| "statusCategory"
	| "people"
	| "priority"
	| "list"
	| "tag"
	| "date"
	| "text"
	| "bool"
	| "number"
	| "options"
	| "none";

export type KeyDef = {
	key: FilterKey;
	label: string;
	value: ValueKind;
	ops: readonly FilterOp[];
	field?: WorkField;
};

const BUILTIN_LABELS: [FilterKey, string, ValueKind][] = [
	["status", "Status", "status"],
	["statusCategory", "Status group", "statusCategory"],
	["assignee", "Assignee", "people"],
	["priority", "Priority", "priority"],
	["list", "List", "list"],
	["tag", "Tags", "tag"],
	["dueDate", "Due date", "date"],
	["startDate", "Start date", "date"],
	["createdAt", "Created", "date"],
	["updatedAt", "Updated", "date"],
	["completedAt", "Completed", "date"],
	["createdBy", "Created by", "people"],
	["text", "Text", "text"],
	["isMilestone", "Milestone", "bool"],
	["blocked", "Blocked", "bool"],
];

const FIELD_VALUE: Record<WorkFieldKind, ValueKind> = {
	text: "text",
	long_text: "text",
	url: "text",
	email: "text",
	phone: "text",
	number: "number",
	currency: "number",
	percent: "number",
	rating: "number",
	date: "date",
	checkbox: "bool",
	select: "options",
	multi_select: "options",
	user: "people",
};

/** Every key the builder offers: built-ins, then the project's fields. */
export function keyDefs(fields: WorkField[]): KeyDef[] {
	return [
		...BUILTIN_LABELS.map(([key, label, value]) => ({
			key,
			label,
			value,
			ops: BUILTIN_OPS[key] ?? [],
		})),
		...fields.map((f) => ({
			key: `field:${f.id}` as FilterKey,
			label: f.name,
			value: FIELD_VALUE[f.kind],
			ops: fieldFilterOps(f.kind),
			field: f,
		})),
	];
}

export const OP_LABEL: Record<FilterOp, string> = {
	is: "is",
	is_not: "is not",
	any_of: "is any of",
	none_of: "is none of",
	all_of: "has all of",
	empty: "is empty",
	not_empty: "is not empty",
	contains: "contains",
	eq: "=",
	neq: "≠",
	lt: "<",
	lte: "≤",
	gt: ">",
	gte: "≥",
	between: "is between",
	before: "is before",
	after: "is after",
	on: "is on",
	relative: "is",
};

export const RELATIVE_LABEL: Record<RelativeDate, string> = {
	today: "Today",
	yesterday: "Yesterday",
	tomorrow: "Tomorrow",
	this_week: "This week",
	last_week: "Last week",
	next_week: "Next week",
	this_month: "This month",
	next_7_days: "Next 7 days",
	last_7_days: "Last 7 days",
	next_30_days: "Next 30 days",
	overdue: "Overdue",
	no_date: "No date",
};

/** Ops that take a list of ids. */
export const LIST_OPS = new Set<FilterOp>(["any_of", "none_of", "all_of"]);
export const NO_VALUE_OPS = new Set<FilterOp>(["empty", "not_empty"]);

/** A sensible starting condition for a key: its first op with an empty value. */
export function newCondition(def: KeyDef): FilterCondition {
	const preferred: FilterOp[] =
		def.value === "date"
			? ["relative"]
			: def.value === "bool"
				? ["is"]
				: def.value === "text"
					? ["contains"]
					: def.value === "number"
						? ["eq"]
						: ["any_of", "is"];
	const op = preferred.find((o) => def.ops.includes(o)) ?? def.ops[0] ?? "is";
	return { key: def.key, op, value: defaultValue(def, op) };
}

export function defaultValue(def: KeyDef, op: FilterOp): unknown {
	if (NO_VALUE_OPS.has(op)) return undefined;
	if (LIST_OPS.has(op)) return [];
	if (op === "relative") return "this_week";
	if (def.value === "bool") return true;
	if (op === "between") return def.value === "date" ? ["", ""] : [0, 0];
	return def.value === "number" ? 0 : "";
}

/** Keeps the value when it fits the new op (single ↔ list conversions included). */
export function changeOp(
	c: FilterCondition,
	def: KeyDef,
	op: FilterOp,
): FilterCondition {
	const was = c.value;
	if (LIST_OPS.has(op) && typeof was === "string" && was)
		return { ...c, op, value: [was] };
	if (LIST_OPS.has(op) && Array.isArray(was)) return { ...c, op, value: was };
	if ((op === "is" || op === "is_not") && Array.isArray(was) && was.length)
		return { ...c, op, value: was[0] };
	if ((op === "is" || op === "is_not") && typeof was === "string" && was)
		return { ...c, op, value: was };
	return { ...c, op, value: defaultValue(def, op) };
}

/** A condition with no usable value yet (an empty list, empty text) is left out of queries. */
export function isComplete(c: FilterCondition): boolean {
	if (NO_VALUE_OPS.has(c.op)) return true;
	const v = c.value;
	if (v === undefined || v === null || v === "") return false;
	if (Array.isArray(v)) return v.length > 0 && v.every((x) => x !== "");
	return true;
}

/** The filter without incomplete conditions, ready for the API. */
export function completeOnly(ui: UiFilter): UiFilter {
	return {
		mode: ui.mode,
		items: ui.items.flatMap((i): (FilterCondition | UiGroup)[] => {
			if (!isGroup(i)) return isComplete(i) ? [i] : [];
			const conditions = i.conditions.filter(isComplete);
			return conditions.length ? [{ ...i, conditions }] : [];
		}),
	};
}

/** Names for ids, used to describe a condition in a chip. */
export type Namer = (def: KeyDef, id: string) => string;

/** "Status is any of In progress, Review", "Due date is Overdue", "Assignee is empty". */
export function describeCondition(
	c: FilterCondition,
	def: KeyDef | undefined,
	name: Namer,
): string {
	const label = def?.label ?? c.key;
	if (NO_VALUE_OPS.has(c.op)) return `${label} ${OP_LABEL[c.op]}`;
	const v = c.value;
	let text: string;
	if (c.op === "relative")
		text = RELATIVE_LABEL[v as RelativeDate] ?? String(v);
	else if (Array.isArray(v))
		text =
			c.op === "between"
				? v.join(" – ")
				: def
					? v.map((id) => name(def, String(id))).join(", ")
					: v.join(", ");
	else if (typeof v === "boolean") text = v ? "yes" : "no";
	else if (
		def &&
		typeof v === "string" &&
		def.value !== "text" &&
		def.value !== "date"
	)
		text = name(def, v);
	else text = String(v ?? "");
	return `${label} ${OP_LABEL[c.op]} ${text}`;
}
