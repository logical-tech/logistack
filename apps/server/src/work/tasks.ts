import type {
	FilterNode,
	GroupKey,
	PmDoc,
	SortKey,
	WorkDependencyEdge,
	WorkSort,
	WorkTask,
	WorkTaskRef,
} from "@logistack/contracts";
import {
	addDays,
	docToText,
	localDate,
	needsRebalance,
	rankBetween,
	rebalance,
	sanitizeDoc,
	startOfWeek,
} from "@logistack/core";
import {
	workAttachment,
	workChecklistItem,
	workDependency,
	workGitLink,
	workList,
	workStatus,
	workTask,
	workTaskWatcher,
} from "@logistack/db";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	ne,
	type SQL,
	sql,
} from "drizzle-orm";
import { Failure } from "../errors.ts";
import {
	attachmentDto,
	checklistDto,
	enrich,
	recurrenceOf,
	type TaskRow,
	taskIncludes,
	taskRow,
	tasksFrom,
} from "./api.ts";
import type { DbOrTx } from "./context.ts";
import { compileFilter, type FilterContext } from "./filter-sql.ts";

/** Task reads and the placement rules shared by the task, me and search routes. */

const ALL = new Set(taskIncludes);

const ref = (t: TaskRow): WorkTaskRef => ({
	id: t.id,
	key: t.key,
	title: t.title,
	statusId: t.statusId,
	projectId: t.projectId,
});

/** The task sheet's payload. `opsReader`: the actor also holds `read`, so git links are shown in full. */
export async function fullTask(
	db: DbOrTx,
	id: string,
	actorUserId: string,
	opsReader: boolean,
): Promise<WorkTask> {
	const row = await taskRow(db, id);
	const [item] = await enrich(db, [row], ALL);
	const [
		watchers,
		parent,
		subtasks,
		checklist,
		blockedBy,
		blocking,
		attachments,
		links,
		categories,
	] = await Promise.all([
		db.select().from(workTaskWatcher).where(eq(workTaskWatcher.taskId, id)),
		row.parentId
			? tasksFrom(db).where(eq(workTask.id, row.parentId))
			: Promise.resolve([]),
		tasksFrom(db)
			.where(and(eq(workTask.parentId, id), isNull(workTask.archivedAt)))
			.orderBy(asc(workTask.position), asc(workTask.id)),
		db
			.select()
			.from(workChecklistItem)
			.where(eq(workChecklistItem.taskId, id))
			.orderBy(asc(workChecklistItem.position), asc(workChecklistItem.id)),
		db
			.select({
				other: workDependency.blockedById,
				lag: workDependency.lagDays,
			})
			.from(workDependency)
			.where(eq(workDependency.taskId, id)),
		db
			.select({ other: workDependency.taskId, lag: workDependency.lagDays })
			.from(workDependency)
			.where(eq(workDependency.blockedById, id)),
		db
			.select()
			.from(workAttachment)
			.where(
				and(
					eq(workAttachment.taskId, id),
					isNull(workAttachment.commentId),
					isNull(workAttachment.deletedAt),
				),
			)
			.orderBy(asc(workAttachment.createdAt)),
		db.select().from(workGitLink).where(eq(workGitLink.taskId, id)),
		db
			.select({ id: workStatus.id, category: workStatus.category })
			.from(workStatus)
			.where(eq(workStatus.projectId, row.projectId)),
	]);
	const otherIds = [...blockedBy, ...blocking].map((e) => e.other);
	const others = otherIds.length
		? await tasksFrom(db).where(inArray(workTask.id, otherIds))
		: [];
	const closed = new Set(
		categories
			.filter((s) => s.category === "done" || s.category === "cancelled")
			.map((s) => s.id),
	);
	const edge = (
		e: { other: string; lag: number },
		blocker: (o: TaskRow) => string,
	): WorkDependencyEdge[] => {
		const o = others.find((x) => x.id === e.other);
		return o
			? [{ ...ref(o), lagDays: e.lag, done: closed.has(blocker(o)) }]
			: [];
	};
	const subItems = await enrich(db, subtasks, new Set(["assignees"] as const));
	return {
		...(item as Required<NonNullable<typeof item>>),
		description: row.description ?? null,
		descriptionText: row.descriptionText,
		watchers: watchers.map((w) => ({
			userId: w.userId,
			reason: w.reason,
			muted: w.muted,
		})),
		watching: watchers.some((w) => w.userId === actorUserId && !w.muted),
		parent: parent[0] ? ref(parent[0]) : null,
		subtasks: subItems,
		checklist: checklist.map(checklistDto),
		dependencies: {
			blockedBy: blockedBy.flatMap((e) => edge(e, (o) => o.statusId)),
			blocking: blocking.flatMap((e) => edge(e, () => row.statusId)),
		},
		attachments: attachments.map(attachmentDto),
		recurrence: recurrenceOf(row.recurrence),
		recurrenceSeriesId: row.recurrenceSeriesId,
		source: row.source ?? null,
		git:
			links.length === 0
				? null
				: opsReader
					? {
							links: links.map((l) => ({
								id: l.id,
								taskId: l.taskId,
								providerId: l.providerId,
								repo: l.repo,
								kind: l.kind,
								ref: l.ref,
								title: l.title,
								url: l.url,
								state: l.state,
								author: l.author,
								createdAt: l.createdAt.toISOString(),
								updatedAt: l.updatedAt.toISOString(),
							})),
						}
					: {
							summary: {
								pullRequests: {
									open: links.filter(
										(l) => l.kind === "pull_request" && l.state === "open",
									).length,
									merged: links.filter(
										(l) => l.kind === "pull_request" && l.state === "merged",
									).length,
								},
								commits: links.filter((l) => l.kind === "commit").length,
							},
						},
	} as WorkTask;
}

/** Sanitised doc and its plain text, or nulls. */
export function richText(doc: PmDoc | null | undefined) {
	if (!doc) return { description: null, descriptionText: null };
	try {
		const clean = sanitizeDoc(doc);
		return { description: clean, descriptionText: docToText(clean) || null };
	} catch (e) {
		throw new Failure("bad_request", (e as Error).message);
	}
}

/**
 * A position in `listId` between `after` and `before` (task ids; either may be absent: the end),
 * for `self` (null when inserting). Locks the list row so concurrent placements serialise, skips
 * keys already taken, and rebalances the list when keys grow too long.
 */
export async function placeInList(
	tx: DbOrTx,
	listId: string,
	self: string | null,
	at: { before?: string; after?: string } = {},
): Promise<string> {
	await tx
		.select({ id: workList.id })
		.from(workList)
		.where(eq(workList.id, listId))
		.for("update");
	const others = and(
		eq(workTask.listId, listId),
		self ? ne(workTask.id, self) : undefined,
	);
	const posOf = async (id: string) => {
		const [r] = await tx
			.select({ p: workTask.position })
			.from(workTask)
			.where(and(eq(workTask.id, id), others));
		if (!r)
			throw new Failure(
				"bad_request",
				"before/after must be another task of the list",
			);
		return r.p;
	};
	const edge = async (where: SQL, dir: "asc" | "desc") =>
		(
			await tx
				.select({ p: workTask.position })
				.from(workTask)
				.where(and(others, where))
				.orderBy(
					dir === "asc" ? asc(workTask.position) : desc(workTask.position),
				)
				.limit(1)
		)[0]?.p ?? null;
	let lo: string | null;
	let hi: string | null;
	if (at.after) {
		lo = await posOf(at.after);
		hi = at.before
			? await posOf(at.before)
			: await edge(gt(workTask.position, lo), "asc");
	} else if (at.before) {
		hi = await posOf(at.before);
		lo = await edge(lt(workTask.position, hi), "desc");
	} else {
		lo = await edge(sql`true`, "desc");
		hi = null;
	}
	if (lo !== null && hi !== null && lo >= hi)
		return rebalanceList(tx, listId, self, lo);
	let k = rankBetween(lo, hi);
	for (;;) {
		const [taken] = await tx
			.select({ id: workTask.id })
			.from(workTask)
			.where(and(others, eq(workTask.position, k)))
			.limit(1);
		if (!taken) break;
		k = rankBetween(k, hi);
	}
	return needsRebalance(k) ? rebalanceList(tx, listId, self, lo) : k;
}

/** Spreads the list evenly; `self` goes right after the task at `afterPos` (null: first). */
async function rebalanceList(
	tx: DbOrTx,
	listId: string,
	self: string | null,
	afterPos: string | null,
): Promise<string> {
	const rows = await tx
		.select({ id: workTask.id, p: workTask.position })
		.from(workTask)
		.where(
			and(
				eq(workTask.listId, listId),
				self ? ne(workTask.id, self) : undefined,
			),
		)
		.orderBy(asc(workTask.position), asc(workTask.id));
	const at = afterPos === null ? 0 : rows.filter((r) => r.p <= afterPos).length;
	const order: (string | null)[] = rows.map((r) => r.id);
	order.splice(at, 0, self);
	const ranks = rebalance(order.length);
	let mine = ranks[at] as string;
	for (const [i, id] of order.entries()) {
		if (id === null) mine = ranks[i] as string;
		else
			await tx
				.update(workTask)
				.set({ position: ranks[i] as string })
				.where(eq(workTask.id, id));
	}
	return mine;
}

// --- list query -------------------------------------------------------------

const PRIORITY_ORDER = sql`case ${workTask.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 when 'low' then 3 else 4 end`;

function sortExpr(by: SortKey): SQL {
	if (by.startsWith("field:"))
		// shortcut: jsonb order (numbers numeric, strings lexical, select options by id); use compareFieldValues order if users ask.
		return sql`(select v.value from work_field_value v where v.task_id = ${workTask.id} and v.field_id = ${by.slice(6)})`;
	switch (by) {
		case "position":
			return sql`${workTask.position}`;
		case "number":
			return sql`${workTask.number}`;
		case "title":
			return sql`lower(${workTask.title})`;
		case "status":
			return sql`(select s.position from work_status s where s.id = ${workTask.statusId})`;
		case "priority":
			return PRIORITY_ORDER;
		case "startDate":
			return sql`${workTask.startDate}`;
		case "dueDate":
			return sql`${workTask.dueDate}`;
		case "createdAt":
			return sql`${workTask.createdAt}`;
		case "updatedAt":
			return sql`${workTask.updatedAt}`;
		case "completedAt":
			return sql`${workTask.completedAt}`;
		case "estimate":
			return sql`${workTask.estimateMinutes}`;
	}
	return sql`${workTask.position}`;
}

export const orderBy = (sort: WorkSort[]) => [
	...sort.map(
		(s) =>
			sql`${sortExpr(s.by)} ${sql.raw(s.dir === "desc" ? "desc" : "asc")} nulls last`,
	),
	asc(workTask.id),
];

/** One group of a board column as a filter (`"none"` is the empty group). */
export function groupFilter(
	by: GroupKey,
	group: string,
	now: Date,
	tz: string,
): FilterNode {
	const empty = group === "none";
	if (by !== "dueBucket")
		return empty
			? { key: by, op: "empty" }
			: { key: by, op: "is", value: group };
	const today = localDate(now, tz);
	const mon = startOfWeek(today);
	const max = (a: string, b: string) => (a > b ? a : b);
	const k = "dueDate" as const;
	switch (group) {
		case "overdue":
			return { key: k, op: "before", value: today };
		case "today":
			return { key: k, op: "on", value: today };
		case "tomorrow":
			return { key: k, op: "on", value: addDays(today, 1) };
		case "this_week":
			return {
				key: k,
				op: "between",
				value: [addDays(today, 2), addDays(mon, 6)],
			};
		case "next_week":
			return {
				key: k,
				op: "between",
				value: [max(addDays(today, 2), addDays(mon, 7)), addDays(mon, 13)],
			};
		case "later":
			return {
				key: k,
				op: "after",
				value: max(addDays(today, 1), addDays(mon, 13)),
			};
		default:
			return { key: k, op: "empty" };
	}
}

export const hasTextCondition = (n: FilterNode | null | undefined): boolean =>
	!!n &&
	("and" in n
		? n.and.some(hasTextCondition)
		: "or" in n
			? n.or.some(hasTextCondition)
			: n.key === "text");

export type TaskQuery = {
	projectIds: string[];
	listId?: string;
	parentId?: string;
	topLevel?: boolean;
	assigneeMe?: boolean;
	includeClosed: boolean;
	includeArchived: boolean;
	filters: FilterNode[];
	sort: WorkSort[];
	offset: number;
	limit: number;
	ctx: FilterContext;
};

/** Rows of `GET /tasks`, plus the total when it's cheap. */
export async function queryTasks(db: DbOrTx, q: TaskQuery) {
	if (q.projectIds.length === 0) return { rows: [], total: 0 };
	const where = and(
		inArray(workTask.projectId, q.projectIds),
		q.listId
			? eq(workTask.listId, q.listId)
			: sql`${workTask.listId} not in (select l.id from work_list l where l.archived_at is not null)`,
		q.includeArchived ? undefined : isNull(workTask.archivedAt),
		q.includeClosed
			? undefined
			: sql`${workTask.statusId} in (select s.id from work_status s where s.category in ('backlog', 'active'))`,
		q.parentId ? eq(workTask.parentId, q.parentId) : undefined,
		q.topLevel ? isNull(workTask.parentId) : undefined,
		q.assigneeMe
			? sql`exists (select 1 from work_task_assignee a where a.task_id = ${workTask.id} and a.user_id = ${q.ctx.me})`
			: undefined,
		...q.filters.map((f) => compileFilter(f, q.ctx)),
	);
	const [rows, total] = await Promise.all([
		tasksFrom(db)
			.where(where)
			.orderBy(...orderBy(q.sort))
			.limit(q.limit)
			.offset(q.offset),
		q.filters.some(hasTextCondition)
			? Promise.resolve(undefined)
			: db.$count(workTask, where),
	]);
	return { rows, total };
}
