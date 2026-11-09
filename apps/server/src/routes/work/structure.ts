import { z } from "@hono/zod-openapi";
import {
	type FilterNode,
	WorkField,
	WorkFieldCreate,
	WorkFieldPatch,
	WorkList,
	WorkListCreate,
	WorkListPatch,
	WorkOrder,
	WorkStatus,
	WorkStatusCreate,
	WorkStatusPatch,
	WorkTag,
	WorkTagCreate,
	WorkTagPatch,
	WorkView,
	WorkViewConfig,
	WorkViewCreate,
	WorkViewPatch,
} from "@logistack/contracts";
import {
	canDeleteStatus,
	rankBetween,
	rankN,
	validateFilter,
} from "@logistack/core";
import {
	workField,
	workList,
	workProject,
	workStatus,
	workTag,
	workTask,
	workView,
} from "@logistack/db";
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../../actor.ts";
import type { Env } from "../../env.ts";
import { Failure } from "../../errors.ts";
import { body, IdParam, json, router } from "../../openapi.ts";
import {
	assertSameSet,
	fieldDto,
	guard,
	listDto,
	rowOr404,
	statusDto,
	tagDto,
	viewDto,
	workMutation,
	workRoute,
} from "../../work/api.ts";
import { releaseBlobs, taskBlobs } from "../../work/blob-store.ts";
import {
	type DbOrTx,
	ensureWorkProject,
	publishWork,
	type WorkMessage,
} from "../../work/context.ts";

const LIMITS = {
	statuses: 30,
	lists: 200,
	fields: 100,
	sharedViews: 50,
	personalViews: 20,
};

const pub = (
	c: Context<Env>,
	projectId: string,
	entity: WorkMessage["entity"],
	op: WorkMessage["op"] = "upsert",
	taskIds?: string[],
) => {
	const actor = c.get("actor");
	publishWork(c.var.deps, {
		organizationId: actor?.organizationId ?? "",
		projectId,
		entity,
		op,
		...(taskIds ? { taskIds } : {}),
		actorId: actor?.userId ?? null,
	});
};

const NoContent = { 204: { description: "Done" } } as const;

/** `completed_at` for tasks moved from one status category to another (core `applyStatusChange`, in SQL). */
const completedFor = (category: string) =>
	category === "done"
		? sql`coalesce(${workTask.completedAt}, now())`
		: sql`null`;

async function lastPosition(
	db: DbOrTx,
	table:
		| typeof workStatus
		| typeof workList
		| typeof workField
		| typeof workView,
	projectId: string,
) {
	const [row] = await db
		.select({ p: table.position })
		.from(table)
		.where(eq(table.projectId, projectId))
		.orderBy(desc(table.position))
		.limit(1);
	return row?.p ?? null;
}

/** Validates a view's filter against the project's fields. */
async function checkViewFilter(
	db: DbOrTx,
	projectId: string,
	filter: FilterNode | null,
) {
	if (!filter) return;
	const fields = await db
		.select({ id: workField.id, kind: workField.kind })
		.from(workField)
		.where(eq(workField.projectId, projectId));
	const r = validateFilter(filter, fields);
	if (!r.ok) throw new Failure("bad_request", `invalid filter: ${r.error}`);
}

/** Rewrites positions in the order of `ids`. */
async function reorder(
	db: DbOrTx,
	table:
		| typeof workStatus
		| typeof workList
		| typeof workField
		| typeof workView,
	ids: string[],
) {
	const ranks = rankN(null, null, ids.length);
	await db.transaction(async (tx) => {
		for (const [i, id] of ids.entries())
			await tx
				.update(table)
				.set({ position: ranks[i] as string })
				.where(eq(table.id, id));
	});
}

const statusesOf = (db: DbOrTx, projectId: string) =>
	db
		.select()
		.from(workStatus)
		.where(eq(workStatus.projectId, projectId))
		.orderBy(asc(workStatus.position));

const listsOf = async (db: DbOrTx, projectId: string) => {
	const rows = await db
		.select({
			list: workList,
			open: sql<number>`(select count(*)::int from work_task t join work_status s on s.id = t.status_id where t.list_id = "work_list"."id" and t.parent_id is null and t.archived_at is null and s.category in ('backlog', 'active'))`,
		})
		.from(workList)
		.where(eq(workList.projectId, projectId))
		.orderBy(asc(workList.position));
	return rows.map((r) => listDto(r.list, r.open));
};

const fieldsOf = (db: DbOrTx, projectId: string) =>
	db
		.select()
		.from(workField)
		.where(eq(workField.projectId, projectId))
		.orderBy(asc(workField.position));

const visibleViews = (db: DbOrTx, projectId: string, userId: string) =>
	db
		.select()
		.from(workView)
		.where(
			and(
				eq(workView.projectId, projectId),
				or(isNull(workView.ownerId), eq(workView.ownerId, userId)),
			),
		)
		.orderBy(asc(workView.position));

/** Shared views need `work:admin`; personal ones belong to their owner, who needs `work`. */
async function guardView(c: Context<Env>, view: typeof workView.$inferSelect) {
	if (view.ownerId === null) return guard(c, "work:admin", view.projectId);
	const r = await guard(c, "work", view.projectId);
	if (view.ownerId !== r.actor.userId)
		throw new Failure("forbidden", "only its owner can change a personal view");
	return r;
}

const ProjectParam = IdParam;

export const structureRoutes = router()
	// --- statuses -------------------------------------------------------
	.openapi(
		workRoute("statusList", {
			summary: "Statuses of a project, in order",
			request: { params: ProjectParam },
			responses: { 200: json(z.array(WorkStatus), "Statuses") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			await guard(c, "read:work", id);
			await ensureWorkProject(c.var.deps.db, id);
			return c.json((await statusesOf(c.var.deps.db, id)).map(statusDto), 200);
		},
	)
	.openapi(
		workMutation("statusCreate", {
			summary: "Add a status",
			request: { params: ProjectParam, ...body(WorkStatusCreate) },
			responses: { 201: json(WorkStatus, "Created") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			await guard(c, "work:admin", id);
			await ensureWorkProject(db, id);
			if (
				(await db.$count(workStatus, eq(workStatus.projectId, id))) >=
				LIMITS.statuses
			)
				throw new Failure("bad_request", `at most ${LIMITS.statuses} statuses`);
			const [row] = await db
				.insert(workStatus)
				.values({
					projectId: id,
					name: input.name,
					color: input.color,
					category: input.category,
					wipLimit: input.wipLimit ?? null,
					position: rankBetween(await lastPosition(db, workStatus, id), null),
				})
				.returning();
			pub(c, id, "status");
			return c.json(statusDto(row as typeof workStatus.$inferSelect), 201);
		},
	)
	.openapi(
		workMutation("statusUpdate", {
			summary: "Rename, recolour or recategorise a status",
			request: { params: IdParam, ...body(WorkStatusPatch) },
			responses: { 200: json(WorkStatus, "Updated") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const s = await rowOr404(
				db.select().from(workStatus).where(eq(workStatus.id, id)),
				"status",
			);
			await guard(c, "work:admin", s.projectId);
			const row = await db.transaction(async (tx) => {
				if (input.category && input.category !== s.category) {
					const check = canDeleteStatus(await statusesOf(tx, s.projectId), id);
					if (!check.ok) throw new Failure("conflict", check.reason);
					if ((input.category === "done") !== (s.category === "done"))
						await tx
							.update(workTask)
							.set({ completedAt: completedFor(input.category) })
							.where(eq(workTask.statusId, id));
				}
				const [r] = await tx
					.update(workStatus)
					.set(input)
					.where(eq(workStatus.id, id))
					.returning();
				return r as typeof workStatus.$inferSelect;
			});
			pub(c, s.projectId, "status");
			return c.json(statusDto(row), 200);
		},
	)
	.openapi(
		workMutation(
			"statusDelete",
			{
				summary: "Delete a status, moving its tasks to another one",
				request: {
					params: IdParam,
					query: z.object({ moveTo: z.string().optional() }),
				},
				responses: NoContent,
			},
			true,
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { moveTo } = c.req.valid("query");
			const { db } = c.var.deps;
			const s = await rowOr404(
				db.select().from(workStatus).where(eq(workStatus.id, id)),
				"status",
			);
			await guard(c, "work:admin", s.projectId);
			c.set("auditResourceId", id);
			await db.transaction(async (tx) => {
				const statuses = await statusesOf(tx, s.projectId);
				const check = canDeleteStatus(statuses, id);
				if (!check.ok) throw new Failure("conflict", check.reason);
				const used = await tx.$count(workTask, eq(workTask.statusId, id));
				if (used > 0) {
					const target = statuses.find((x) => x.id === moveTo && x.id !== id);
					if (!target)
						throw new Failure(
							"bad_request",
							`${used} tasks use this status: pass moveTo with another status of the project`,
						);
					await tx
						.update(workTask)
						.set({
							statusId: target.id,
							...((target.category === "done") !== (s.category === "done")
								? { completedAt: completedFor(target.category) }
								: {}),
						})
						.where(eq(workTask.statusId, id));
				}
				await tx
					.update(workProject)
					.set({ closingStatusId: null })
					.where(eq(workProject.closingStatusId, id));
				await tx.delete(workStatus).where(eq(workStatus.id, id));
			});
			pub(c, s.projectId, "status", "delete");
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("statusOrder", {
			summary: "Reorder statuses",
			request: { params: ProjectParam, ...body(WorkOrder) },
			responses: { 200: json(z.array(WorkStatus), "Statuses") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { ids } = c.req.valid("json");
			const { db } = c.var.deps;
			await guard(c, "work:admin", id);
			assertSameSet(
				ids,
				(await statusesOf(db, id)).map((s) => s.id),
			);
			await reorder(db, workStatus, ids);
			pub(c, id, "status");
			return c.json((await statusesOf(db, id)).map(statusDto), 200);
		},
	)
	// --- lists ----------------------------------------------------------
	.openapi(
		workRoute("listList", {
			summary: "Lists of a project with open-task counts (archived included)",
			request: { params: ProjectParam },
			responses: { 200: json(z.array(WorkList), "Lists") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			await guard(c, "read:work", id);
			await ensureWorkProject(c.var.deps.db, id);
			return c.json(await listsOf(c.var.deps.db, id), 200);
		},
	)
	.openapi(
		workMutation("listCreate", {
			summary: "Create a list",
			request: { params: ProjectParam, ...body(WorkListCreate) },
			responses: { 201: json(WorkList, "Created") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			await guard(c, "work:admin", id);
			await ensureWorkProject(db, id);
			if (
				(await db.$count(workList, eq(workList.projectId, id))) >= LIMITS.lists
			)
				throw new Failure("bad_request", `at most ${LIMITS.lists} lists`);
			const [row] = await db
				.insert(workList)
				.values({
					projectId: id,
					name: input.name,
					description: input.description ?? null,
					color: input.color ?? null,
					icon: input.icon ?? null,
					position: rankBetween(await lastPosition(db, workList, id), null),
				})
				.returning();
			pub(c, id, "list");
			return c.json(listDto(row as typeof workList.$inferSelect, 0), 201);
		},
	)
	.openapi(
		workMutation("listUpdate", {
			summary: "Rename or restyle a list",
			request: { params: IdParam, ...body(WorkListPatch) },
			responses: { 200: json(WorkList, "Updated") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const l = await rowOr404(
				db.select().from(workList).where(eq(workList.id, id)),
				"list",
			);
			await guard(c, "work:admin", l.projectId);
			const [row] = await db
				.update(workList)
				.set(input)
				.where(eq(workList.id, id))
				.returning();
			pub(c, l.projectId, "list");
			return c.json(listDto(row as typeof workList.$inferSelect), 200);
		},
	)
	.openapi(
		workMutation(
			"listDelete",
			{
				summary: "Delete a list: empty, or moving or deleting its tasks",
				request: {
					params: IdParam,
					query: z.object({
						moveTo: z.string().optional(),
						deleteTasks: z.enum(["true", "false"]).optional(),
					}),
				},
				responses: NoContent,
			},
			true,
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { moveTo, deleteTasks } = c.req.valid("query");
			const { db } = c.var.deps;
			const l = await rowOr404(
				db.select().from(workList).where(eq(workList.id, id)),
				"list",
			);
			await guard(c, "work:admin", l.projectId);
			c.set("auditResourceId", id);
			const moved: string[] = [];
			const blobs = await db.transaction(async (tx) => {
				const tasks = await tx
					.select({ id: workTask.id })
					.from(workTask)
					.where(eq(workTask.listId, id))
					.orderBy(asc(workTask.position));
				if (tasks.length > 0 && deleteTasks !== "true") {
					if (!moveTo)
						throw new Failure(
							"conflict",
							`the list has ${tasks.length} tasks: pass moveTo or deleteTasks=true`,
						);
					const [target] = await tx
						.select({ id: workList.id })
						.from(workList)
						.where(
							and(
								eq(workList.id, moveTo),
								eq(workList.projectId, l.projectId),
								ne(workList.id, id),
							),
						)
						.for("update");
					if (!target)
						throw new Failure(
							"bad_request",
							"moveTo must be another list of the project",
						);
					const [last] = await tx
						.select({ p: workTask.position })
						.from(workTask)
						.where(eq(workTask.listId, moveTo))
						.orderBy(desc(workTask.position))
						.limit(1);
					const ranks = rankN(last?.p ?? null, null, tasks.length);
					for (const [i, t] of tasks.entries()) {
						await tx
							.update(workTask)
							.set({ listId: moveTo, position: ranks[i] as string })
							.where(eq(workTask.id, t.id));
						moved.push(t.id);
					}
				}
				await tx
					.update(workProject)
					.set({ defaultListId: null })
					.where(eq(workProject.defaultListId, id));
				// Tasks still on the list (deleteTasks) go with it by cascade, and so do their attachments.
				const gone = await taskBlobs(
					tx,
					moved.length ? [] : tasks.map((t) => t.id),
				);
				await tx.delete(workList).where(eq(workList.id, id));
				return gone;
			});
			await releaseBlobs(c.var.deps, requireActor(c).organizationId, blobs);
			pub(c, l.projectId, "list", "delete");
			if (moved.length) pub(c, l.projectId, "task", "upsert", moved);
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("listArchive", {
			summary: "Archive a list: hidden from views, tasks stay readable",
			request: { params: IdParam },
			responses: { 200: json(WorkList, "Archived") },
		}),
		async (c) => setArchived(c, c.req.valid("param").id, true),
	)
	.openapi(
		workMutation("listRestore", {
			summary: "Restore an archived list",
			request: { params: IdParam },
			responses: { 200: json(WorkList, "Restored") },
		}),
		async (c) => setArchived(c, c.req.valid("param").id, false),
	)
	.openapi(
		workMutation("listOrder", {
			summary: "Reorder lists",
			request: { params: ProjectParam, ...body(WorkOrder) },
			responses: { 200: json(z.array(WorkList), "Lists") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { ids } = c.req.valid("json");
			const { db } = c.var.deps;
			await guard(c, "work:admin", id);
			assertSameSet(
				ids,
				(await listsOf(db, id)).map((l) => l.id),
			);
			await reorder(db, workList, ids);
			pub(c, id, "list");
			return c.json(await listsOf(db, id), 200);
		},
	)
	// --- fields ---------------------------------------------------------
	.openapi(
		workRoute("fieldList", {
			summary: "Custom fields of a project",
			request: { params: ProjectParam },
			responses: { 200: json(z.array(WorkField), "Fields") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			await guard(c, "read:work", id);
			return c.json((await fieldsOf(c.var.deps.db, id)).map(fieldDto), 200);
		},
	)
	.openapi(
		workMutation("fieldCreate", {
			summary: "Add a custom field",
			request: { params: ProjectParam, ...body(WorkFieldCreate) },
			responses: { 201: json(WorkField, "Created") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			await guard(c, "work:admin", id);
			if (
				(await db.$count(workField, eq(workField.projectId, id))) >=
				LIMITS.fields
			)
				throw new Failure("bad_request", `at most ${LIMITS.fields} fields`);
			if (input.listId)
				await rowOr404(
					db
						.select({ id: workList.id })
						.from(workList)
						.where(
							and(eq(workList.id, input.listId), eq(workList.projectId, id)),
						),
					"list",
				);
			const [row] = await db
				.insert(workField)
				.values({
					projectId: id,
					listId: input.listId ?? null,
					name: input.name,
					kind: input.config.kind,
					config: input.config,
					required: input.required ?? false,
					description: input.description ?? null,
					position: rankBetween(await lastPosition(db, workField, id), null),
				})
				.returning();
			pub(c, id, "field");
			return c.json(fieldDto(row as typeof workField.$inferSelect), 201);
		},
	)
	.openapi(
		workMutation("fieldUpdate", {
			summary: "Rename or reconfigure a field (its kind can't change)",
			request: { params: IdParam, ...body(WorkFieldPatch) },
			responses: { 200: json(WorkField, "Updated") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const f = await rowOr404(
				db.select().from(workField).where(eq(workField.id, id)),
				"field",
			);
			await guard(c, "work:admin", f.projectId);
			if (input.config && input.config.kind !== f.kind)
				throw new Failure(
					"conflict",
					"a field's kind can't change: duplicate it as a new kind instead",
				);
			const [row] = await db
				.update(workField)
				.set(input)
				.where(eq(workField.id, id))
				.returning();
			pub(c, f.projectId, "field");
			return c.json(fieldDto(row as typeof workField.$inferSelect), 200);
		},
	)
	.openapi(
		workMutation(
			"fieldDelete",
			{
				summary: "Delete a field and its values",
				request: { params: IdParam },
				responses: NoContent,
			},
			true,
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const f = await rowOr404(
				db.select().from(workField).where(eq(workField.id, id)),
				"field",
			);
			await guard(c, "work:admin", f.projectId);
			c.set("auditResourceId", id);
			await db.delete(workField).where(eq(workField.id, id));
			pub(c, f.projectId, "field", "delete");
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("fieldOrder", {
			summary: "Reorder fields",
			request: { params: ProjectParam, ...body(WorkOrder) },
			responses: { 200: json(z.array(WorkField), "Fields") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { ids } = c.req.valid("json");
			const { db } = c.var.deps;
			await guard(c, "work:admin", id);
			assertSameSet(
				ids,
				(await fieldsOf(db, id)).map((f) => f.id),
			);
			await reorder(db, workField, ids);
			pub(c, id, "field");
			return c.json((await fieldsOf(db, id)).map(fieldDto), 200);
		},
	)
	// --- tags -----------------------------------------------------------
	.openapi(
		workRoute("tagList", {
			summary: "Tags of a project",
			request: { params: ProjectParam },
			responses: { 200: json(z.array(WorkTag), "Tags") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			await guard(c, "read:work", id);
			const rows = await c.var.deps.db
				.select()
				.from(workTag)
				.where(eq(workTag.projectId, id))
				.orderBy(asc(workTag.name));
			return c.json(rows.map(tagDto), 200);
		},
	)
	.openapi(
		workMutation("tagCreate", {
			summary: "Create a tag (inline from a task needs only work)",
			request: { params: ProjectParam, ...body(WorkTagCreate) },
			responses: { 201: json(WorkTag, "Created") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			await guard(c, "work", id);
			const [row] = await c.var.deps.db
				.insert(workTag)
				.values({ projectId: id, name: input.name, color: input.color })
				.returning();
			pub(c, id, "tag");
			return c.json(tagDto(row as typeof workTag.$inferSelect), 201);
		},
	)
	.openapi(
		workMutation("tagUpdate", {
			summary: "Rename or recolour a tag",
			request: { params: IdParam, ...body(WorkTagPatch) },
			responses: { 200: json(WorkTag, "Updated") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const t = await rowOr404(
				db.select().from(workTag).where(eq(workTag.id, id)),
				"tag",
			);
			await guard(c, "work:admin", t.projectId);
			const [row] = await db
				.update(workTag)
				.set(input)
				.where(eq(workTag.id, id))
				.returning();
			pub(c, t.projectId, "tag");
			return c.json(tagDto(row as typeof workTag.$inferSelect), 200);
		},
	)
	.openapi(
		workMutation(
			"tagDelete",
			{
				summary: "Delete a tag (removed from its tasks)",
				request: { params: IdParam },
				responses: NoContent,
			},
			true,
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const t = await rowOr404(
				db.select().from(workTag).where(eq(workTag.id, id)),
				"tag",
			);
			await guard(c, "work:admin", t.projectId);
			c.set("auditResourceId", id);
			await db.delete(workTag).where(eq(workTag.id, id));
			pub(c, t.projectId, "tag", "delete");
			return c.body(null, 204);
		},
	)
	// --- views ----------------------------------------------------------
	.openapi(
		workRoute("viewList", {
			summary: "Shared views plus the actor's personal ones",
			request: { params: ProjectParam },
			responses: { 200: json(z.array(WorkView), "Views") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { actor } = await guard(c, "read:work", id);
			await ensureWorkProject(c.var.deps.db, id);
			return c.json(
				(await visibleViews(c.var.deps.db, id, actor.userId)).map(viewDto),
				200,
			);
		},
	)
	.openapi(
		workMutation("viewCreate", {
			summary: "Create a shared (work:admin) or personal (work) view",
			request: { params: ProjectParam, ...body(WorkViewCreate) },
			responses: { 201: json(WorkView, "Created") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { actor } = await guard(
				c,
				input.shared ? "work:admin" : "work",
				id,
			);
			await ensureWorkProject(db, id);
			const ownerId = input.shared ? null : actor.userId;
			const count = await db.$count(
				workView,
				and(
					eq(workView.projectId, id),
					ownerId ? eq(workView.ownerId, ownerId) : isNull(workView.ownerId),
				),
			);
			const limit = input.shared ? LIMITS.sharedViews : LIMITS.personalViews;
			if (count >= limit)
				throw new Failure("bad_request", `at most ${limit} views of this kind`);
			if (input.listId)
				await rowOr404(
					db
						.select({ id: workList.id })
						.from(workList)
						.where(
							and(eq(workList.id, input.listId), eq(workList.projectId, id)),
						),
					"list",
				);
			const config = WorkViewConfig.parse(input.config ?? {});
			await checkViewFilter(db, id, config.filter);
			const isDefault = Boolean(input.isDefault && input.shared);
			const row = await db.transaction(async (tx) => {
				if (isDefault) await clearDefault(tx, id, input.listId ?? null);
				const [r] = await tx
					.insert(workView)
					.values({
						projectId: id,
						listId: input.listId ?? null,
						ownerId,
						name: input.name,
						kind: input.kind,
						config,
						isDefault,
						position: rankBetween(await lastPosition(tx, workView, id), null),
					})
					.returning();
				return r as typeof workView.$inferSelect;
			});
			pub(c, id, "view");
			return c.json(viewDto(row), 201);
		},
	)
	.openapi(
		workMutation("viewUpdate", {
			summary: "Rename or reconfigure a view",
			request: { params: IdParam, ...body(WorkViewPatch) },
			responses: { 200: json(WorkView, "Updated") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const v = await rowOr404(
				db.select().from(workView).where(eq(workView.id, id)),
				"view",
			);
			await guardView(c, v);
			const config = input.config
				? WorkViewConfig.parse({
						...WorkViewConfig.parse(v.config ?? {}),
						...input.config,
					})
				: undefined;
			if (config) await checkViewFilter(db, v.projectId, config.filter);
			const row = await db.transaction(async (tx) => {
				const isDefault =
					input.isDefault === undefined
						? undefined
						: input.isDefault && v.ownerId === null;
				if (isDefault) await clearDefault(tx, v.projectId, v.listId);
				const [r] = await tx
					.update(workView)
					.set({
						...(input.name ? { name: input.name } : {}),
						...(config ? { config } : {}),
						...(isDefault === undefined ? {} : { isDefault }),
					})
					.where(eq(workView.id, id))
					.returning();
				return r as typeof workView.$inferSelect;
			});
			pub(c, v.projectId, "view");
			return c.json(viewDto(row), 200);
		},
	)
	.openapi(
		workMutation("viewDelete", {
			summary: "Delete a view",
			request: { params: IdParam },
			responses: NoContent,
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const v = await rowOr404(
				db.select().from(workView).where(eq(workView.id, id)),
				"view",
			);
			await guardView(c, v);
			await db.delete(workView).where(eq(workView.id, id));
			pub(c, v.projectId, "view", "delete");
			return c.body(null, 204);
		},
	)
	.openapi(
		workMutation("viewOrder", {
			summary: "Reorder the shared views",
			request: { params: ProjectParam, ...body(WorkOrder) },
			responses: { 200: json(z.array(WorkView), "Views") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { ids } = c.req.valid("json");
			const { db } = c.var.deps;
			const { actor } = await guard(c, "work:admin", id);
			const shared = await db
				.select({ id: workView.id })
				.from(workView)
				.where(and(eq(workView.projectId, id), isNull(workView.ownerId)));
			assertSameSet(
				ids,
				shared.map((v) => v.id),
			);
			await reorder(db, workView, ids);
			pub(c, id, "view");
			return c.json(
				(await visibleViews(db, id, actor.userId)).map(viewDto),
				200,
			);
		},
	);

async function clearDefault(
	tx: DbOrTx,
	projectId: string,
	listId: string | null,
) {
	await tx
		.update(workView)
		.set({ isDefault: false })
		.where(
			and(
				eq(workView.projectId, projectId),
				isNull(workView.ownerId),
				listId ? eq(workView.listId, listId) : isNull(workView.listId),
			),
		);
}

async function setArchived(c: Context<Env>, id: string, archived: boolean) {
	const { db } = c.var.deps;
	const l = await rowOr404(
		db.select().from(workList).where(eq(workList.id, id)),
		"list",
	);
	await guard(c, "work:admin", l.projectId);
	const [row] = await db
		.update(workList)
		.set({ archivedAt: archived ? new Date() : null })
		.where(eq(workList.id, id))
		.returning();
	pub(c, l.projectId, "list");
	return c.json(listDto(row as typeof workList.$inferSelect), 200);
}
