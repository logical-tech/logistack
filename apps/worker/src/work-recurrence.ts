import type { RecurrenceRule } from "@logistack/contracts";
import {
	addDays,
	consumeOccurrence,
	localDate,
	nextOccurrence,
	rankN,
} from "@logistack/core";
import {
	type Db,
	workActivity,
	workChecklistItem,
	workFieldValue,
	workNotification,
	workProject,
	workStatus,
	workTask,
	workTaskAssignee,
	workTaskTag,
	workTimeEntry,
} from "@logistack/db";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type TaskRow = typeof workTask.$inferSelect;
/** Publishes a Work realtime message (same shape and channel as apps/server/src/work/context.ts). */
export type PublishWork = (message: Record<string, unknown>) => void;

/** Same channel as `WORK_CHANNEL` in apps/server/src/work/context.ts. */
export const WORK_CHANNEL = "ls:work";

async function nextNumber(tx: Tx, projectId: string) {
	const [row] = await tx
		.update(workProject)
		.set({ nextNumber: sql`${workProject.nextNumber} + 1` })
		.where(eq(workProject.projectId, projectId))
		.returning({ n: sql<number>`${workProject.nextNumber} - 1` });
	if (!row) throw new Error(`work_project ${projectId} missing`);
	return Number(row.n);
}

async function lastPosition(tx: Tx, listId: string) {
	const [row] = await tx
		.select({ p: sql<string | null>`max(${workTask.position})` })
		.from(workTask)
		.where(eq(workTask.listId, listId));
	return row?.p ?? null;
}

/** One copy of `src` (a new number, unticked checklist, first active status); not recurring itself. */
async function copyTask(
	tx: Tx,
	src: TaskRow,
	over: Partial<typeof workTask.$inferInsert>,
	rule: RecurrenceRule,
	statusId: string,
) {
	const [row] = await tx
		.insert(workTask)
		.values({
			projectId: src.projectId,
			listId: src.listId,
			parentId: src.parentId,
			number: await nextNumber(tx, src.projectId),
			title: src.title,
			description: rule.copy.description ? src.description : null,
			descriptionText: rule.copy.description ? src.descriptionText : null,
			statusId,
			priority: src.priority,
			startDate: src.startDate,
			dueDate: src.dueDate,
			dueTime: src.dueTime,
			isMilestone: src.isMilestone,
			estimateMinutes: src.estimateMinutes,
			position: rankN(await lastPosition(tx, src.listId), null, 1)[0] as string,
			createdBy: src.createdBy,
			...over,
		})
		.onConflictDoNothing()
		.returning();
	if (!row) return null;
	const tags = await tx
		.select({ tagId: workTaskTag.tagId })
		.from(workTaskTag)
		.where(eq(workTaskTag.taskId, src.id));
	if (tags.length)
		await tx
			.insert(workTaskTag)
			.values(tags.map((t) => ({ taskId: row.id, tagId: t.tagId })));
	if (rule.copy.assignees) {
		const people = await tx
			.select({ userId: workTaskAssignee.userId })
			.from(workTaskAssignee)
			.where(eq(workTaskAssignee.taskId, src.id));
		if (people.length)
			await tx
				.insert(workTaskAssignee)
				.values(people.map((p) => ({ taskId: row.id, userId: p.userId })));
	}
	if (rule.copy.fields) {
		const values = await tx
			.select()
			.from(workFieldValue)
			.where(eq(workFieldValue.taskId, src.id));
		if (values.length)
			await tx.insert(workFieldValue).values(
				values.map((v) => ({
					taskId: row.id,
					fieldId: v.fieldId,
					value: v.value,
				})),
			);
	}
	if (rule.copy.checklist) {
		const items = await tx
			.select()
			.from(workChecklistItem)
			.where(eq(workChecklistItem.taskId, src.id))
			.orderBy(asc(workChecklistItem.position));
		if (items.length)
			await tx.insert(workChecklistItem).values(
				items.map((i) => ({
					taskId: row.id,
					text: i.text,
					assigneeId: i.assigneeId,
					position: i.position,
				})),
			);
	}
	return row;
}

/**
 * Creates the next occurrence of a recurring task inside `tx` and moves the rule onto it. Locks the
 * previous occurrence first, so a second caller (a concurrent completion, another worker) finds the
 * rule already moved and does nothing; the unique `(recurrence_series_id, due_date)` index is the
 * last guard. Returns the new task id, or null when nothing was created.
 */
export async function createNextOccurrence(
	tx: Tx,
	taskId: string,
	actorId: string | null = null,
): Promise<string | null> {
	const [prev] = await tx
		.select()
		.from(workTask)
		.where(eq(workTask.id, taskId))
		.for("update");
	const rule = prev?.recurrence;
	if (!prev || !rule || prev.archivedAt) return null;
	const dates = nextOccurrence(rule, prev);
	const seriesId = prev.recurrenceSeriesId ?? prev.id;
	// The rule lives on the latest occurrence only; an ended series just drops it.
	await tx
		.update(workTask)
		.set({ recurrence: null, recurrenceSeriesId: seriesId })
		.where(eq(workTask.id, prev.id));
	if (!dates) return null;
	const [active] = await tx
		.select({ id: workStatus.id })
		.from(workStatus)
		.where(
			and(
				eq(workStatus.projectId, prev.projectId),
				eq(workStatus.category, "active"),
			),
		)
		.orderBy(asc(workStatus.position))
		.limit(1);
	const next = await copyTask(
		tx,
		prev,
		{
			...dates,
			recurrence: consumeOccurrence(rule),
			recurrenceSeriesId: seriesId,
		},
		rule,
		active?.id ?? prev.statusId,
	);
	if (!next) return null;
	if (rule.copy.subtasks) {
		const subs = await tx
			.select()
			.from(workTask)
			.where(and(eq(workTask.parentId, prev.id), isNull(workTask.archivedAt)))
			.orderBy(asc(workTask.position));
		for (const s of subs)
			await copyTask(
				tx,
				s,
				{
					parentId: next.id,
					startDate: dates.startDate,
					dueDate: dates.dueDate,
					dueTime: null,
				},
				rule,
				active?.id ?? s.statusId,
			);
	}
	await tx.insert(workActivity).values({
		taskId: next.id,
		actorId,
		kind: "recurred",
		data: { previousId: prev.id, previousNumber: prev.number },
	});
	return next.id;
}

/** `on_schedule` series whose next occurrence is due for creation today (UTC) or earlier. */
export function dueForCreation(
	rule: RecurrenceRule,
	prev: { startDate: string | null; dueDate: string | null },
	today: string,
): boolean {
	if (rule.mode !== "on_schedule") return false;
	const next = nextOccurrence(rule, prev);
	const anchor = next?.dueDate ?? next?.startDate;
	return !!anchor && addDays(anchor, -(rule.createDaysBefore ?? 0)) <= today;
}

/** Hourly `work-recurrence` tick: creates due `on_schedule` occurrences. Idempotent across workers. */
export async function tickRecurrence(
	db: Db,
	publish?: PublishWork,
	now = new Date(),
): Promise<number> {
	const today = localDate(now, "UTC");
	const rows = await db
		.select({
			id: workTask.id,
			projectId: workTask.projectId,
			recurrence: workTask.recurrence,
			startDate: workTask.startDate,
			dueDate: workTask.dueDate,
			organizationId: workProject.organizationId,
		})
		.from(workTask)
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
		.where(
			and(
				isNotNull(workTask.recurrence),
				isNull(workTask.archivedAt),
				sql`${workTask.recurrence}->>'mode' = 'on_schedule'`,
			),
		);
	let created = 0;
	for (const r of rows) {
		if (!r.recurrence || !dueForCreation(r.recurrence, r, today)) continue;
		const id = await db.transaction((tx) => createNextOccurrence(tx, r.id));
		if (!id) continue;
		created++;
		publish?.({
			type: "work",
			organizationId: r.organizationId,
			projectId: r.projectId,
			entity: "task",
			op: "upsert",
			taskIds: [id],
			actorId: null,
		});
	}
	return created;
}

const LONG_TIMER_MS = 12 * 3_600_000;

/**
 * In-app "Still working on SHOP-42?" for timers running over 12 hours; never stops them (that would
 * silently lose time). Fires once per entry: the notification's `dueDate` carries the entry's start
 * date, so the unique `(user, task, kind, due_date)` index absorbs repeats.
 */
export async function notifyLongTimers(
	db: Db,
	publish?: PublishWork,
	now = new Date(),
): Promise<number> {
	const rows = await db
		.select({
			entryId: workTimeEntry.id,
			userId: workTimeEntry.userId,
			taskId: workTimeEntry.taskId,
			projectId: workTimeEntry.projectId,
			organizationId: workTimeEntry.organizationId,
			startedAt: workTimeEntry.startedAt,
			key: workProject.key,
			number: workTask.number,
			title: workTask.title,
		})
		.from(workTimeEntry)
		.innerJoin(workTask, eq(workTask.id, workTimeEntry.taskId))
		.innerJoin(workProject, eq(workProject.projectId, workTimeEntry.projectId))
		.where(
			and(
				isNull(workTimeEntry.endedAt),
				lt(workTimeEntry.startedAt, new Date(now.getTime() - LONG_TIMER_MS)),
			),
		);
	let sent = 0;
	for (const r of rows) {
		const [n] = await db
			.insert(workNotification)
			.values({
				userId: r.userId,
				organizationId: r.organizationId,
				taskId: r.taskId,
				kind: "timer_running_long",
				dueDate: localDate(r.startedAt, "UTC"),
				data: {
					entryId: r.entryId,
					taskKey: `${r.key}-${r.number}`,
					title: r.title,
					startedAt: r.startedAt.toISOString(),
				},
			})
			.onConflictDoNothing()
			.returning({ id: workNotification.id });
		if (!n) continue;
		sent++;
		publish?.({
			type: "work",
			organizationId: r.organizationId,
			projectId: r.projectId,
			entity: "notification",
			op: "upsert",
			taskIds: [r.taskId],
			userId: r.userId,
			actorId: null,
		});
	}
	return sent;
}

/** The hourly maintenance job. */
export async function workRecurrenceJob(db: Db, publish?: PublishWork) {
	await tickRecurrence(db, publish);
	await notifyLongTimers(db, publish);
}
