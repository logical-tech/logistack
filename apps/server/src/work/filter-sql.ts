import type { FilterCondition, FilterNode } from "@logistack/contracts";
import { resolveRelativeDates } from "@logistack/core";
import { workTask } from "@logistack/db";
import { type SQL, sql } from "drizzle-orm";

/**
 * Compiles a validated `FilterNode` (core `validateFilter`) into a WHERE clause over `work_task`.
 * Semantics mirror core `matchesTask` exactly (a seeded test compares the two), so `text` is a
 * case-insensitive substring match like the client's; ranked full-text search lives in `/search`.
 */

export type FilterContext = { me: string; now: Date; tz?: string };

const FALSE = sql`false`;
const TRUE = sql`true`;
const or = (parts: SQL[]) =>
	parts.length ? sql`(${sql.join(parts, sql` or `)})` : FALSE;
const and = (parts: SQL[]) =>
	parts.length ? sql`(${sql.join(parts, sql` and `)})` : TRUE;
const not = (p: SQL) => sql`(not ${p})`;
/** NULL never leaks out of a leaf, so `not` stays a plain negation. */
const bool = (p: SQL) => sql`coalesce(${p}, false)`;

const isPrimitive = (v: unknown): v is string | number | boolean =>
	typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const values = (v: unknown) => (Array.isArray(v) ? v : [v]);
const text = (v: unknown) => sql`(${String(v)}::text collate "C")`;
/** `left(x, 10)` when `x` starts with a date; NULL otherwise. */
const datePart = (x: SQL) =>
	sql`((case when ${x} ~ '^\\d{4}-\\d{2}-\\d{2}' then left(${x}, 10) end) collate "C")`;
/** `x` as a number when it looks like one; NULL otherwise. */
const numberOf = (x: SQL) =>
	sql`(case when ${x} ~ '^-?\\d+(\\.\\d+)?$' then (${x})::numeric end)`;

const NUMERIC_OPS = {
	eq: "=",
	neq: "<>",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
};

/** Date and numeric comparisons shared by scalar and field values; `x` is the value as text. */
function compare(c: FilterCondition, x: SQL, v: unknown): SQL {
	const d = datePart(x);
	switch (c.op) {
		case "on":
			return bool(sql`${d} = ${text(v)}`);
		case "before":
			return bool(sql`${d} < ${text(v)}`);
		case "after":
			return bool(sql`${d} > ${text(v)}`);
		case "between": {
			const [lo, hi] = values(v);
			const [nlo, nhi] = [Number(lo), Number(hi)];
			// Comparing with NaN is false in JavaScript.
			const num =
				Number.isFinite(nlo) && Number.isFinite(nhi)
					? sql`${numberOf(x)} between ${nlo}::numeric and ${nhi}::numeric`
					: FALSE;
			return bool(
				sql`case when ${d} is not null then ${d} between ${text(lo)} and ${text(hi)} else ${num} end`,
			);
		}
		default: {
			const op = NUMERIC_OPS[c.op as keyof typeof NUMERIC_OPS];
			const n = Number(v);
			if (!op) return FALSE;
			// `x !== NaN` holds for every set value; every other comparison with NaN fails.
			if (!Number.isFinite(n))
				return c.op === "neq" ? sql`(${x} is not null)` : FALSE;
			return bool(sql`${numberOf(x)} ${sql.raw(op)} ${n}::numeric`);
		}
	}
}

/** A single-valued column (as text, NULL when unset). */
function scalar(c: FilterCondition, x: SQL, v: unknown): SQL {
	const is = (y: unknown) =>
		typeof y === "string" ? bool(sql`${x} = ${y}`) : FALSE;
	switch (c.op) {
		case "is":
			// `matchesTask` reads a boolean `is` as `(value ?? false) === v`.
			if (typeof v === "boolean") return v ? FALSE : sql`(${x} is null)`;
			return is(v);
		case "is_not":
			return not(is(v));
		case "any_of":
			return or(values(v).map(is));
		case "none_of":
			return not(or(values(v).map(is)));
		case "all_of":
			return and(values(v).map(is));
		case "empty":
			return sql`(${x} is null)`;
		case "not_empty":
			return sql`(${x} is not null)`;
		case "contains":
			return bool(sql`strpos(lower(${x}), lower(${String(v)})) > 0`);
		default:
			return compare(c, x, v);
	}
}

/** A set of ids (assignees, tags): `has(id)` tests membership. */
function set(
	c: FilterCondition,
	has: (id: string) => SQL,
	any: SQL,
	v: unknown,
) {
	const h = (y: unknown) => (typeof y === "string" ? has(y) : FALSE);
	switch (c.op) {
		case "is":
			return h(v);
		case "is_not":
			return not(h(v));
		case "any_of":
			return or(values(v).map(h));
		case "none_of":
			return not(or(values(v).map(h)));
		case "all_of":
			return and(values(v).map(h));
		case "empty":
			return not(any);
		case "not_empty":
			return any;
		default:
			return FALSE;
	}
}

/** A custom field's stored jsonb value: a scalar or an array, absent when empty. */
function field(c: FilterCondition, fieldId: string, v: unknown): SQL {
	const fv = sql`(select fv.value from work_field_value fv where fv.task_id = ${workTask.id} and fv.field_id = ${fieldId})`;
	const has = (y: unknown) => {
		if (!isPrimitive(y)) return FALSE;
		const j = sql`${JSON.stringify(y)}::jsonb`;
		return bool(
			sql`${fv} = ${j} or (jsonb_typeof(${fv}) = 'array' and ${fv} @> jsonb_build_array(${j}))`,
		);
	};
	const empty = sql`coalesce(${fv} is null or ${fv} = 'false'::jsonb or ${fv} = '[]'::jsonb, true)`;
	const scalarText = sql`(case when jsonb_typeof(${fv}) in ('string', 'number', 'boolean') then ${fv} #>> '{}' end)`;
	switch (c.op) {
		case "is":
			return typeof v === "boolean"
				? bool(
						sql`coalesce(${fv}, 'false'::jsonb) = ${JSON.stringify(v)}::jsonb`,
					)
				: has(v);
		case "is_not":
			return not(has(v));
		case "any_of":
			return or(values(v).map(has));
		case "none_of":
			return not(or(values(v).map(has)));
		case "all_of":
			return and(values(v).map(has));
		case "empty":
			return empty;
		case "not_empty":
			return not(empty);
		case "contains":
			return bool(
				sql`exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${fv}) = 'array' then ${fv} else jsonb_build_array(${fv}) end) e(x) where strpos(lower(e.x), lower(${String(v)})) > 0)`,
			);
		default:
			return compare(c, scalarText, v);
	}
}

function condition(c: FilterCondition, ctx: FilterContext): SQL {
	const me = (v: unknown): unknown =>
		v === "me" ? ctx.me : Array.isArray(v) ? v.map(me) : v;
	const v = me(c.value);
	const tz = ctx.tz ?? "UTC";
	const t = workTask;
	const day = (col: SQL) => sql`to_char(${col}, 'YYYY-MM-DD')`;
	const stamp = (col: SQL) =>
		sql`to_char(${col} at time zone ${tz}, 'YYYY-MM-DD')`;
	if (c.key.startsWith("field:")) return field(c, c.key.slice(6), v);
	switch (c.key) {
		case "status":
			return scalar(c, sql`${t.statusId}`, v);
		case "statusCategory":
			return scalar(
				c,
				sql`(select s.category::text from work_status s where s.id = ${t.statusId})`,
				v,
			);
		case "priority":
			return scalar(c, sql`${t.priority}::text`, v);
		case "list":
			return scalar(c, sql`${t.listId}`, v);
		case "createdBy":
			return scalar(c, sql`${t.createdBy}`, v);
		case "parent":
			return scalar(c, sql`${t.parentId}`, v);
		case "startDate":
			return scalar(c, day(sql`${t.startDate}`), v);
		case "dueDate":
			return scalar(c, day(sql`${t.dueDate}`), v);
		case "createdAt":
			return scalar(c, stamp(sql`${t.createdAt}`), v);
		case "updatedAt":
			return scalar(c, stamp(sql`${t.updatedAt}`), v);
		case "completedAt":
			return scalar(c, stamp(sql`${t.completedAt}`), v);
		case "text":
			return scalar(
				c,
				sql`(${t.title} || chr(10) || coalesce(${t.descriptionText}, ''))`,
				v,
			);
		case "isMilestone":
			return c.op === "is" && typeof v === "boolean"
				? sql`(${t.isMilestone} = ${v})`
				: FALSE;
		case "blocked":
			return c.op === "is" && typeof v === "boolean"
				? sql`(exists (select 1 from work_dependency d join work_task b on b.id = d.blocked_by_id join work_status s on s.id = b.status_id where d.task_id = ${t.id} and s.category not in ('done', 'cancelled')) = ${v})`
				: FALSE;
		case "assignee":
			return set(
				c,
				(id) =>
					sql`exists (select 1 from work_task_assignee a where a.task_id = ${t.id} and a.user_id = ${id})`,
				sql`exists (select 1 from work_task_assignee a where a.task_id = ${t.id})`,
				v,
			);
		case "tag":
			return set(
				c,
				(id) =>
					sql`exists (select 1 from work_task_tag g where g.task_id = ${t.id} and g.tag_id = ${id})`,
				sql`exists (select 1 from work_task_tag g where g.task_id = ${t.id})`,
				v,
			);
	}
	return FALSE;
}

/** WHERE clause for `node`; relative dates are resolved in `ctx.tz` first. */
export function compileFilter(node: FilterNode, ctx: FilterContext): SQL {
	const walk = (n: FilterNode): SQL =>
		"and" in n
			? and(n.and.map(walk))
			: "or" in n
				? or(n.or.map(walk))
				: condition(n, ctx);
	return walk(resolveRelativeDates(node, ctx.now, ctx.tz ?? "UTC"));
}
