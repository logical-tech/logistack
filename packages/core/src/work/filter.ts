import {
	FILTER_MAX_CONDITIONS,
	FILTER_MAX_DEPTH,
	type FilterCondition,
	type FilterKey,
	type FilterNode,
	type FilterOp,
	RelativeDate,
	type WorkFieldKind,
} from "@logistack/contracts";
import { addDays, localDate, startOfWeek } from "./dates.ts";
import { fieldFilterOps } from "./fields.ts";

const DATE_OPS: FilterOp[] = [
	"before",
	"after",
	"on",
	"between",
	"relative",
	"empty",
	"not_empty",
];
const ID_OPS: FilterOp[] = ["is", "is_not", "any_of", "none_of"];

const BUILTIN_OPS: Record<string, FilterOp[]> = {
	status: ID_OPS,
	statusCategory: ID_OPS,
	priority: ID_OPS,
	list: ID_OPS,
	createdBy: ID_OPS,
	assignee: [...ID_OPS, "all_of", "empty", "not_empty"],
	tag: ["any_of", "all_of", "none_of", "empty", "not_empty"],
	startDate: DATE_OPS,
	dueDate: DATE_OPS,
	createdAt: DATE_OPS,
	updatedAt: DATE_OPS,
	completedAt: DATE_OPS,
	text: ["contains"],
	parent: ["is", "empty", "not_empty"],
	isMilestone: ["is"],
	blocked: ["is"],
};
const DATE_KEYS = new Set([
	"startDate",
	"dueDate",
	"createdAt",
	"updatedAt",
	"completedAt",
]);

const isCondition = (n: FilterNode): n is FilterCondition => "key" in n;
const children = (n: FilterNode): FilterNode[] =>
	"and" in n ? n.and : "or" in n ? n.or : [];

const isDate = (v: unknown) =>
	typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);

function valueError(
	op: FilterOp,
	value: unknown,
	date: boolean,
	kind?: WorkFieldKind,
): string | null {
	switch (op) {
		case "empty":
		case "not_empty":
			return null;
		case "any_of":
		case "none_of":
		case "all_of":
			return Array.isArray(value) && value.length > 0 && value.length <= 200
				? null
				: "a non-empty list";
		case "between":
			return Array.isArray(value) &&
				value.length === 2 &&
				value.every((v) => (date ? isDate(v) : typeof v === "number"))
				? null
				: date
					? "two dates"
					: "two numbers";
		case "relative":
			return RelativeDate.safeParse(value).success ? null : "a relative date";
		case "before":
		case "after":
		case "on":
			return isDate(value) ? null : "a date";
		case "contains":
			return typeof value === "string" &&
				value.length > 0 &&
				value.length <= 200
				? null
				: "some text";
		case "eq":
		case "neq":
		case "lt":
		case "lte":
		case "gt":
		case "gte":
			return typeof value === "number" ? null : "a number";
		case "is":
		case "is_not":
			if (kind === "checkbox")
				return typeof value === "boolean" ? null : "true or false";
			return value === undefined ? "a value" : null;
	}
}

export type FilterField = { id: string; kind: WorkFieldKind };

/** Check a filter against the project's fields: keys, ops, values, depth ≤ 4, ≤ 30 conditions. */
export function validateFilter(
	node: FilterNode,
	fields: readonly FilterField[],
): { ok: true } | { ok: false; error: string } {
	const byId = new Map(fields.map((f) => [f.id, f.kind]));
	let count = 0;
	const walk = (n: FilterNode, depth: number): string | null => {
		if (depth > FILTER_MAX_DEPTH)
			return `nested deeper than ${FILTER_MAX_DEPTH} levels`;
		if (!isCondition(n)) {
			for (const c of children(n)) {
				const e = walk(c, depth + 1);
				if (e) return e;
			}
			return null;
		}
		if (++count > FILTER_MAX_CONDITIONS)
			return `more than ${FILTER_MAX_CONDITIONS} conditions`;
		let ops: readonly FilterOp[] | undefined;
		let kind: WorkFieldKind | undefined;
		if (n.key.startsWith("field:")) {
			kind = byId.get(n.key.slice(6));
			if (!kind) return `unknown field ${n.key.slice(6)}`;
			ops = fieldFilterOps(kind);
		} else ops = BUILTIN_OPS[n.key];
		if (!ops) return `unknown filter key ${n.key}`;
		if (!ops.includes(n.op)) return `${n.key} doesn't support ${n.op}`;
		const date = DATE_KEYS.has(n.key) || kind === "date";
		const e = valueError(n.op, n.value, date, kind);
		if (n.key === "isMilestone" || n.key === "blocked")
			return typeof n.value === "boolean" ? null : `${n.key}: true or false`;
		return e ? `${n.key} ${n.op}: expected ${e}` : null;
	};
	const error = walk(node, 1);
	return error ? { ok: false, error } : { ok: true };
}

/** The concrete condition a relative date means, seen from `today`. */
function relativeCondition(
	key: FilterKey,
	rel: RelativeDate,
	today: string,
): FilterNode {
	const range = (a: string, b: string): FilterNode => ({
		key,
		op: "between",
		value: [a, b],
	});
	const mon = startOfWeek(today);
	switch (rel) {
		case "today":
			return { key, op: "on", value: today };
		case "yesterday":
			return { key, op: "on", value: addDays(today, -1) };
		case "tomorrow":
			return { key, op: "on", value: addDays(today, 1) };
		case "this_week":
			return range(mon, addDays(mon, 6));
		case "last_week":
			return range(addDays(mon, -7), addDays(mon, -1));
		case "next_week":
			return range(addDays(mon, 7), addDays(mon, 13));
		case "this_month": {
			const first = `${today.slice(0, 8)}01`;
			const next = addDays(first, 32);
			return range(first, addDays(`${next.slice(0, 8)}01`, -1));
		}
		case "next_7_days":
			return range(today, addDays(today, 7));
		case "last_7_days":
			return range(addDays(today, -7), today);
		case "next_30_days":
			return range(today, addDays(today, 30));
		case "overdue":
			return { key, op: "before", value: today };
		case "no_date":
			return { key, op: "empty" };
	}
}

/** Replace every `relative` condition with absolute dates in the viewer's time zone. */
export function resolveRelativeDates(
	node: FilterNode,
	now: Date,
	tz = "UTC",
): FilterNode {
	const today = localDate(now, tz);
	const walk = (n: FilterNode): FilterNode => {
		if ("and" in n) return { and: n.and.map(walk) };
		if ("or" in n) return { or: n.or.map(walk) };
		if (n.op !== "relative") return n;
		return relativeCondition(n.key, RelativeDate.parse(n.value), today);
	};
	return walk(node);
}

/** The task shape `matchesTask` reads; timestamps may be ISO strings or Dates. */
export type MatchableTask = {
	id: string;
	statusId: string;
	statusCategory: string;
	assigneeIds: readonly string[];
	priority: string;
	listId: string;
	tagIds: readonly string[];
	startDate: string | null;
	dueDate: string | null;
	createdAt: string | Date;
	updatedAt: string | Date;
	completedAt: string | Date | null;
	createdBy: string | null;
	title: string;
	descriptionText: string | null;
	parentId: string | null;
	isMilestone: boolean;
	blocked: boolean;
	fields: Readonly<Record<string, unknown>>;
};
export type MatchContext = { me: string; now: Date; tz?: string };

/** Whether `task` passes a validated filter; mirrors the server's SQL compilation. */
export function matchesTask(
	node: FilterNode,
	task: MatchableTask,
	ctx: MatchContext,
): boolean {
	const tz = ctx.tz ?? "UTC";
	const resolved = resolveRelativeDates(node, ctx.now, tz);
	const me = (v: unknown): unknown =>
		v === "me" ? ctx.me : Array.isArray(v) ? v.map(me) : v;
	const asDate = (v: string | Date | null): string | null =>
		v === null
			? null
			: typeof v === "string" && v.length === 10
				? v
				: localDate(v, tz);
	const actual = (key: FilterKey): unknown => {
		if (key.startsWith("field:")) return task.fields[key.slice(6)] ?? null;
		switch (key) {
			case "status":
				return task.statusId;
			case "statusCategory":
				return task.statusCategory;
			case "assignee":
				return task.assigneeIds;
			case "priority":
				return task.priority;
			case "list":
				return task.listId;
			case "tag":
				return task.tagIds;
			case "startDate":
				return task.startDate;
			case "dueDate":
				return task.dueDate;
			case "createdAt":
				return asDate(task.createdAt);
			case "updatedAt":
				return asDate(task.updatedAt);
			case "completedAt":
				return asDate(task.completedAt);
			case "createdBy":
				return task.createdBy;
			case "text":
				return `${task.title}\n${task.descriptionText ?? ""}`;
			case "parent":
				return task.parentId;
			case "isMilestone":
				return task.isMilestone;
			case "blocked":
				return task.blocked;
		}
		return null;
	};
	const test = (c: FilterCondition): boolean => {
		const a = actual(c.key);
		const v = me(c.value);
		const list =
			a === null || a === undefined ? [] : Array.isArray(a) ? a : [a];
		const vs = Array.isArray(v) ? v : [v];
		const dateish = typeof a === "string" && /^\d{4}-\d{2}-\d{2}/.test(a);
		const d = dateish ? (a as string).slice(0, 10) : null;
		switch (c.op) {
			case "empty":
				return list.length === 0 || a === false;
			case "not_empty":
				return !(list.length === 0 || a === false);
			case "is":
				if (typeof v === "boolean") return (a ?? false) === v;
				return list.includes(v);
			case "is_not":
				return !list.includes(v);
			case "any_of":
				return vs.some((x) => list.includes(x));
			case "none_of":
				return !vs.some((x) => list.includes(x));
			case "all_of":
				return vs.every((x) => list.includes(x));
			case "contains":
				return list.some((x) =>
					String(x).toLowerCase().includes(String(v).toLowerCase()),
				);
			case "on":
				return d === v;
			case "before":
				return d !== null && d < String(v);
			case "after":
				return d !== null && d > String(v);
			case "between": {
				const [lo, hi] = vs;
				if (d !== null) return d >= String(lo) && d <= String(hi);
				const n = Number(a);
				return a !== null && n >= Number(lo) && n <= Number(hi);
			}
			case "relative":
				return false; // resolved above
		}
		if (a === null || a === undefined) return false;
		const n = Number(a);
		const x = Number(v);
		switch (c.op) {
			case "eq":
				return n === x;
			case "neq":
				return n !== x;
			case "lt":
				return n < x;
			case "lte":
				return n <= x;
			case "gt":
				return n > x;
			case "gte":
				return n >= x;
		}
		return false;
	};
	const walk = (n: FilterNode): boolean =>
		"and" in n ? n.and.every(walk) : "or" in n ? n.or.some(walk) : test(n);
	return walk(resolved);
}
