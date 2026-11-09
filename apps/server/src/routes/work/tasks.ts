import { z } from "@hono/zod-openapi";
import {
	FilterNode,
	type WorkActivityKind,
	WorkChecklistCreate,
	WorkChecklistItem,
	WorkChecklistPatch,
	WorkDependencyCreate,
	type WorkFeedItem,
	WorkFeedPage,
	WorkShiftPreview,
	WorkShiftPreviewRequest,
	WorkSort,
	WorkTask,
	WorkTaskBulk,
	WorkTaskBulkResult,
	WorkTaskByKey,
	WorkTaskCreate,
	WorkTaskDuplicate,
	WorkTaskListQuery,
	WorkTaskMove,
	WorkTaskMoveProject,
	WorkTaskMoveProjectResult,
	WorkTaskPage,
	WorkTaskPatch,
	WorkViewConfig,
	workTaskIncludes,
} from "@logistack/contracts";
import {
	addWorkingDays,
	applyStatusChange,
	formatFieldValue,
	parseFieldValue,
	rankBetween,
	requiredFieldsMissing,
	shiftDependants,
	validateFilter,
	wouldCycle,
} from "@logistack/core";
import {
	user,
	workActivity,
	workAttachment,
	workBlob,
	workChecklistItem,
	workComment,
	workDependency,
	workField,
	workFieldValue,
	workKeyAlias,
	workList,
	workProject,
	workReaction,
	workStatus,
	workTag,
	workTask,
	workTaskAlias,
	workTaskAssignee,
	workTaskTag,
	workTaskWatcher,
	workTimeEntry,
	workView,
} from "@logistack/db";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../../actor.ts";
import type { Env } from "../../env.ts";
import { Failure, notFound } from "../../errors.ts";
import { body, IdParam, json, router } from "../../openapi.ts";
import { actorCan } from "../../scope.ts";
import {
	assertAssignable,
	attachmentDto,
	checklistDto,
	emitTaskEvent,
	enrich,
	guard,
	iso,
	memberGrants,
	readableProjects,
	rowOr404,
	type TaskInclude,
	type TaskRow,
	taskRow,
	tasksFrom,
	viewerTz,
	workMutation,
	workRoute,
} from "../../work/api.ts";
import { releaseBlobs, taskBlobs } from "../../work/blob-store.ts";
import {
	type DbOrTx,
	ensureWorkProject,
	nextTaskNumber,
	publishWork,
	writeActivity,
} from "../../work/context.ts";
import { guestCreateDefaults } from "../../work/guests.ts";
import { applyRecurrenceOnComplete } from "../../work/recurrence.ts";
import {
	fullTask,
	groupFilter,
	placeInList,
	queryTasks,
	richText,
} from "../../work/tasks.ts";
import { csvCell } from "../audit-log.ts";

const LIMITS = { subtasks: 200, checklist: 200, assignees: 20 };
const DELETE_WINDOW_MS = 15 * 60_000;
const NoContent = { 204: { description: "Done" } } as const;
const TaskParam = IdParam;
const TaskUserParam = z.object({ id: z.string(), userId: z.string() });

type Status = typeof workStatus.$inferSelect;
type Field = typeof workField.$inferSelect;

const pub = (
	c: Context<Env>,
	projectId: string,
	taskIds: string[],
	op: "upsert" | "delete" = "upsert",
	entity: "task" | "comment" = "task",
) => {
	const actor = requireActor(c);
	publishWork(c.var.deps, {
		organizationId: actor.organizationId,
		projectId,
		entity,
		op,
		taskIds,
		actorId: actor.userId,
	});
};

/** The task and the guard result for `action` on its project. */
async function taskFor(
	c: Context<Env>,
	id: string,
	action: Parameters<typeof guard>[1],
	write?: boolean,
) {
	const task = await taskRow(c.var.deps.db, id);
	const g = await guard(c, action, task.projectId, write);
	return { task, ...g };
}

async function respond<S extends 200 | 201 = 200>(
	c: Context<Env>,
	id: string,
	status: S = 200 as S,
) {
	const actor = requireActor(c);
	const task = await taskRow(c.var.deps.db, id);
	const { resource } = await guard(c, "read:work", task.projectId, false);
	return c.json(
		await fullTask(
			c.var.deps.db,
			id,
			actor.userId,
			actorCan(actor, "read", resource),
		),
		status,
	);
}

const statusesOf = (db: DbOrTx, projectId: string) =>
	db
		.select()
		.from(workStatus)
		.where(eq(workStatus.projectId, projectId))
		.orderBy(asc(workStatus.position));

const fieldsFor = (db: DbOrTx, projectId: string, listId: string) =>
	db
		.select()
		.from(workField)
		.where(
			and(
				eq(workField.projectId, projectId),
				or(isNull(workField.listId), eq(workField.listId, listId)),
			),
		);

async function valuesOf(db: DbOrTx, taskId: string) {
	const rows = await db
		.select({ f: workFieldValue.fieldId, v: workFieldValue.value })
		.from(workFieldValue)
		.where(eq(workFieldValue.taskId, taskId));
	return Object.fromEntries(rows.map((r) => [r.f, r.v]));
}

/** The status change's columns, refusing a move into `done` while required fields are empty. */
async function statusChange(
	db: DbOrTx,
	task: {
		id: string;
		projectId: string;
		listId: string;
		statusId: string;
		completedAt: Date | null;
	},
	statusId: string,
	statuses?: Status[],
) {
	const all = statuses ?? (await statusesOf(db, task.projectId));
	const to = all.find((s) => s.id === statusId);
	if (!to) throw new Failure("bad_request", "status not in this project");
	const from = all.find((s) => s.id === task.statusId) ?? to;
	if (to.category === "done" && from.category !== "done") {
		const missing = requiredFieldsMissing(
			{ listId: task.listId, fields: await valuesOf(db, task.id) },
			await fieldsFor(db, task.projectId, task.listId),
			to,
		);
		if (missing.length)
			throw new Failure(
				"bad_request",
				`required fields are empty: ${missing.map((f) => f.name).join(", ")}`,
				{ fieldIds: missing.map((f) => f.id) },
			);
	}
	return {
		from,
		to,
		completedAt: applyStatusChange(task, from, to, new Date()).completedAt,
	};
}

function checkDates(d: {
	startDate: string | null;
	dueDate: string | null;
	dueTime: string | null;
	isMilestone: boolean;
}) {
	if (d.isMilestone) {
		const day = d.dueDate ?? d.startDate;
		d.startDate = day;
		d.dueDate = day;
	}
	if (d.startDate && d.dueDate && d.startDate > d.dueDate)
		throw new Failure("bad_request", "the start date is after the due date");
	if (!d.dueDate) d.dueTime = null;
	return d;
}

/** Parses and stores one field value (null clears it). */
async function setFieldValue(
	tx: DbOrTx,
	task: { id: string },
	field: Field,
	raw: unknown,
	actorId: string,
) {
	const p = parseFieldValue(field, raw);
	if (!p.ok) throw new Failure("bad_request", `${field.name}: ${p.error}`);
	const [prev] = await tx
		.select({ v: workFieldValue.value })
		.from(workFieldValue)
		.where(
			and(
				eq(workFieldValue.taskId, task.id),
				eq(workFieldValue.fieldId, field.id),
			),
		);
	if (p.value === null)
		await tx
			.delete(workFieldValue)
			.where(
				and(
					eq(workFieldValue.taskId, task.id),
					eq(workFieldValue.fieldId, field.id),
				),
			);
	else
		await tx
			.insert(workFieldValue)
			.values({
				taskId: task.id,
				fieldId: field.id,
				value: p.value,
				updatedBy: actorId,
			})
			.onConflictDoUpdate({
				target: [workFieldValue.taskId, workFieldValue.fieldId],
				set: { value: p.value, updatedBy: actorId, updatedAt: new Date() },
			});
	await writeActivity(tx, {
		taskId: task.id,
		actorId,
		kind: "field",
		data: { field: field.id, before: prev?.v ?? null, after: p.value },
		collapse: true,
	});
}

async function addAssignees(
	tx: DbOrTx,
	taskId: string,
	userIds: readonly string[],
	actorId: string,
) {
	if (userIds.length === 0) return [];
	const added = await tx
		.insert(workTaskAssignee)
		.values(userIds.map((userId) => ({ taskId, userId, assignedBy: actorId })))
		.onConflictDoNothing()
		.returning({ userId: workTaskAssignee.userId });
	if (added.length === 0) return [];
	if (
		(await tx.$count(workTaskAssignee, eq(workTaskAssignee.taskId, taskId))) >
		LIMITS.assignees
	)
		throw new Failure("bad_request", `at most ${LIMITS.assignees} assignees`);
	await tx
		.insert(workTaskWatcher)
		.values(
			added.map((a) => ({
				taskId,
				userId: a.userId,
				reason: "assignee" as const,
			})),
		)
		.onConflictDoNothing();
	for (const a of added)
		await writeActivity(tx, {
			taskId,
			actorId,
			kind: "assignee_added",
			data: { userId: a.userId },
		});
	return added.map((a) => a.userId);
}

async function removeAssignees(
	tx: DbOrTx,
	taskId: string,
	userIds: readonly string[],
	actorId: string,
) {
	if (userIds.length === 0) return;
	const gone = await tx
		.delete(workTaskAssignee)
		.where(
			and(
				eq(workTaskAssignee.taskId, taskId),
				inArray(workTaskAssignee.userId, [...userIds]),
			),
		)
		.returning({ userId: workTaskAssignee.userId });
	for (const g of gone)
		await writeActivity(tx, {
			taskId,
			actorId,
			kind: "assignee_removed",
			data: { userId: g.userId },
		});
}

async function assertTags(
	db: DbOrTx,
	projectId: string,
	tagIds: readonly string[],
) {
	if (tagIds.length === 0) return;
	const found = await db
		.select({ id: workTag.id })
		.from(workTag)
		.where(
			and(eq(workTag.projectId, projectId), inArray(workTag.id, [...tagIds])),
		);
	if (found.length !== new Set(tagIds).size)
		throw new Failure("bad_request", "tags must belong to the project");
}

async function changeTags(
	tx: DbOrTx,
	taskId: string,
	add: readonly string[],
	remove: readonly string[],
	actorId: string,
) {
	const added = add.length
		? await tx
				.insert(workTaskTag)
				.values(add.map((tagId) => ({ taskId, tagId })))
				.onConflictDoNothing()
				.returning({ tagId: workTaskTag.tagId })
		: [];
	const removed = remove.length
		? await tx
				.delete(workTaskTag)
				.where(
					and(
						eq(workTaskTag.taskId, taskId),
						inArray(workTaskTag.tagId, [...remove]),
					),
				)
				.returning({ tagId: workTaskTag.tagId })
		: [];
	for (const [kind, rows] of [
		["tag_added", added],
		["tag_removed", removed],
	] as const)
		for (const r of rows)
			await writeActivity(tx, {
				taskId,
				actorId,
				kind,
				data: { tagId: r.tagId },
			});
}

/** Inserts a task with a fresh number at a position of its list; the creator watches it. */
async function insertTask(
	tx: DbOrTx,
	v: Omit<typeof workTask.$inferInsert, "number" | "position" | "id"> & {
		before?: string;
		after?: string;
		activity?: WorkActivityKind;
	},
) {
	const { before, after, activity, ...values } = v;
	const number = await nextTaskNumber(tx, values.projectId);
	const position = await placeInList(tx, values.listId, null, {
		before,
		after,
	});
	const [row] = await tx
		.insert(workTask)
		.values({ ...values, number, position })
		.returning({ id: workTask.id });
	const id = (row as { id: string }).id;
	if (values.createdBy)
		await tx
			.insert(workTaskWatcher)
			.values({ taskId: id, userId: values.createdBy, reason: "creator" })
			.onConflictDoNothing();
	await writeActivity(tx, {
		taskId: id,
		actorId: values.createdBy ?? null,
		kind: activity ?? "created",
	});
	return id;
}

/** `?cursor` encodes the offset. */
// shortcut: offset pagination, so a page can repeat or skip a row when tasks move between requests; switch to keyset on (sort keys, id) if that shows up.
const encodeCursor = (offset: number) =>
	Buffer.from(`o:${offset}`).toString("base64url");
const decodeCursor = (cursor?: string) => {
	if (!cursor) return 0;
	const m = /^o:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString());
	if (!m) throw new Failure("bad_request", "invalid cursor");
	return Number(m[1]);
};

const parseJson = <T>(
	raw: string | undefined,
	schema: z.ZodType<T>,
	what: string,
) => {
	if (raw === undefined) return undefined;
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		throw new Failure("bad_request", `${what} is not JSON`);
	}
	const r = schema.safeParse(v);
	if (!r.success)
		throw new Failure("validation_failed", `invalid ${what}`, r.error.issues);
	return r.data;
};

async function tasksCsv(db: DbOrTx, rows: TaskRow[], projectId?: string) {
	const items = await enrich(
		db,
		rows,
		new Set(["assignees", "tags", "fields"] as const),
	);
	const ids = <K extends "statusId" | "listId">(k: K) => [
		...new Set(rows.map((r) => r[k])),
	];
	const [statuses, lists, tags, fields] = await Promise.all([
		rows.length
			? db
					.select()
					.from(workStatus)
					.where(inArray(workStatus.id, ids("statusId")))
			: [],
		rows.length
			? db
					.select()
					.from(workList)
					.where(inArray(workList.id, ids("listId")))
			: [],
		rows.length
			? db
					.select()
					.from(workTag)
					.where(
						inArray(workTag.projectId, [
							...new Set(rows.map((r) => r.projectId)),
						]),
					)
			: [],
		projectId
			? db
					.select()
					.from(workField)
					.where(eq(workField.projectId, projectId))
					.orderBy(asc(workField.position))
			: [],
	]);
	const userIds = [...new Set(items.flatMap((i) => i.assigneeIds ?? []))];
	const users = userIds.length
		? await db
				.select({ id: user.id, name: user.name })
				.from(user)
				.where(inArray(user.id, userIds))
		: [];
	const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
	const name = <T extends { id: string; name: string }>(xs: T[], id: string) =>
		xs.find((x) => x.id === id)?.name ?? "";
	const header = [
		"Key",
		"Title",
		"Status",
		"List",
		"Priority",
		"Assignees",
		"Tags",
		"Start date",
		"Due date",
		"Estimate (min)",
		"Created",
		"Updated",
		...fields.map((f) => f.name),
	];
	const lines = items.map((t) =>
		[
			t.key,
			t.title,
			name(statuses, t.statusId),
			name(lists, t.listId),
			t.priority,
			(t.assigneeIds ?? []).map((u) => names[u] ?? u).join("; "),
			(t.tagIds ?? []).map((g) => name(tags, g)).join("; "),
			t.startDate,
			t.dueDate,
			t.estimateMinutes,
			t.createdAt,
			t.updatedAt,
			...fields.map((f) => formatFieldValue(f, t.fields?.[f.id], "en", names)),
		]
			.map(csvCell)
			.join(","),
	);
	return `${[header.map(csvCell).join(","), ...lines].join("\r\n")}\r\n`;
}

/** Comments of the feed with reactions and attachments. */
async function commentsOf(db: DbOrTx, taskId: string, before?: Date) {
	const rows = await db
		.select()
		.from(workComment)
		.where(
			and(
				eq(workComment.taskId, taskId),
				before ? lt(workComment.createdAt, before) : undefined,
			),
		)
		.orderBy(desc(workComment.createdAt))
		.limit(51);
	const ids = rows.map((r) => r.id);
	const [reactions, attachments] = ids.length
		? await Promise.all([
				db
					.select()
					.from(workReaction)
					.where(inArray(workReaction.commentId, ids)),
				db
					.select()
					.from(workAttachment)
					.where(
						and(
							inArray(workAttachment.commentId, ids),
							isNull(workAttachment.deletedAt),
						),
					),
			])
		: [[], []];
	return rows.map((m) => {
		const emojis = [
			...new Set(
				reactions.filter((r) => r.commentId === m.id).map((r) => r.emoji),
			),
		];
		return {
			at: m.createdAt,
			item: {
				type: "comment" as const,
				comment: {
					id: m.id,
					taskId: m.taskId,
					authorId: m.authorId,
					parentId: m.parentId,
					body: m.deletedAt ? null : (m.body ?? null),
					bodyText: m.deletedAt ? null : m.bodyText,
					editedAt: iso(m.editedAt),
					deletedAt: iso(m.deletedAt),
					resolvedAt: iso(m.resolvedAt),
					resolvedBy: m.resolvedBy,
					createdAt: m.createdAt.toISOString(),
					reactions: emojis.map((emoji) => ({
						emoji,
						userIds: reactions
							.filter((r) => r.commentId === m.id && r.emoji === emoji)
							.map((r) => r.userId),
					})),
					attachments: attachments
						.filter((a) => a.commentId === m.id)
						.map(attachmentDto),
				},
			} as WorkFeedItem,
		};
	});
}

const ListQuery = WorkTaskListQuery;

export const taskRoutes = router()
	.openapi(
		workRoute("taskList", {
			summary:
				"Tasks of a project (or assigned to me) with filters, sort and groups",
			request: { query: ListQuery },
			responses: {
				200: {
					description: "A page of tasks, or CSV with format=csv",
					content: {
						"application/json": { schema: WorkTaskPage },
						"text/csv": { schema: z.string() },
					},
				},
			},
		}),
		async (c) => {
			const q = c.req.valid("query");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			let projectIds: string[];
			let fields: { id: string; kind: Field["kind"] }[] = [];
			if (q.projectId) {
				await guard(c, "read:work", q.projectId);
				projectIds = [q.projectId];
				fields = await db
					.select({ id: workField.id, kind: workField.kind })
					.from(workField)
					.where(eq(workField.projectId, q.projectId));
			} else if (q.assignee === "me")
				projectIds = (await readableProjects(c)).map((p) => p.id);
			else
				throw new Failure(
					"bad_request",
					"projectId is required unless assignee=me",
				);
			const tz = await viewerTz(c);
			const now = new Date();
			const filters: FilterNode[] = [];
			let sort: WorkSort[] = [];
			let includeClosed = q.includeClosed === "true";
			let listId = q.listId;
			if (q.viewId) {
				const [v] = await db
					.select()
					.from(workView)
					.where(
						and(
							eq(workView.id, q.viewId),
							inArray(workView.projectId, projectIds),
							or(isNull(workView.ownerId), eq(workView.ownerId, actor.userId)),
						),
					);
				if (!v) throw notFound("view");
				const config = WorkViewConfig.parse(v.config ?? {});
				if (config.filter) filters.push(config.filter);
				sort = config.sort;
				includeClosed ||= config.showClosed;
				listId ??= v.listId ?? undefined;
			}
			const filter = parseJson(q.filter, FilterNode, "filter");
			if (filter) {
				const r = validateFilter(filter, fields);
				if (!r.ok)
					throw new Failure("bad_request", `invalid filter: ${r.error}`);
				filters.push(filter);
			}
			sort = parseJson(q.sort, z.array(WorkSort).max(3), "sort") ?? sort;
			if (sort.length === 0) sort = [{ by: "position", dir: "asc" }];
			if (q.groupBy && q.group !== undefined)
				filters.push(groupFilter(q.groupBy, q.group, now, tz));
			const csv = q.format === "csv";
			const limit = csv ? 10_000 : (q.limit ?? 50);
			const offset = csv ? 0 : decodeCursor(q.cursor);
			const { rows, total } = await queryTasks(db, {
				projectIds,
				listId,
				parentId: q.parentId,
				topLevel: q.topLevel === "true",
				assigneeMe: q.assignee === "me",
				includeClosed,
				includeArchived: q.includeArchived === "true",
				filters,
				sort,
				offset,
				limit,
				ctx: { me: actor.userId, now, tz },
			});
			if (csv) {
				c.header(
					"content-disposition",
					`attachment; filename="tasks-${now.toISOString().slice(0, 10)}.csv"`,
				);
				return c.text(await tasksCsv(db, rows, q.projectId), 200, {
					"content-type": "text/csv; charset=utf-8",
				});
			}
			const include = new Set(
				(q.include ?? "")
					.split(",")
					.filter((x): x is TaskInclude =>
						(workTaskIncludes as readonly string[]).includes(x),
					),
			);
			return c.json(
				{
					items: await enrich(db, rows, include),
					nextCursor:
						rows.length === limit ? encodeCursor(offset + limit) : null,
					...(total === undefined ? {} : { total }),
				},
				200,
			);
		},
	)
	.openapi(
		workRoute("taskByKey", {
			summary:
				"Resolve SHOP-42 (old keys and moved tasks included) to a task id",
			request: { params: z.object({ key: z.string() }) },
			responses: { 200: json(WorkTaskByKey, "The task") },
		}),
		async (c) => {
			const { key } = c.req.valid("param");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const m = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(key);
			if (!m) throw notFound("task");
			const k = (m[1] as string).toUpperCase();
			const number = Number(m[2]);
			const [p] = await db
				.select({ id: workProject.projectId })
				.from(workProject)
				.where(
					and(
						eq(workProject.organizationId, actor.organizationId),
						eq(workProject.key, k),
					),
				);
			const [alias] = p
				? []
				: await db
						.select({ id: workKeyAlias.projectId })
						.from(workKeyAlias)
						.where(
							and(
								eq(workKeyAlias.organizationId, actor.organizationId),
								eq(workKeyAlias.key, k),
							),
						);
			const projectId = p?.id ?? alias?.id;
			if (!projectId) throw notFound("task");
			const [t] = await db
				.select({ id: workTask.id })
				.from(workTask)
				.where(
					and(eq(workTask.projectId, projectId), eq(workTask.number, number)),
				);
			const [moved] = t
				? []
				: await db
						.select({ id: workTaskAlias.taskId })
						.from(workTaskAlias)
						.where(
							and(
								eq(workTaskAlias.projectId, projectId),
								eq(workTaskAlias.number, number),
							),
						);
			const taskId = t?.id ?? moved?.id;
			if (!taskId) throw notFound("task");
			const row = await taskRow(db, taskId);
			// A key the actor can't read is "not found", not a hint that it exists.
			await guard(c, "read:work", row.projectId).catch(() => {
				throw notFound("task");
			});
			return c.json({ taskId, projectId: row.projectId, key: row.key }, 200);
		},
	)
	.openapi(
		workMutation("taskCreate", {
			summary: "Create a task or subtask",
			request: body(WorkTaskCreate),
			responses: { 201: json(WorkTask, "Created") },
		}),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			let list = await rowOr404(
				db.select().from(workList).where(eq(workList.id, input.listId)),
				"list",
			);
			const { actor, resource } = await guard(
				c,
				"read:work",
				list.projectId,
				true,
			);
			// Guests (when the project lets them) land in the default list's backlog, tagged.
			const guest = await guestCreateDefaults(db, actor, resource);
			if (guest && guest.listId !== list.id)
				list = await rowOr404(
					db.select().from(workList).where(eq(workList.id, guest.listId)),
					"list",
				);
			if (list.archivedAt)
				throw new Failure("conflict", "the list is archived");
			await ensureWorkProject(db, list.projectId);
			if (input.parentId) {
				const parent = await rowOr404(
					db
						.select({ parentId: workTask.parentId })
						.from(workTask)
						.where(
							and(
								eq(workTask.id, input.parentId),
								eq(workTask.projectId, list.projectId),
							),
						),
					"parent task",
				);
				if (parent.parentId)
					throw new Failure("bad_request", "subtasks can't have subtasks");
				if (
					(await db.$count(workTask, eq(workTask.parentId, input.parentId))) >=
					LIMITS.subtasks
				)
					throw new Failure(
						"bad_request",
						`at most ${LIMITS.subtasks} subtasks`,
					);
			}
			const statuses = await statusesOf(db, list.projectId);
			const statusId = guest?.statusId ?? input.statusId;
			const status = statusId
				? statuses.find((s) => s.id === statusId)
				: statuses[0];
			if (!status)
				throw new Failure("bad_request", "status not in this project");
			const assignees = [...new Set(input.assignees ?? [])];
			await assertAssignable(db, resource, assignees);
			const tags = [
				...new Set([...(input.tags ?? []), ...(guest ? [guest.tagId] : [])]),
			];
			await assertTags(db, list.projectId, tags);
			const fields = await fieldsFor(db, list.projectId, list.id);
			const values: [Field, unknown][] = [];
			for (const [fieldId, raw] of Object.entries(input.fields ?? {})) {
				const f = fields.find((x) => x.id === fieldId);
				if (!f)
					throw new Failure(
						"bad_request",
						`field ${fieldId} doesn't apply to this list`,
					);
				const p = parseFieldValue(f, raw);
				if (!p.ok) throw new Failure("bad_request", `${f.name}: ${p.error}`);
				if (p.value !== null) values.push([f, p.value]);
			}
			const missing = requiredFieldsMissing(
				{
					listId: list.id,
					fields: Object.fromEntries(values.map(([f, v]) => [f.id, v])),
				},
				fields,
				null,
			);
			if (missing.length)
				throw new Failure(
					"bad_request",
					`required fields are empty: ${missing.map((f) => f.name).join(", ")}`,
				);
			const dates = checkDates({
				startDate: input.startDate ?? null,
				dueDate: input.dueDate ?? null,
				dueTime: input.dueTime ?? null,
				isMilestone: input.isMilestone ?? false,
			});
			const id = await db.transaction(async (tx) => {
				const id = await insertTask(tx, {
					projectId: list.projectId,
					listId: list.id,
					parentId: input.parentId ?? null,
					title: input.title,
					statusId: status.id,
					completedAt: status.category === "done" ? new Date() : null,
					priority: input.priority ?? "none",
					...dates,
					estimateMinutes: input.estimateMinutes ?? null,
					...richText(input.description),
					createdBy: actor.userId,
					before: input.before,
					after: input.after,
				});
				await addAssignees(tx, id, assignees, actor.userId);
				await changeTags(tx, id, tags, [], actor.userId);
				if (values.length)
					await tx.insert(workFieldValue).values(
						values.map(([f, value]) => ({
							taskId: id,
							fieldId: f.id,
							value,
							updatedBy: actor.userId,
						})),
					);
				return id;
			});
			const row = await taskRow(db, id);
			await emitTaskEvent(c, "task.created", row, { statusName: status.name });
			if (assignees.length)
				await emitTaskEvent(c, "task.assigned", row, {
					assigneeIds: assignees,
				});
			pub(c, row.projectId, [id]);
			return respond(c, id, 201);
		},
	)
	.openapi(
		workRoute("taskGet", {
			summary: "A task with everything the task sheet shows",
			request: { params: TaskParam },
			responses: { 200: json(WorkTask, "The task") },
		}),
		async (c) => respond(c, c.req.valid("param").id),
	)
	.openapi(
		workMutation("taskUpdate", {
			summary:
				"Edit a task; a stale expectedUpdatedAt gets 409 with the current task",
			request: { params: TaskParam, ...body(WorkTaskPatch) },
			responses: { 200: json(WorkTask, "Updated") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { task, actor, resource } = await taskFor(c, id, "work");
			const header = c.req.header("if-unmodified-since");
			const changed = await db.transaction(async (tx) => {
				const [cur] = await tx
					.select()
					.from(workTask)
					.where(eq(workTask.id, id))
					.for("update");
				if (!cur) throw notFound("task");
				const at = cur.updatedAt.getTime();
				const stale =
					(input.expectedUpdatedAt !== undefined &&
						Date.parse(input.expectedUpdatedAt) !== at) ||
					(header !== undefined &&
						Math.floor(Date.parse(header) / 1000) !== Math.floor(at / 1000));
				if (stale) return null;
				const set: Partial<typeof workTask.$inferInsert> = {};
				const log: Parameters<typeof writeActivity>[1][] = [];
				const edit = (field: string, before: unknown, after: unknown) =>
					log.push({
						taskId: id,
						actorId: actor.userId,
						kind: "edited",
						data: { field, before, after },
						collapse: true,
					});
				let status: Awaited<ReturnType<typeof statusChange>> | undefined;
				if (input.title !== undefined && input.title !== cur.title) {
					set.title = input.title;
					edit("title", cur.title, input.title);
				}
				if (input.description !== undefined) {
					Object.assign(set, richText(input.description));
					edit("description", null, null);
				}
				if (input.statusId !== undefined && input.statusId !== cur.statusId) {
					status = await statusChange(tx, cur, input.statusId);
					set.statusId = input.statusId;
					set.completedAt = status.completedAt;
					log.push({
						taskId: id,
						actorId: actor.userId,
						kind: "status",
						data: { from: cur.statusId, to: input.statusId },
					});
				}
				if (input.priority !== undefined && input.priority !== cur.priority) {
					set.priority = input.priority;
					log.push({
						taskId: id,
						actorId: actor.userId,
						kind: "priority",
						data: { before: cur.priority, after: input.priority },
						collapse: true,
					});
				}
				if (
					input.estimateMinutes !== undefined &&
					input.estimateMinutes !== cur.estimateMinutes
				) {
					set.estimateMinutes = input.estimateMinutes;
					edit("estimate", cur.estimateMinutes, input.estimateMinutes);
				}
				if (input.recurrence !== undefined) {
					set.recurrence = input.recurrence;
					if (input.recurrence && !cur.recurrenceSeriesId)
						set.recurrenceSeriesId = cur.id;
					edit("recurrence", null, null);
				}
				const before = {
					startDate: cur.startDate,
					dueDate: cur.dueDate,
					dueTime: cur.dueTime?.slice(0, 5) ?? null,
					isMilestone: cur.isMilestone,
				};
				if (
					["startDate", "dueDate", "dueTime", "isMilestone"].some(
						(k) => k in input,
					)
				) {
					const after = checkDates({
						startDate:
							input.startDate !== undefined
								? input.startDate
								: before.startDate,
						dueDate:
							input.dueDate !== undefined ? input.dueDate : before.dueDate,
						dueTime:
							input.dueTime !== undefined ? input.dueTime : before.dueTime,
						isMilestone: input.isMilestone ?? before.isMilestone,
					});
					if (JSON.stringify(after) !== JSON.stringify(before)) {
						Object.assign(set, after);
						log.push({
							taskId: id,
							actorId: actor.userId,
							kind: "dates",
							data: { before, after },
							collapse: true,
						});
					}
				}
				if (Object.keys(set).length)
					await tx.update(workTask).set(set).where(eq(workTask.id, id));
				for (const entry of log) await writeActivity(tx, entry);
				const next = status
					? await applyRecurrenceOnComplete(
							tx,
							{
								id,
								recurrence:
									set.recurrence !== undefined
										? (set.recurrence ?? null)
										: cur.recurrence,
							},
							status.from,
							status.to,
							actor.userId,
						)
					: null;
				return { status, next };
			});
			if (changed === null) {
				const current = await fullTask(
					db,
					id,
					actor.userId,
					actorCan(actor, "read", resource),
				);
				throw new Failure(
					"conflict",
					"the task changed since you loaded it",
					current,
				);
			}
			if (changed.status) {
				await emitTaskEvent(c, "task.status_changed", task, {
					statusName: changed.status.to.name,
				});
				if (
					changed.status.to.category === "done" &&
					changed.status.from.category !== "done"
				)
					await emitTaskEvent(c, "task.completed", task, {
						statusName: changed.status.to.name,
					});
			}
			pub(c, task.projectId, changed.next ? [id, changed.next] : [id]);
			return respond(c, id);
		},
	)
	.openapi(
		workMutation("taskMove", {
			summary: "Move a task: list, status, parent and position in one call",
			request: { params: TaskParam, ...body(WorkTaskMove) },
			responses: { 200: json(WorkTask, "Moved") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { task, actor } = await taskFor(c, id, "work");
			const listId = input.listId ?? task.listId;
			if (listId !== task.listId) {
				const l = await rowOr404(
					db
						.select()
						.from(workList)
						.where(
							and(
								eq(workList.id, listId),
								eq(workList.projectId, task.projectId),
							),
						),
					"list",
				);
				if (l.archivedAt) throw new Failure("conflict", "the list is archived");
			}
			if (input.parentId) {
				if (input.parentId === id)
					throw new Failure("bad_request", "a task can't be its own parent");
				const p = await rowOr404(
					db
						.select({ parentId: workTask.parentId })
						.from(workTask)
						.where(
							and(
								eq(workTask.id, input.parentId),
								eq(workTask.projectId, task.projectId),
							),
						),
					"parent task",
				);
				if (p.parentId)
					throw new Failure("bad_request", "subtasks can't have subtasks");
				if (await db.$count(workTask, eq(workTask.parentId, id)))
					throw new Failure(
						"bad_request",
						"a task with subtasks can't become a subtask",
					);
			}
			const { status, next } = await db.transaction(async (tx) => {
				const set: Partial<typeof workTask.$inferInsert> = {};
				let status: Awaited<ReturnType<typeof statusChange>> | undefined;
				if (input.statusId && input.statusId !== task.statusId) {
					status = await statusChange(tx, task, input.statusId);
					Object.assign(set, {
						statusId: input.statusId,
						completedAt: status.completedAt,
					});
					await writeActivity(tx, {
						taskId: id,
						actorId: actor.userId,
						kind: "status",
						data: { from: task.statusId, to: input.statusId },
					});
				}
				if (input.parentId !== undefined) set.parentId = input.parentId;
				if (listId !== task.listId || input.before || input.after) {
					set.listId = listId;
					set.position = await placeInList(tx, listId, id, input);
				}
				if (listId !== task.listId) {
					await writeActivity(tx, {
						taskId: id,
						actorId: actor.userId,
						kind: "list_moved",
						data: { from: task.listId, to: listId },
					});
					const subs = await tx
						.select({ id: workTask.id })
						.from(workTask)
						.where(eq(workTask.parentId, id))
						.orderBy(asc(workTask.position));
					for (const s of subs)
						await tx
							.update(workTask)
							.set({ listId, position: await placeInList(tx, listId, s.id) })
							.where(eq(workTask.id, s.id));
				}
				if (Object.keys(set).length)
					await tx.update(workTask).set(set).where(eq(workTask.id, id));
				const next = status
					? await applyRecurrenceOnComplete(
							tx,
							task,
							status.from,
							status.to,
							actor.userId,
						)
					: null;
				return { status, next };
			});
			if (status) {
				await emitTaskEvent(c, "task.status_changed", task, {
					statusName: status.to.name,
				});
				if (status.to.category === "done" && status.from.category !== "done")
					await emitTaskEvent(c, "task.completed", task, {
						statusName: status.to.name,
					});
			}
			pub(c, task.projectId, next ? [id, next] : [id]);
			return respond(c, id);
		},
	)
	.openapi(
		workMutation("taskMoveProject", {
			summary:
				"Move a task (and its subtasks) to another project; ?dryRun=true reports what is dropped",
			request: {
				params: TaskParam,
				query: z.object({ dryRun: z.enum(["true", "false"]).optional() }),
				...body(WorkTaskMoveProject),
			},
			responses: {
				200: json(WorkTaskMoveProjectResult, "Moved, or the dry run"),
			},
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const dryRun = c.req.valid("query").dryRun === "true";
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { task, actor } = await taskFor(c, id, "work");
			const { resource: target } = await guard(c, "work", input.projectId);
			if (input.projectId === task.projectId)
				throw new Failure("bad_request", "the task is already in this project");
			const wp = await ensureWorkProject(db, input.projectId);
			const list = await rowOr404(
				db
					.select()
					.from(workList)
					.where(
						and(
							eq(workList.id, input.listId),
							eq(workList.projectId, input.projectId),
						),
					),
				"list",
			);
			if (list.archivedAt)
				throw new Failure("conflict", "the list is archived");
			const [srcStatuses, dstStatuses, srcFields, dstFields] =
				await Promise.all([
					statusesOf(db, task.projectId),
					statusesOf(db, input.projectId),
					db
						.select()
						.from(workField)
						.where(eq(workField.projectId, task.projectId)),
					fieldsFor(db, input.projectId, list.id),
				]);
			const mapStatus = (sid: string) => {
				const mapped = input.statusMap?.[sid];
				const s = srcStatuses.find((x) => x.id === sid);
				return (
					dstStatuses.find((x) => x.id === mapped) ??
					dstStatuses.find(
						(x) => x.name.toLowerCase() === s?.name.toLowerCase(),
					) ??
					dstStatuses.find((x) => x.category === s?.category) ??
					(dstStatuses[0] as Status)
				);
			};
			const moving = [
				task,
				...(await tasksFrom(db)
					.where(eq(workTask.parentId, id))
					.orderBy(asc(workTask.position))),
			];
			const ids = moving.map((t) => t.id);
			const values = await db
				.select()
				.from(workFieldValue)
				.where(inArray(workFieldValue.taskId, ids));
			const dropped: { fieldId: string; name: string; reason: string }[] = [];
			const carried: { taskId: string; fieldId: string; value: unknown }[] = [];
			for (const v of values) {
				const src = srcFields.find((f) => f.id === v.fieldId);
				if (!src) continue;
				const dst =
					dstFields.find((f) => f.id === input.fieldMap?.[src.id]) ??
					dstFields.find(
						(f) =>
							f.kind === src.kind &&
							f.name.toLowerCase() === src.name.toLowerCase(),
					);
				const p = dst ? parseFieldValue(dst, v.value) : null;
				if (!dst || !p?.ok || p.value === null) {
					if (!dropped.some((d) => d.fieldId === src.id))
						dropped.push({
							fieldId: src.id,
							name: src.name,
							reason: dst
								? "value doesn't fit the target field"
								: "no matching field in the target project",
						});
					continue;
				}
				carried.push({ taskId: v.taskId, fieldId: dst.id, value: p.value });
			}
			if (dryRun)
				return c.json(
					{
						taskId: id,
						number: task.number,
						key: task.key,
						dropped,
						dryRun: true,
					},
					200,
				);
			const assignees = await db
				.select()
				.from(workTaskAssignee)
				.where(inArray(workTaskAssignee.taskId, ids));
			const keep = new Set<string>();
			for (const u of new Set(assignees.map((a) => a.userId)))
				await assertAssignable(db, target, [u]).then(
					() => keep.add(u),
					() => {},
				);
			const srcTags = await db
				.select({ taskId: workTaskTag.taskId, name: workTag.name })
				.from(workTaskTag)
				.innerJoin(workTag, eq(workTag.id, workTaskTag.tagId))
				.where(inArray(workTaskTag.taskId, ids));
			const dstTags = await db
				.select()
				.from(workTag)
				.where(eq(workTag.projectId, input.projectId));
			const number = await db.transaction(async (tx) => {
				let first = 0;
				for (const t of moving) {
					const n = await nextTaskNumber(tx, input.projectId);
					if (t.id === id) first = n;
					await tx
						.insert(workTaskAlias)
						.values({ projectId: t.projectId, number: t.number, taskId: t.id })
						.onConflictDoNothing();
					const s = mapStatus(t.statusId);
					const from = srcStatuses.find((x) => x.id === t.statusId) ?? s;
					await tx
						.update(workTask)
						.set({
							projectId: input.projectId,
							listId: list.id,
							parentId: t.id === id ? null : t.parentId,
							number: n,
							statusId: s.id,
							completedAt: applyStatusChange(t, from, s, new Date())
								.completedAt,
							position: await placeInList(tx, list.id, t.id),
						})
						.where(eq(workTask.id, t.id));
				}
				await tx
					.delete(workFieldValue)
					.where(inArray(workFieldValue.taskId, ids));
				if (carried.length)
					await tx
						.insert(workFieldValue)
						.values(carried.map((v) => ({ ...v, updatedBy: actor.userId })));
				await tx.delete(workTaskTag).where(inArray(workTaskTag.taskId, ids));
				const tagRows = srcTags.flatMap((t) => {
					const d = dstTags.find(
						(x) => x.name.toLowerCase() === t.name.toLowerCase(),
					);
					return d ? [{ taskId: t.taskId, tagId: d.id }] : [];
				});
				if (tagRows.length)
					await tx.insert(workTaskTag).values(tagRows).onConflictDoNothing();
				const gone = assignees
					.filter((a) => !keep.has(a.userId))
					.map((a) => a.userId);
				if (gone.length)
					await tx
						.delete(workTaskAssignee)
						.where(
							and(
								inArray(workTaskAssignee.taskId, ids),
								inArray(workTaskAssignee.userId, gone),
							),
						);
				// Dependencies never cross projects.
				await tx.delete(workDependency).where(
					or(
						and(
							inArray(workDependency.taskId, ids),
							sql`${workDependency.blockedById} not in (${sql.join(
								ids.map((x) => sql`${x}`),
								sql`, `,
							)})`,
						),
						and(
							inArray(workDependency.blockedById, ids),
							sql`${workDependency.taskId} not in (${sql.join(
								ids.map((x) => sql`${x}`),
								sql`, `,
							)})`,
						),
					),
				);
				await tx
					.update(workAttachment)
					.set({ projectId: input.projectId })
					.where(inArray(workAttachment.taskId, ids));
				await tx
					.update(workTimeEntry)
					.set({ projectId: input.projectId })
					.where(inArray(workTimeEntry.taskId, ids));
				await writeActivity(tx, {
					taskId: id,
					actorId: actor.userId,
					kind: "project_moved",
					data: {
						from: task.projectId,
						to: input.projectId,
						fromKey: task.key,
					},
				});
				return first;
			});
			pub(c, task.projectId, ids, "delete");
			pub(c, input.projectId, ids);
			return c.json(
				{
					taskId: id,
					number,
					key: `${wp.key}-${number}`,
					dropped,
					dryRun: false,
				},
				200,
			);
		},
	)
	.openapi(
		workMutation("taskDuplicate", {
			summary: "Duplicate a task with chosen parts",
			request: { params: TaskParam, ...body(WorkTaskDuplicate) },
			responses: { 201: json(WorkTask, "The copy") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { task, actor } = await taskFor(c, id, "work");
			const [src] = await db.select().from(workTask).where(eq(workTask.id, id));
			if (!src) throw notFound("task");
			const subs =
				input.subtasks && !src.parentId
					? await db
							.select()
							.from(workTask)
							.where(
								and(eq(workTask.parentId, id), isNull(workTask.archivedAt)),
							)
							.orderBy(asc(workTask.position))
					: [];
			const copyId = await db.transaction(async (tx) => {
				const copy = async (
					from: typeof src,
					parentId: string | null,
					title: string,
					after?: string,
				) => {
					const nid = await insertTask(tx, {
						projectId: from.projectId,
						listId: from.listId,
						parentId,
						title,
						statusId: from.statusId,
						completedAt: from.completedAt,
						priority: from.priority,
						startDate: from.startDate,
						dueDate: from.dueDate,
						dueTime: from.dueTime,
						isMilestone: from.isMilestone,
						estimateMinutes: from.estimateMinutes,
						description: from.description,
						descriptionText: from.descriptionText,
						createdBy: actor.userId,
						after,
					});
					if (input.checklist) {
						const items = await tx
							.select()
							.from(workChecklistItem)
							.where(eq(workChecklistItem.taskId, from.id));
						if (items.length)
							await tx.insert(workChecklistItem).values(
								items.map((i) => ({
									taskId: nid,
									text: i.text,
									assigneeId: i.assigneeId,
									position: i.position,
								})),
							);
					}
					if (input.fields) {
						const vs = await tx
							.select()
							.from(workFieldValue)
							.where(eq(workFieldValue.taskId, from.id));
						if (vs.length)
							await tx.insert(workFieldValue).values(
								vs.map((v) => ({
									taskId: nid,
									fieldId: v.fieldId,
									value: v.value,
									updatedBy: actor.userId,
								})),
							);
					}
					const tags = await tx
						.select()
						.from(workTaskTag)
						.where(eq(workTaskTag.taskId, from.id));
					if (tags.length)
						await tx
							.insert(workTaskTag)
							.values(tags.map((t) => ({ taskId: nid, tagId: t.tagId })));
					if (input.assignees) {
						const as = await tx
							.select()
							.from(workTaskAssignee)
							.where(eq(workTaskAssignee.taskId, from.id));
						await addAssignees(
							tx,
							nid,
							as.map((a) => a.userId),
							actor.userId,
						);
					}
					if (input.attachments) {
						const atts = await tx
							.select()
							.from(workAttachment)
							.where(
								and(
									eq(workAttachment.taskId, from.id),
									isNull(workAttachment.commentId),
									isNull(workAttachment.deletedAt),
								),
							);
						for (const { id: _old, createdAt: _c, ...a } of atts) {
							await tx
								.insert(workAttachment)
								.values({ ...a, taskId: nid, uploaderId: actor.userId });
							// The copy references the same blob instead of storing it twice.
							if (a.driver === "db")
								await tx
									.update(workBlob)
									.set({ refCount: sql`${workBlob.refCount} + 1` })
									.where(eq(workBlob.sha256, a.objectKey));
						}
					}
					return nid;
				};
				const nid = await copy(
					src,
					src.parentId,
					input.title ?? src.title,
					src.id,
				);
				for (const s of subs) await copy(s, nid, s.title);
				return nid;
			});
			pub(c, task.projectId, [copyId]);
			const row = await taskRow(db, copyId);
			await emitTaskEvent(c, "task.created", row);
			return respond(c, copyId, 201);
		},
	)
	.openapi(
		workMutation("taskArchive", {
			summary: "Archive a task and its subtasks",
			request: { params: TaskParam },
			responses: { 200: json(WorkTask, "Archived") },
		}),
		async (c) => setArchived(c, c.req.valid("param").id, true),
	)
	.openapi(
		workMutation("taskRestore", {
			summary: "Restore an archived task",
			request: { params: TaskParam },
			responses: { 200: json(WorkTask, "Restored") },
		}),
		async (c) => setArchived(c, c.req.valid("param").id, false),
	)
	.openapi(
		workMutation(
			"taskDelete",
			{
				summary:
					"Delete a task for good (work:admin, or its creator within 15 minutes)",
				request: { params: TaskParam },
				responses: NoContent,
			},
			true,
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const task = await taskRow(db, id);
			await guardDelete(c, task);
			c.set("auditResourceId", id);
			const blobs = await taskBlobs(db, [id]);
			await db.delete(workTask).where(eq(workTask.id, id));
			await releaseBlobs(c.var.deps, requireActor(c).organizationId, blobs);
			pub(c, task.projectId, [id], "delete");
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation(
			"taskBulk",
			{
				summary:
					"Change, archive or delete up to 500 tasks; per-task errors are reported",
				request: body(WorkTaskBulk),
				responses: { 200: json(WorkTaskBulkResult, "Result") },
			},
			true,
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			// Only bulk deletes reach the audit log.
			if (!input.delete) c.set("audited", true);
			const rows = await tasksFrom(db).where(
				inArray(workTask.id, input.taskIds),
			);
			const updated: string[] = [];
			const errors: { taskId: string; code: string; message: string }[] = [];
			const events: (() => Promise<void>)[] = [];
			const touched = new Map<string, string[]>();
			const s = input.set ?? {};
			const workingDays = new Map<string, number>();
			const blobs: Awaited<ReturnType<typeof taskBlobs>> = [];
			await db.transaction(async (tx) => {
				for (const taskId of input.taskIds) {
					const t = rows.find((r) => r.id === taskId);
					if (!t) {
						errors.push({
							taskId,
							code: "not_found",
							message: "task not found",
						});
						continue;
					}
					// Set inside the savepoint, kept only when it commits.
					let gone: typeof blobs = [];
					let created: string | null = null;
					try {
						await tx.transaction(async (sp) => {
							const { resource } = input.delete
								? await guardDelete(c, t)
								: await guard(c, "work", t.projectId);
							if (input.delete) {
								gone = await taskBlobs(sp, [t.id]);
								await sp.delete(workTask).where(eq(workTask.id, t.id));
								return;
							}
							const set: Partial<typeof workTask.$inferInsert> = {};
							let change: Awaited<ReturnType<typeof statusChange>> | undefined;
							if (s.statusId && s.statusId !== t.statusId) {
								const st = await statusChange(sp, t, s.statusId);
								change = st;
								Object.assign(set, {
									statusId: s.statusId,
									completedAt: st.completedAt,
								});
								await writeActivity(sp, {
									taskId: t.id,
									actorId: actor.userId,
									kind: "status",
									data: { from: t.statusId, to: s.statusId },
								});
								events.push(() =>
									emitTaskEvent(c, "task.status_changed", t, {
										statusName: st.to.name,
									}),
								);
								if (st.to.category === "done" && st.from.category !== "done")
									events.push(() =>
										emitTaskEvent(c, "task.completed", t, {
											statusName: st.to.name,
										}),
									);
							}
							if (s.listId && s.listId !== t.listId) {
								await rowOr404(
									sp
										.select({ id: workList.id })
										.from(workList)
										.where(
											and(
												eq(workList.id, s.listId),
												eq(workList.projectId, t.projectId),
												isNull(workList.archivedAt),
											),
										),
									"list",
								);
								Object.assign(set, {
									listId: s.listId,
									position: await placeInList(sp, s.listId, t.id),
								});
								await writeActivity(sp, {
									taskId: t.id,
									actorId: actor.userId,
									kind: "list_moved",
									data: { from: t.listId, to: s.listId },
								});
							}
							if (s.priority && s.priority !== t.priority) {
								set.priority = s.priority;
								await writeActivity(sp, {
									taskId: t.id,
									actorId: actor.userId,
									kind: "priority",
									data: { before: t.priority, after: s.priority },
								});
							}
							if (
								s.startDate !== undefined ||
								s.dueDate !== undefined ||
								s.shiftDays
							) {
								let wd = workingDays.get(t.projectId);
								if (wd === undefined) {
									const [p] = await sp
										.select({ wd: workProject.workingDays })
										.from(workProject)
										.where(eq(workProject.projectId, t.projectId));
									wd = p?.wd ?? 31;
									workingDays.set(t.projectId, wd);
								}
								const shift = (d: string | null) =>
									d && s.shiftDays ? addWorkingDays(d, s.shiftDays, wd) : d;
								const before = { startDate: t.startDate, dueDate: t.dueDate };
								const after = checkDates({
									startDate: shift(
										s.startDate !== undefined ? s.startDate : t.startDate,
									),
									dueDate: shift(
										s.dueDate !== undefined ? s.dueDate : t.dueDate,
									),
									dueTime: t.dueTime,
									isMilestone: t.isMilestone,
								});
								Object.assign(set, after);
								await writeActivity(sp, {
									taskId: t.id,
									actorId: actor.userId,
									kind: "dates",
									data: { before, after },
								});
							}
							if (Object.keys(set).length)
								await sp.update(workTask).set(set).where(eq(workTask.id, t.id));
							if (change) {
								const next = await applyRecurrenceOnComplete(
									sp,
									t,
									change.from,
									change.to,
									actor.userId,
								);
								if (next) created = next;
							}
							if (s.addAssignees?.length) {
								await assertAssignable(db, resource, s.addAssignees);
								const added = await addAssignees(
									sp,
									t.id,
									s.addAssignees,
									actor.userId,
								);
								if (added.length)
									events.push(() =>
										emitTaskEvent(c, "task.assigned", t, {
											assigneeIds: added,
										}),
									);
							}
							if (s.removeAssignees?.length)
								await removeAssignees(
									sp,
									t.id,
									s.removeAssignees,
									actor.userId,
								);
							if (s.addTags?.length || s.removeTags?.length) {
								await assertTags(sp, t.projectId, s.addTags ?? []);
								await changeTags(
									sp,
									t.id,
									s.addTags ?? [],
									s.removeTags ?? [],
									actor.userId,
								);
							}
							if (s.fields) {
								const fields = await fieldsFor(
									sp,
									t.projectId,
									set.listId ?? t.listId,
								);
								for (const [fieldId, raw] of Object.entries(s.fields)) {
									const f = fields.find((x) => x.id === fieldId);
									if (!f)
										throw new Failure(
											"bad_request",
											`field ${fieldId} doesn't apply to this task`,
										);
									await setFieldValue(sp, t, f, raw, actor.userId);
								}
							}
							if (input.archive !== undefined) {
								await sp
									.update(workTask)
									.set({ archivedAt: input.archive ? new Date() : null })
									.where(
										or(eq(workTask.id, t.id), eq(workTask.parentId, t.id)),
									);
								await writeActivity(sp, {
									taskId: t.id,
									actorId: actor.userId,
									kind: input.archive ? "archived" : "restored",
								});
							}
						});
						updated.push(t.id);
						touched.set(t.projectId, [
							...(touched.get(t.projectId) ?? []),
							t.id,
						]);
						blobs.push(...gone);
						if (created)
							touched.set(t.projectId, [
								...(touched.get(t.projectId) ?? []),
								created,
							]);
					} catch (e) {
						if (!(e instanceof Failure)) throw e;
						errors.push({ taskId, code: e.code, message: e.message });
					}
				}
			});
			await releaseBlobs(c.var.deps, actor.organizationId, blobs);
			for (const e of events) await e();
			for (const [projectId, ids] of touched)
				pub(c, projectId, ids, input.delete ? "delete" : "upsert");
			return c.json({ updated, errors }, 200);
		},
	)
	.openapi(
		workMutation("taskAssigneeAdd", {
			summary: "Assign someone who holds work on the project",
			request: { params: TaskUserParam },
			responses: NoContent,
		}),
		async (c) => {
			const { id, userId } = c.req.valid("param");
			const { task, actor, resource } = await taskFor(c, id, "work");
			await assertAssignable(c.var.deps.db, resource, [userId]);
			const added = await c.var.deps.db.transaction((tx) =>
				addAssignees(tx, id, [userId], actor.userId),
			);
			if (added.length) {
				await emitTaskEvent(c, "task.assigned", task, { assigneeIds: added });
				pub(c, task.projectId, [id]);
			}
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("taskAssigneeRemove", {
			summary: "Unassign someone",
			request: { params: TaskUserParam },
			responses: NoContent,
		}),
		async (c) => {
			const { id, userId } = c.req.valid("param");
			const { task, actor } = await taskFor(c, id, "work");
			await c.var.deps.db.transaction((tx) =>
				removeAssignees(tx, id, [userId], actor.userId),
			);
			pub(c, task.projectId, [id]);
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("taskWatcherAdd", {
			summary: "Watch a task (yourself with read:work, others with work)",
			request: { params: TaskUserParam },
			responses: NoContent,
		}),
		async (c) => watch(c, true),
	)
	.openapi(
		workMutation("taskWatcherRemove", {
			summary: "Stop watching; auto-watch won't add the user back",
			request: { params: TaskUserParam },
			responses: NoContent,
		}),
		async (c) => watch(c, false),
	)
	.openapi(
		workMutation("taskTagAdd", {
			summary: "Tag a task",
			request: { params: z.object({ id: z.string(), tagId: z.string() }) },
			responses: NoContent,
		}),
		async (c) => {
			const { id, tagId } = c.req.valid("param");
			const { task, actor } = await taskFor(c, id, "work");
			await assertTags(c.var.deps.db, task.projectId, [tagId]);
			await c.var.deps.db.transaction((tx) =>
				changeTags(tx, id, [tagId], [], actor.userId),
			);
			pub(c, task.projectId, [id]);
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("taskTagRemove", {
			summary: "Untag a task",
			request: { params: z.object({ id: z.string(), tagId: z.string() }) },
			responses: NoContent,
		}),
		async (c) => {
			const { id, tagId } = c.req.valid("param");
			const { task, actor } = await taskFor(c, id, "work");
			await c.var.deps.db.transaction((tx) =>
				changeTags(tx, id, [], [tagId], actor.userId),
			);
			pub(c, task.projectId, [id]);
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("taskFieldSet", {
			summary: "Set a custom field value (empty clears it)",
			request: {
				params: z.object({ id: z.string(), fieldId: z.string() }),
				...body(z.object({ value: z.unknown() })),
			},
			responses: NoContent,
		}),
		async (c) => setField(c, c.req.valid("param"), c.req.valid("json").value),
	)
	.openapi(
		workMutation("taskFieldClear", {
			summary: "Clear a custom field value",
			request: { params: z.object({ id: z.string(), fieldId: z.string() }) },
			responses: NoContent,
		}),
		async (c) => setField(c, c.req.valid("param"), null),
	)
	.openapi(
		workMutation("taskDependencyAdd", {
			summary: "Mark the task blocked by another task of the project",
			request: { params: TaskParam, ...body(WorkDependencyCreate) },
			responses: NoContent,
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { task, actor } = await taskFor(c, id, "work");
			const blocker = await taskRow(db, input.blockedById);
			if (blocker.projectId !== task.projectId)
				throw new Failure(
					"bad_request",
					"dependencies stay within one project",
				);
			await db.transaction(async (tx) => {
				// Serialise edge changes per project so two inserts can't close a loop together.
				await tx
					.select({ id: workProject.projectId })
					.from(workProject)
					.where(eq(workProject.projectId, task.projectId))
					.for("update");
				const edges = await tx
					.select({
						taskId: workDependency.taskId,
						blockedById: workDependency.blockedById,
					})
					.from(workDependency)
					.innerJoin(workTask, eq(workTask.id, workDependency.taskId))
					.where(eq(workTask.projectId, task.projectId));
				const loop = wouldCycle(
					edges.filter(
						(e) => !(e.taskId === id && e.blockedById === blocker.id),
					),
					id,
					blocker.id,
				);
				if (loop) {
					const keys = await tasksFrom(tx).where(inArray(workTask.id, loop));
					const name = (x: string) => keys.find((k) => k.id === x)?.key ?? x;
					throw new Failure(
						"conflict",
						`this would create a loop: ${loop.map(name).join(" → ")}`,
						{ loop },
					);
				}
				const [existing] = await tx
					.select()
					.from(workDependency)
					.where(
						and(
							eq(workDependency.taskId, id),
							eq(workDependency.blockedById, blocker.id),
						),
					);
				await tx
					.insert(workDependency)
					.values({
						taskId: id,
						blockedById: blocker.id,
						lagDays: input.lagDays,
						createdBy: actor.userId,
					})
					.onConflictDoUpdate({
						target: [workDependency.taskId, workDependency.blockedById],
						set: { lagDays: input.lagDays },
					});
				if (!existing)
					await writeActivity(tx, {
						taskId: id,
						actorId: actor.userId,
						kind: "dependency_added",
						data: { blockedById: blocker.id },
					});
			});
			pub(c, task.projectId, [id, blocker.id]);
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("taskDependencyRemove", {
			summary: "Remove a dependency",
			request: {
				params: z.object({ id: z.string(), blockedById: z.string() }),
			},
			responses: NoContent,
		}),
		async (c) => {
			const { id, blockedById } = c.req.valid("param");
			const { db } = c.var.deps;
			const { task, actor } = await taskFor(c, id, "work");
			await db.transaction(async (tx) => {
				const gone = await tx
					.delete(workDependency)
					.where(
						and(
							eq(workDependency.taskId, id),
							eq(workDependency.blockedById, blockedById),
						),
					)
					.returning();
				if (gone.length)
					await writeActivity(tx, {
						taskId: id,
						actorId: actor.userId,
						kind: "dependency_removed",
						data: { blockedById },
					});
			});
			pub(c, task.projectId, [id, blockedById]);
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("taskShiftPreview", {
			summary:
				"Dependants that would move if the task moved by deltaDays working days",
			request: { params: TaskParam, ...body(WorkShiftPreviewRequest) },
			responses: { 200: json(WorkShiftPreview, "Changes") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { task } = await taskFor(c, id, "read:work");
			const [wp] = await db
				.select({ wd: workProject.workingDays })
				.from(workProject)
				.where(eq(workProject.projectId, task.projectId));
			const wd = wp?.wd ?? 31;
			const [tasks, edges] = await Promise.all([
				db
					.select({
						id: workTask.id,
						startDate: workTask.startDate,
						dueDate: workTask.dueDate,
					})
					.from(workTask)
					.where(eq(workTask.projectId, task.projectId)),
				db
					.select({
						taskId: workDependency.taskId,
						blockedById: workDependency.blockedById,
						lagDays: workDependency.lagDays,
					})
					.from(workDependency)
					.innerJoin(workTask, eq(workTask.id, workDependency.taskId))
					.where(eq(workTask.projectId, task.projectId)),
			]);
			if (!input.dueOnly)
				return c.json(
					{ changes: shiftDependants(tasks, edges, id, input.deltaDays, wd) },
					200,
				);
			// A resize moves only the due date; dependants follow from there.
			const due = task.dueDate
				? addWorkingDays(task.dueDate, input.deltaDays, wd)
				: null;
			const moved = { id, startDate: task.startDate, dueDate: due };
			const rest = shiftDependants(
				tasks.map((t) => (t.id === id ? moved : t)),
				edges,
				id,
				0,
				wd,
			);
			return c.json(
				{ changes: input.deltaDays && due ? [moved, ...rest] : rest },
				200,
			);
		},
	)
	.openapi(
		workRoute("checklistList", {
			summary: "Checklist items of a task",
			request: { params: TaskParam },
			responses: { 200: json(z.array(WorkChecklistItem), "Items") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			await taskFor(c, id, "read:work");
			const items = await c.var.deps.db
				.select()
				.from(workChecklistItem)
				.where(eq(workChecklistItem.taskId, id))
				.orderBy(asc(workChecklistItem.position), asc(workChecklistItem.id));
			return c.json(items.map(checklistDto), 200);
		},
	)
	.openapi(
		workMutation("checklistCreate", {
			summary: "Add a checklist item",
			request: { params: TaskParam, ...body(WorkChecklistCreate) },
			responses: { 201: json(WorkChecklistItem, "Created") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { task, actor, resource } = await taskFor(c, id, "work");
			if (input.assigneeId)
				await assertAssignable(db, resource, [input.assigneeId]);
			const row = await db.transaction(async (tx) => {
				await tx
					.select({ id: workTask.id })
					.from(workTask)
					.where(eq(workTask.id, id))
					.for("update");
				if (
					(await tx.$count(
						workChecklistItem,
						eq(workChecklistItem.taskId, id),
					)) >= LIMITS.checklist
				)
					throw new Failure(
						"bad_request",
						`at most ${LIMITS.checklist} checklist items`,
					);
				const position = await checklistPosition(tx, id, null, {
					after: input.after,
				});
				const [r] = await tx
					.insert(workChecklistItem)
					.values({
						taskId: id,
						text: input.text,
						assigneeId: input.assigneeId ?? null,
						position,
					})
					.returning();
				await writeActivity(tx, {
					taskId: id,
					actorId: actor.userId,
					kind: "checklist",
					data: { action: "added", text: input.text },
				});
				return r as typeof workChecklistItem.$inferSelect;
			});
			pub(c, task.projectId, [id]);
			return c.json(checklistDto(row), 201);
		},
	)
	.openapi(
		workMutation("checklistUpdate", {
			summary:
				"Edit, tick or move a checklist item (comment:work may tick items assigned to them)",
			request: { params: IdParam, ...body(WorkChecklistPatch) },
			responses: { 200: json(WorkChecklistItem, "Updated") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const item = await rowOr404(
				db.select().from(workChecklistItem).where(eq(workChecklistItem.id, id)),
				"checklist item",
			);
			const task = await taskRow(db, item.taskId);
			const actor = requireActor(c);
			const tickOnly =
				Object.keys(input).every((k) => k === "done") &&
				item.assigneeId === actor.userId;
			const { resource } = await guard(
				c,
				tickOnly ? "comment:work" : "work",
				task.projectId,
			);
			if (input.assigneeId)
				await assertAssignable(db, resource, [input.assigneeId]);
			const row = await db.transaction(async (tx) => {
				const set: Partial<typeof workChecklistItem.$inferInsert> = {};
				if (input.text !== undefined) set.text = input.text;
				if (input.assigneeId !== undefined) set.assigneeId = input.assigneeId;
				if (input.done !== undefined && input.done !== item.done)
					Object.assign(set, {
						done: input.done,
						doneBy: input.done ? actor.userId : null,
						doneAt: input.done ? new Date() : null,
					});
				if (input.before || input.after)
					set.position = await checklistPosition(tx, item.taskId, id, input);
				const [r] = await tx
					.update(workChecklistItem)
					.set(set)
					.where(eq(workChecklistItem.id, id))
					.returning();
				if (set.done !== undefined)
					await writeActivity(tx, {
						taskId: item.taskId,
						actorId: actor.userId,
						kind: "checklist",
						data: {
							action: input.done ? "ticked" : "unticked",
							text: item.text,
						},
					});
				return r as typeof workChecklistItem.$inferSelect;
			});
			pub(c, task.projectId, [item.taskId]);
			return c.json(checklistDto(row), 200);
		},
	)
	.openapi(
		workMutation("checklistDelete", {
			summary: "Remove a checklist item",
			request: { params: IdParam },
			responses: NoContent,
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const item = await rowOr404(
				db.select().from(workChecklistItem).where(eq(workChecklistItem.id, id)),
				"checklist item",
			);
			const { task, actor } = await taskFor(c, item.taskId, "work");
			await db.transaction(async (tx) => {
				await tx.delete(workChecklistItem).where(eq(workChecklistItem.id, id));
				await writeActivity(tx, {
					taskId: item.taskId,
					actorId: actor.userId,
					kind: "checklist",
					data: { action: "removed", text: item.text },
				});
			});
			pub(c, task.projectId, [item.taskId]);
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("checklistConvert", {
			summary: "Turn a checklist item into a subtask",
			request: { params: IdParam },
			responses: { 201: json(WorkTask, "The subtask") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const item = await rowOr404(
				db.select().from(workChecklistItem).where(eq(workChecklistItem.id, id)),
				"checklist item",
			);
			const { task, actor, resource } = await taskFor(c, item.taskId, "work");
			if (task.parentId)
				throw new Failure("bad_request", "subtasks can't have subtasks");
			const [first] = await statusesOf(db, task.projectId);
			const assignee = item.assigneeId
				? await assertAssignable(db, resource, [item.assigneeId]).then(
						() => item.assigneeId,
						() => null,
					)
				: null;
			const sid = await db.transaction(async (tx) => {
				const sid = await insertTask(tx, {
					projectId: task.projectId,
					listId: task.listId,
					parentId: task.id,
					title: item.text,
					statusId: item.done
						? ((await statusesOf(tx, task.projectId)).find(
								(s) => s.category === "done",
							)?.id ?? (first as Status).id)
						: (first as Status).id,
					completedAt: item.done ? new Date() : null,
					createdBy: actor.userId,
				});
				if (assignee) await addAssignees(tx, sid, [assignee], actor.userId);
				await tx.delete(workChecklistItem).where(eq(workChecklistItem.id, id));
				return sid;
			});
			const row = await taskRow(db, sid);
			await emitTaskEvent(c, "task.created", row);
			pub(c, task.projectId, [task.id, sid]);
			return respond(c, sid, 201);
		},
	)
	.openapi(
		workRoute("taskActivity", {
			summary:
				"Comments and activity merged, newest last; cursor pages older items",
			request: {
				params: TaskParam,
				query: z.object({ cursor: z.string().optional() }),
			},
			responses: { 200: json(WorkFeedPage, "Feed") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { cursor } = c.req.valid("query");
			const { db } = c.var.deps;
			await taskFor(c, id, "read:work");
			const before = cursor
				? new Date(Buffer.from(cursor, "base64url").toString())
				: undefined;
			if (before && Number.isNaN(before.getTime()))
				throw new Failure("bad_request", "invalid cursor");
			const PAGE = 50;
			const [activity, comments] = await Promise.all([
				db
					.select()
					.from(workActivity)
					.where(
						and(
							eq(workActivity.taskId, id),
							before ? lt(workActivity.createdAt, before) : undefined,
						),
					)
					.orderBy(desc(workActivity.createdAt))
					.limit(PAGE + 1),
				commentsOf(db, id, before),
			]);
			const merged = [
				...activity.map((a) => ({
					at: a.createdAt,
					item: {
						type: "activity" as const,
						activity: {
							id: a.id,
							taskId: a.taskId,
							actorId: a.actorId,
							kind: a.kind,
							data: a.data,
							createdAt: a.createdAt.toISOString(),
						},
					} as WorkFeedItem,
				})),
				...comments,
			].sort((a, b) => b.at.getTime() - a.at.getTime());
			const page = merged.slice(0, PAGE);
			// shortcut: the cursor is a timestamp, so items sharing the page's oldest millisecond can be skipped; add the id if that ever matters.
			const oldest = page.at(-1);
			return c.json(
				{
					items: page.reverse().map((p) => p.item),
					nextCursor:
						merged.length > PAGE && oldest
							? Buffer.from(oldest.at.toISOString()).toString("base64url")
							: null,
				},
				200,
			);
		},
	);

/** `work:admin`, or `work` for the creator within 15 minutes of creating it. */
async function guardDelete(c: Context<Env>, task: TaskRow) {
	const actor = requireActor(c);
	const own =
		task.createdBy === actor.userId &&
		Date.now() - task.createdAt.getTime() < DELETE_WINDOW_MS;
	return guard(c, own ? "work" : "work:admin", task.projectId);
}

async function setArchived(c: Context<Env>, id: string, archived: boolean) {
	const { task, actor } = await taskFor(c, id, "work");
	await c.var.deps.db.transaction(async (tx) => {
		await tx
			.update(workTask)
			.set({ archivedAt: archived ? new Date() : null })
			.where(or(eq(workTask.id, id), eq(workTask.parentId, id)));
		await writeActivity(tx, {
			taskId: id,
			actorId: actor.userId,
			kind: archived ? "archived" : "restored",
		});
	});
	pub(c, task.projectId, [id]);
	return respond(c, id);
}

async function watch(c: Context<Env>, on: boolean) {
	const { id, userId } = c.req.param() as { id: string; userId: string };
	const actor = requireActor(c);
	const task = await taskRow(c.var.deps.db, id);
	const { resource } = await guard(
		c,
		userId === actor.userId ? "read:work" : "work",
		task.projectId,
	);
	if (on && userId !== actor.userId) {
		const g = (
			await memberGrants(c.var.deps.db, actor.organizationId, [userId])
		).get(userId);
		if (
			!g ||
			!actorCan(
				{ ...actor, id: userId, grants: g, keyScopes: undefined },
				"read:work",
				resource,
			)
		)
			throw new Failure("bad_request", "this person can't read the task");
	}
	await c.var.deps.db
		.insert(workTaskWatcher)
		.values({ taskId: id, userId, reason: "manual", muted: !on })
		.onConflictDoUpdate({
			target: [workTaskWatcher.taskId, workTaskWatcher.userId],
			set: { muted: !on },
		});
	pub(c, task.projectId, [id]);
	return c.body(null, 204);
}

async function setField(
	c: Context<Env>,
	p: { id: string; fieldId: string },
	value: unknown,
) {
	const { db } = c.var.deps;
	const { task, actor } = await taskFor(c, p.id, "work");
	const field = await rowOr404(
		db
			.select()
			.from(workField)
			.where(
				and(
					eq(workField.id, p.fieldId),
					eq(workField.projectId, task.projectId),
					or(isNull(workField.listId), eq(workField.listId, task.listId)),
				),
			),
		"field",
	);
	await db.transaction((tx) =>
		setFieldValue(tx, task, field, value, actor.userId),
	);
	pub(c, task.projectId, [p.id]);
	return c.body(null, 204);
}

/** Checklist items are few per task: a plain fractional key between neighbours. */
async function checklistPosition(
	tx: DbOrTx,
	taskId: string,
	self: string | null,
	at: { before?: string; after?: string },
) {
	const items = (
		await tx
			.select({ id: workChecklistItem.id, p: workChecklistItem.position })
			.from(workChecklistItem)
			.where(eq(workChecklistItem.taskId, taskId))
			.orderBy(asc(workChecklistItem.position), asc(workChecklistItem.id))
	).filter((i) => i.id !== self);
	const idx = at.after
		? items.findIndex((i) => i.id === at.after) + 1
		: at.before
			? items.findIndex((i) => i.id === at.before)
			: items.length;
	if (idx < 0 || (at.after && idx === 0))
		throw new Failure(
			"bad_request",
			"before/after must be another item of the task",
		);
	return rankBetween(items[idx - 1]?.p ?? null, items[idx]?.p ?? null);
}
