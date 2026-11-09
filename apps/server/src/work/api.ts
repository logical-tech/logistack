import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import {
	type EventType,
	FilterNode,
	type PermissionAction,
	PmNode,
	type RecurrenceRule,
	workRoutes as table,
	type WorkAttachment,
	type WorkChecklistItem,
	type WorkField,
	type WorkList,
	type WorkRouteName,
	type WorkStatus,
	type WorkTag,
	type WorkTaskListItem,
	type WorkView,
	WorkViewConfig,
} from "@logistack/contracts";
import { can, type Grant, type Resource } from "@logistack/core";
import {
	type Db,
	folder,
	instanceSettings,
	project,
	type workAttachment,
	type workChecklistItem,
	workComment,
	type workField,
	workFieldValue,
	type workList,
	workProject,
	type workStatus,
	type workTag,
	workTask,
	workTaskAssignee,
	workTaskTag,
	workUserPrefs,
	type workView,
} from "@logistack/db";
import {
	and,
	eq,
	getTableColumns,
	inArray,
	isNull,
	type SQL,
	sql,
} from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { type Actor, grantsFor, requireActor } from "../actor.ts";
import { type AuditAction, mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { envelope } from "../events.ts";
import { errors, security } from "../openapi.ts";
import { actorCan } from "../scope.ts";
import { checkWork, type DbOrTx } from "./context.ts";

/** Route plumbing, permission guards, DTO mappers and task loading shared by the Work routes. */

// Recursive schemas need a component name, or the OpenAPI generator recurses forever.
// `.openapi()` on a lazy schema also tags the instance its getter refers back to.
PmNode.openapi("WorkPmNode");
FilterNode.openapi("WorkFilterNode");

type Extra = Omit<RouteConfig, "method" | "path">;

/** An OpenAPI route whose method, path and operation id come from the contracts' `workRoutes` table. */
export function workRoute<const E extends Extra>(
	name: WorkRouteName,
	extra: E,
) {
	const r = table[name];
	return createRoute({
		...extra,
		method: r.method.toLowerCase() as "get",
		path: r.path.slice("/api".length).replace(/:(\w+)/g, "{$1}"),
		operationId: r.operationId,
		tags: ["work"],
		security,
		responses: { ...extra.responses, ...errors },
	});
}

// Section 15: only deletes and settings changes reach the audit log; denials and errors still do.
const skipAudit: MiddlewareHandler<Env> = async (c, next) => {
	c.set("audited", true);
	await next();
};

/** A mutating Work route; `audit` keeps its success rows in the audit log. */
export function workMutation<const E extends Extra>(
	name: WorkRouteName,
	extra: E,
	audit = false,
) {
	const op = table[name].operationId;
	const i = op.lastIndexOf("_");
	const route = workRoute(name, {
		...extra,
		middleware: audit ? [] : [skipAudit],
	});
	return mutation(`${op.slice(0, i)}.${op.slice(i + 1)}` as AuditAction, route);
}

/**
 * Checks `action` on the project and, for writes, that the project isn't archived
 * (an archived project's Work is read-only, section 4.8).
 */
export async function guard(
	c: Context<Env>,
	action: PermissionAction,
	projectId: string,
	write = action !== "read:work",
): Promise<{ actor: Actor; resource: Resource }> {
	const r = await checkWork(c, action, projectId);
	if (write) {
		const [p] = await c.var.deps.db
			.select({ archivedAt: project.archivedAt })
			.from(project)
			.where(eq(project.id, projectId));
		if (p?.archivedAt)
			throw new Failure(
				"conflict",
				"project archived: its tasks are read-only",
			);
	}
	return r;
}

/** A row by id or 404. */
export async function rowOr404<T>(rows: Promise<T[]>, what: string) {
	const [row] = await rows;
	if (!row) throw notFound(what);
	return row;
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// --- DTOs -----------------------------------------------------------------

export const statusDto = (s: typeof workStatus.$inferSelect): WorkStatus => ({
	id: s.id,
	projectId: s.projectId,
	name: s.name,
	color: s.color,
	category: s.category,
	position: s.position,
	wipLimit: s.wipLimit,
});

export const listDto = (
	l: typeof workList.$inferSelect,
	openCount?: number,
): WorkList => ({
	id: l.id,
	projectId: l.projectId,
	name: l.name,
	description: l.description ?? null,
	color: l.color ?? null,
	icon: l.icon,
	position: l.position,
	archivedAt: iso(l.archivedAt),
	...(openCount === undefined ? {} : { openCount }),
});

export const fieldDto = (f: typeof workField.$inferSelect): WorkField => ({
	id: f.id,
	projectId: f.projectId,
	listId: f.listId,
	name: f.name,
	kind: f.kind,
	config: f.config,
	required: f.required,
	description: f.description,
	position: f.position,
});

export const tagDto = (t: typeof workTag.$inferSelect): WorkTag => ({
	id: t.id,
	projectId: t.projectId,
	name: t.name,
	color: t.color,
});

export const viewDto = (v: typeof workView.$inferSelect): WorkView => ({
	id: v.id,
	projectId: v.projectId,
	listId: v.listId,
	ownerId: v.ownerId,
	name: v.name,
	kind: v.kind,
	// Seeded views store partial configs; defaults fill the rest.
	config: WorkViewConfig.parse(v.config ?? {}),
	position: v.position,
	isDefault: v.isDefault,
});

export const checklistDto = (
	i: typeof workChecklistItem.$inferSelect,
): WorkChecklistItem => ({
	id: i.id,
	taskId: i.taskId,
	text: i.text,
	done: i.done,
	doneBy: i.doneBy,
	doneAt: iso(i.doneAt),
	assigneeId: i.assigneeId,
	position: i.position,
});

export const attachmentDto = (
	a: typeof workAttachment.$inferSelect,
): WorkAttachment => ({
	id: a.id,
	projectId: a.projectId,
	taskId: a.taskId,
	commentId: a.commentId,
	inlineIn: a.inlineIn,
	uploaderId: a.uploaderId,
	name: a.name,
	contentType: a.contentType,
	size: a.size,
	width: a.width,
	height: a.height,
	url: `/api/work/attachments/${a.id}`,
	thumbUrl: a.thumbKey ? `/api/work/attachments/${a.id}?thumb=1` : null,
	createdAt: a.createdAt.toISOString(),
});

// --- Tasks ----------------------------------------------------------------

const { search: _search, ...taskColumns } = getTableColumns(workTask);

/** Open blockers exist: a blocker whose status is neither done nor cancelled. */
export const blockedSql = sql<boolean>`exists (select 1 from work_dependency d join work_task b on b.id = d.blocked_by_id join work_status s on s.id = b.status_id where d.task_id = ${workTask.id} and s.category not in ('done', 'cancelled'))`;

export const taskSelect = {
	...taskColumns,
	key: sql<string>`${workProject.key} || '-' || ${workTask.number}`,
	blocked: blockedSql,
};

/** `select <task + key + blocked> from work_task join work_project`. */
export const tasksFrom = (db: DbOrTx) =>
	db
		.select(taskSelect)
		.from(workTask)
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId));

export type TaskRow = Awaited<ReturnType<typeof tasksFrom>>[number];

export async function taskRow(db: DbOrTx, id: string) {
	return rowOr404(tasksFrom(db).where(eq(workTask.id, id)), "task");
}

export const taskIncludes = ["fields", "assignees", "tags", "counts"] as const;
export type TaskInclude = (typeof taskIncludes)[number];

export function itemDto(t: TaskRow): WorkTaskListItem {
	return {
		id: t.id,
		projectId: t.projectId,
		listId: t.listId,
		parentId: t.parentId,
		number: t.number,
		key: t.key,
		title: t.title,
		statusId: t.statusId,
		priority: t.priority,
		startDate: t.startDate,
		dueDate: t.dueDate,
		dueTime: t.dueTime ? t.dueTime.slice(0, 5) : null,
		isMilestone: t.isMilestone,
		estimateMinutes: t.estimateMinutes,
		position: t.position,
		recurring: t.recurrence !== null,
		createdBy: t.createdBy,
		completedAt: iso(t.completedAt),
		archivedAt: iso(t.archivedAt),
		createdAt: t.createdAt.toISOString(),
		updatedAt: t.updatedAt.toISOString(),
		blocked: Boolean(t.blocked),
	};
}

const group = <T, K extends string, V>(
	rows: T[],
	key: (r: T) => K,
	value: (r: T) => V,
) => {
	const m = new Map<K, V[]>();
	for (const r of rows) {
		const k = key(r);
		const list = m.get(k);
		if (list) list.push(value(r));
		else m.set(k, [value(r)]);
	}
	return m;
};

/** List items with the requested parts, in one query per part. */
export async function enrich(
	db: DbOrTx,
	rows: TaskRow[],
	include: ReadonlySet<TaskInclude>,
): Promise<WorkTaskListItem[]> {
	const ids = rows.map((r) => r.id);
	if (ids.length === 0) return [];
	const [assignees, tags, fields, counts] = await Promise.all([
		include.has("assignees")
			? db
					.select({ t: workTaskAssignee.taskId, u: workTaskAssignee.userId })
					.from(workTaskAssignee)
					.where(inArray(workTaskAssignee.taskId, ids))
					.orderBy(workTaskAssignee.assignedAt)
			: [],
		include.has("tags")
			? db
					.select({ t: workTaskTag.taskId, g: workTaskTag.tagId })
					.from(workTaskTag)
					.where(inArray(workTaskTag.taskId, ids))
			: [],
		include.has("fields")
			? db
					.select({
						t: workFieldValue.taskId,
						f: workFieldValue.fieldId,
						v: workFieldValue.value,
					})
					.from(workFieldValue)
					.where(inArray(workFieldValue.taskId, ids))
			: [],
		include.has("counts") ? taskCounts(db, ids) : new Map(),
	]);
	const a = group(
		assignees,
		(r) => r.t,
		(r) => r.u,
	);
	const g = group(
		tags,
		(r) => r.t,
		(r) => r.g,
	);
	const f = group(
		fields,
		(r) => r.t,
		(r) => [r.f, r.v] as const,
	);
	return rows.map((r) => ({
		...itemDto(r),
		...(include.has("assignees") ? { assigneeIds: a.get(r.id) ?? [] } : {}),
		...(include.has("tags") ? { tagIds: g.get(r.id) ?? [] } : {}),
		...(include.has("fields")
			? { fields: Object.fromEntries(f.get(r.id) ?? []) }
			: {}),
		...(include.has("counts") ? { counts: counts.get(r.id) } : {}),
	}));
}

const n = (v: unknown) => Number(v ?? 0);

async function taskCounts(db: DbOrTx, ids: string[]) {
	const list = sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	);
	const rows = await db.execute<{
		id: string;
		subtasks: string;
		subtasks_done: string;
		checklist: string;
		checklist_done: string;
		comments: string;
		attachments: string;
	}>(sql`select t.id,
		(select count(*) from work_task s where s.parent_id = t.id and s.archived_at is null) as subtasks,
		(select count(*) from work_task s join work_status st on st.id = s.status_id where s.parent_id = t.id and s.archived_at is null and st.category in ('done', 'cancelled')) as subtasks_done,
		(select count(*) from work_checklist_item i where i.task_id = t.id) as checklist,
		(select count(*) from work_checklist_item i where i.task_id = t.id and i.done) as checklist_done,
		(select count(*) from work_comment m where m.task_id = t.id and m.deleted_at is null) as comments,
		(select count(*) from work_attachment a where a.task_id = t.id and a.comment_id is null and a.deleted_at is null) as attachments
		from work_task t where t.id in (${list})`);
	return new Map(
		[...rows].map((r) => [
			r.id,
			{
				subtasks: n(r.subtasks),
				subtasksDone: n(r.subtasks_done),
				checklist: n(r.checklist),
				checklistDone: n(r.checklist_done),
				comments: n(r.comments),
				attachments: n(r.attachments),
			},
		]),
	);
}

/** Comments count of one task, for the full task. */
export async function commentCount(db: DbOrTx, taskId: string) {
	return db.$count(
		workComment,
		and(eq(workComment.taskId, taskId), isNull(workComment.deletedAt)),
	);
}

// --- People ---------------------------------------------------------------

/** Effective grants of org members, the way `/api/me` resolves them. */
export async function memberGrants(
	db: Db,
	organizationId: string,
	userIds: readonly string[],
): Promise<Map<string, Grant[]>> {
	const out = new Map<string, Grant[]>();
	for (const id of new Set(userIds)) {
		const g = await grantsFor(db, id, id, organizationId);
		if (g) out.set(id, g);
	}
	return out;
}

const hasGuestGrant = (grants: Grant[], resource: Resource) =>
	grants.some(
		(g) =>
			g.role === "guest" &&
			g.scope.kind === "project" &&
			g.scope.id === resource.projectId,
	);

/** Who may be assigned on the project: holders of `work`, plus guests when the project allows it. */
export function isAssignable(
	userId: string,
	grants: Grant[] | undefined,
	resource: Resource,
	guestsAssignable: boolean,
) {
	if (!grants) return false;
	const actor = { id: userId };
	if (can(actor, "work", resource, grants)) return true;
	return (
		guestsAssignable &&
		hasGuestGrant(grants, resource) &&
		can(actor, "read:work", resource, grants)
	);
}

export const isGuest = hasGuestGrant;

/** 400 unless every user may be assigned on the project. */
export async function assertAssignable(
	db: Db,
	resource: Resource,
	userIds: readonly string[],
) {
	if (userIds.length === 0) return;
	const [wp] = await db
		.select({ guestsAssignable: workProject.guestsAssignable })
		.from(workProject)
		.where(eq(workProject.projectId, resource.projectId as string));
	const grants = await memberGrants(db, resource.organizationId, userIds);
	const bad = userIds.filter(
		(u) =>
			!isAssignable(u, grants.get(u), resource, wp?.guestsAssignable ?? false),
	);
	if (bad.length)
		throw new Failure("bad_request", "these people can't be assigned here", {
			userIds: bad,
		});
}

// --- Projects -------------------------------------------------------------

export type ProjectRef = {
	id: string;
	name: string;
	folderId: string | null;
	archivedAt: Date | null;
	resource: Resource;
};

/** The organization's projects the actor holds `action` on, folder ancestry resolved. */
export async function readableProjects(
	c: Context<Env>,
	action: PermissionAction = "read:work",
): Promise<ProjectRef[]> {
	const actor = requireActor(c);
	const rows = await c.var.deps.db
		.select({
			id: project.id,
			name: project.name,
			folderId: project.folderId,
			parentFolderId: folder.parentId,
			archivedAt: project.archivedAt,
		})
		.from(project)
		.leftJoin(folder, eq(folder.id, project.folderId))
		.where(eq(project.organizationId, actor.organizationId))
		.orderBy(project.name);
	return rows
		.map((r) => ({
			id: r.id,
			name: r.name,
			folderId: r.folderId,
			archivedAt: r.archivedAt,
			resource: {
				type: "project",
				organizationId: actor.organizationId,
				folderIds: [r.parentFolderId, r.folderId].filter(
					(x): x is string => x !== null,
				),
				projectId: r.id,
			} satisfies Resource,
		}))
		.filter((p) => actorCan(actor, action, p.resource));
}

// --- Misc -----------------------------------------------------------------

/** `ids` exactly the set of `existing` ids (any order); 400 otherwise. */
export function assertSameSet(ids: readonly string[], existing: string[]) {
	const a = new Set(ids);
	if (a.size !== ids.length || a.size !== existing.length)
		throw new Failure("bad_request", "ids must list every item exactly once");
	for (const id of existing)
		if (!a.has(id)) throw new Failure("bad_request", `ids is missing ${id}`);
}

/** Publishes a `task.*` event after commit; a dropped event only misses a notification rule. */
export async function emitTaskEvent(
	c: Context<Env>,
	type: Extract<EventType, `task.${string}`>,
	task: { id: string; projectId: string; key: string; title: string },
	extra: { statusName?: string; assigneeIds?: string[] } = {},
) {
	const { db, bus } = c.var.deps;
	const actor = requireActor(c);
	const [s] = await db
		.select({ publicUrl: instanceSettings.publicUrl })
		.from(instanceSettings)
		.limit(1);
	const url = `${s?.publicUrl?.replace(/\/$/, "") ?? ""}/work/t/${task.key}`;
	await bus
		.publishEvent(
			envelope(
				type,
				actor.organizationId,
				{ type: "task", id: task.id },
				{
					projectId: task.projectId,
					taskKey: task.key,
					title: task.title,
					actorId: actor.userId,
					url,
					...extra,
				},
			),
		)
		.catch(() => {});
}

export const recurrenceOf = (r: unknown) =>
	(r ?? null) as RecurrenceRule | null;

/** `where` parts that are present. */
export const all = (...parts: (SQL | undefined)[]) =>
	and(...parts.filter((p): p is SQL => p !== undefined));

/** The viewer's time zone for dates and relative filters: their Work prefs, else UTC. */
export async function viewerTz(c: Context<Env>) {
	const actor = requireActor(c);
	const [p] = await c.var.deps.db
		.select({ tz: workUserPrefs.timezone })
		.from(workUserPrefs)
		.where(
			and(
				eq(workUserPrefs.userId, actor.userId),
				eq(workUserPrefs.organizationId, actor.organizationId),
			),
		);
	return p?.tz ?? "UTC";
}
