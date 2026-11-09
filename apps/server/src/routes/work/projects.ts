import { z } from "@hono/zod-openapi";
import {
	ProjectHealth,
	WorkPerson,
	WorkProject,
	WorkProjectListItem,
	WorkProjectSettingsPatch,
	WorkProjectSummary,
	WorkServiceName,
	workStatusCategories,
} from "@logistack/contracts";
import { localDate, startOfWeek } from "@logistack/core";
import {
	environment,
	folder,
	gitProvider,
	member,
	project,
	service,
	user,
	workAttachment,
	workKeyAlias,
	workList,
	workProject,
	workStatus,
	workTask,
} from "@logistack/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../../actor.ts";
import type { Env } from "../../env.ts";
import { Failure } from "../../errors.ts";
import { body, IdParam, json, router } from "../../openapi.ts";
import { actorCan } from "../../scope.ts";
import {
	guard,
	isAssignable,
	isGuest,
	memberGrants,
	readableProjects,
	workMutation,
	workRoute,
} from "../../work/api.ts";
import { ensureWorkProject, publishWork } from "../../work/context.ts";
import { visiblePeople } from "../../work/guests.ts";
import { healthOfProject, healthOfProjects } from "../../work/health.ts";

async function projectDto(
	c: Context<Env>,
	projectId: string,
	admin: boolean,
): Promise<WorkProject> {
	const wp = await ensureWorkProject(c.var.deps.db, projectId);
	const [p] = await c.var.deps.db
		.select({ name: project.name, archivedAt: project.archivedAt })
		.from(project)
		.where(eq(project.id, projectId));
	return {
		projectId,
		name: p?.name ?? "",
		key: wp.key,
		workingDays: wp.workingDays,
		timeTracking: wp.timeTracking,
		allowShareLinks: wp.allowShareLinks,
		guestsAssignable: wp.guestsAssignable,
		guestsCanCreate: wp.guestsCanCreate,
		defaultListId: wp.defaultListId,
		closingStatusId: wp.closingStatusId,
		timeLockedBefore: wp.timeLockedBefore,
		archived: p?.archivedAt != null,
		...(admin
			? { hiddenServiceIds: wp.hiddenServiceIds, repos: wp.repos }
			: {}),
	};
}

/** Services of the project's default environment (previews excluded). */
const defaultServices = (c: Context<Env>, projectId: string) =>
	c.var.deps.db
		.select({ id: service.id, name: service.name })
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.where(
			and(
				eq(environment.projectId, projectId),
				eq(environment.isDefault, true),
				isNull(environment.preview),
			),
		)
		.orderBy(asc(service.name));

const n = (v: unknown) => Number(v ?? 0);

export const projectRoutes = router()
	.openapi(
		workRoute("projectList", {
			summary: "Projects the actor can read Work on, with health and counts",
			responses: { 200: json(z.array(WorkProjectListItem), "Projects") },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const projects = await readableProjects(c);
			if (projects.length === 0) return c.json([], 200);
			const ids = projects.map((p) => p.id);
			const wps = new Map<string, string>();
			for (const id of ids) wps.set(id, (await ensureWorkProject(db, id)).key);
			const today = localDate(new Date());
			const monday = startOfWeek(today);
			const [folders, counts, withServices, health] = await Promise.all([
				db
					.select({
						id: folder.id,
						name: folder.name,
						parentId: folder.parentId,
					})
					.from(folder)
					.where(eq(folder.organizationId, actor.organizationId)),
				db.execute<Record<string, string>>(sql`select t.project_id,
					count(*) filter (where s.category in ('backlog', 'active')) as open,
					count(*) filter (where s.category in ('backlog', 'active') and t.due_date < ${today}) as overdue,
					count(*) filter (where s.category in ('backlog', 'active') and exists (select 1 from work_task_assignee a where a.task_id = t.id and a.user_id = ${actor.userId})) as mine,
					count(*) filter (where s.category = 'done' and t.completed_at >= ${monday}::date) as done_this_week
					from work_task t join work_status s on s.id = t.status_id
					where t.archived_at is null and t.project_id in (${sql.join(
						ids.map((id) => sql`${id}`),
						sql`, `,
					)})
					group by t.project_id`),
				db
					.selectDistinct({ projectId: environment.projectId })
					.from(service)
					.innerJoin(environment, eq(environment.id, service.environmentId))
					.where(
						and(
							inArray(environment.projectId, ids),
							isNull(environment.preview),
						),
					),
				healthOfProjects(db, ids),
			]);
			const folderOf = new Map(folders.map((f) => [f.id, f]));
			const pathOf = (folderId: string | null): string[] => {
				const f = folderId ? folderOf.get(folderId) : undefined;
				return f ? [...pathOf(f.parentId), f.name] : [];
			};
			const countOf = new Map([...counts].map((r) => [r.project_id, r]));
			const hasServices = new Set(withServices.map((r) => r.projectId));
			const items = projects.map((p) => {
				const k = countOf.get(p.id);
				const h = health.get(p.id);
				return {
					id: p.id,
					name: p.name,
					folderPath: pathOf(p.folderId),
					key: wps.get(p.id) as string,
					health: h?.health ?? "unknown",
					since: h?.since ?? null,
					hasServices: hasServices.has(p.id),
					counts: {
						open: n(k?.open),
						overdue: n(k?.overdue),
						mine: n(k?.mine),
						doneThisWeek: n(k?.done_this_week),
					},
					archived: p.archivedAt !== null,
				};
			});
			items.sort((a, b) =>
				[...a.folderPath, a.name]
					.join("\u0000")
					.localeCompare([...b.folderPath, b.name].join("\u0000")),
			);
			return c.json(items, 200);
		},
	)
	.openapi(
		workRoute("projectGet", {
			summary: "Work settings of a project visible to every reader",
			request: { params: IdParam },
			responses: { 200: json(WorkProject, "Project") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { actor, resource } = await guard(c, "read:work", id);
			return c.json(
				await projectDto(c, id, actorCan(actor, "work:admin", resource)),
				200,
			);
		},
	)
	.openapi(
		workMutation(
			"projectSettings",
			{
				summary: "Change a project's Work settings",
				request: { params: IdParam, ...body(WorkProjectSettingsPatch) },
				responses: { 200: json(WorkProject, "Updated") },
			},
			true,
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { actor } = await guard(c, "work:admin", id);
			const wp = await ensureWorkProject(db, id);
			const belongs = async (
				ids: readonly string[],
				rows: Promise<{ id: string }[]>,
				what: string,
			) => {
				const have = new Set((await rows).map((r) => r.id));
				const bad = ids.filter((x) => !have.has(x));
				if (bad.length)
					throw new Failure("bad_request", `${what} not in this project`, {
						ids: bad,
					});
			};
			if (input.hiddenServiceIds?.length)
				await belongs(
					input.hiddenServiceIds,
					db
						.select({ id: service.id })
						.from(service)
						.innerJoin(environment, eq(environment.id, service.environmentId))
						.where(eq(environment.projectId, id)),
					"services",
				);
			if (input.defaultListId)
				await belongs(
					[input.defaultListId],
					db
						.select({ id: workList.id })
						.from(workList)
						.where(eq(workList.projectId, id)),
					"list",
				);
			if (input.closingStatusId)
				await belongs(
					[input.closingStatusId],
					db
						.select({ id: workStatus.id })
						.from(workStatus)
						.where(eq(workStatus.projectId, id)),
					"status",
				);
			if (input.repos?.length)
				await belongs(
					input.repos.map((r) => r.providerId),
					db
						.select({ id: gitProvider.id })
						.from(gitProvider)
						.where(eq(gitProvider.organizationId, actor.organizationId)),
					"git providers",
				);
			await db.transaction(async (tx) => {
				if (input.key && input.key !== wp.key) {
					const [taken] = await tx
						.select({ id: workProject.projectId })
						.from(workProject)
						.where(
							and(
								eq(workProject.organizationId, actor.organizationId),
								eq(workProject.key, input.key),
							),
						);
					if (taken)
						throw new Failure("conflict", `key ${input.key} is already used`);
					// The old key keeps resolving; a key taken back stops being an alias.
					await tx
						.insert(workKeyAlias)
						.values({
							organizationId: actor.organizationId,
							key: wp.key,
							projectId: id,
						})
						.onConflictDoUpdate({
							target: [workKeyAlias.organizationId, workKeyAlias.key],
							set: { projectId: id },
						});
					await tx
						.delete(workKeyAlias)
						.where(
							and(
								eq(workKeyAlias.organizationId, actor.organizationId),
								eq(workKeyAlias.key, input.key),
							),
						);
				}
				await tx
					.update(workProject)
					.set(input)
					.where(eq(workProject.projectId, id));
			});
			c.set("auditResourceId", id);
			publishWork(c.var.deps, {
				organizationId: actor.organizationId,
				projectId: id,
				entity: "project",
				op: "upsert",
				actorId: actor.userId,
			});
			return c.json(await projectDto(c, id, true), 200);
		},
	)
	.openapi(
		workRoute("projectHealth", {
			summary: "Simplified service health of a project",
			request: { params: IdParam },
			responses: { 200: json(ProjectHealth, "Health") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			await guard(c, "read:work", id);
			return c.json(await healthOfProject(c.var.deps.db, id), 200);
		},
	)
	.openapi(
		workRoute("projectSummary", {
			summary: "Task counts per status, assignee and week",
			request: { params: IdParam },
			responses: { 200: json(WorkProjectSummary, "Summary") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			await guard(c, "read:work", id);
			await ensureWorkProject(db, id);
			const today = localDate(new Date());
			const firstWeek = startOfWeek(
				new Date(Date.parse(today) - 77 * 86_400_000)
					.toISOString()
					.slice(0, 10),
			);
			const live = and(eq(workTask.projectId, id), isNull(workTask.archivedAt));
			const [byStatus, byAssignee, weeks, lists, attachments] =
				await Promise.all([
					db
						.select({
							statusId: workTask.statusId,
							category: workStatus.category,
							count: sql<number>`count(*)::int`,
						})
						.from(workTask)
						.innerJoin(workStatus, eq(workStatus.id, workTask.statusId))
						.where(live)
						.groupBy(workTask.statusId, workStatus.category),
					db.execute<{ user_id: string | null; open: string; done: string }>(
						sql`select a.user_id,
							count(*) filter (where s.category in ('backlog', 'active')) as open,
							count(*) filter (where s.category = 'done') as done
							from work_task t join work_status s on s.id = t.status_id
							left join work_task_assignee a on a.task_id = t.id
							where t.project_id = ${id} and t.archived_at is null
							group by a.user_id`,
					),
					db.execute<{ week: string; count: string }>(
						sql`select to_char(date_trunc('week', t.completed_at at time zone 'UTC'), 'YYYY-MM-DD') as week, count(*) as count
							from work_task t join work_status s on s.id = t.status_id
							where t.project_id = ${id} and s.category = 'done' and t.completed_at >= ${firstWeek}::date
							group by 1`,
					),
					db.$count(
						workList,
						and(eq(workList.projectId, id), isNull(workList.archivedAt)),
					),
					db.$count(
						workAttachment,
						and(
							eq(workAttachment.projectId, id),
							isNull(workAttachment.deletedAt),
						),
					),
				]);
			const overdue = await db.$count(
				workTask,
				sql`${live} and ${workTask.dueDate} < ${today} and ${workTask.statusId} in (select id from work_status where category in ('backlog', 'active'))`,
			);
			const byCategory = Object.fromEntries(
				workStatusCategories.map((k) => [
					k,
					byStatus
						.filter((s) => s.category === k)
						.reduce((a, s) => a + s.count, 0),
				]),
			) as WorkProjectSummary["byCategory"];
			const weekCount = new Map([...weeks].map((w) => [w.week, n(w.count)]));
			return c.json(
				{
					total: byStatus.reduce((a, s) => a + s.count, 0),
					byStatus: byStatus.map((s) => ({
						statusId: s.statusId,
						count: s.count,
					})),
					byCategory,
					byAssignee: [...byAssignee].map((r) => ({
						userId: r.user_id,
						open: n(r.open),
						done: n(r.done),
					})),
					overdue,
					completedPerWeek: Array.from({ length: 12 }, (_, i) => {
						const weekStart = new Date(
							Date.parse(firstWeek) + i * 7 * 86_400_000,
						)
							.toISOString()
							.slice(0, 10);
						return { weekStart, count: weekCount.get(weekStart) ?? 0 };
					}),
					lists,
					attachments,
				},
				200,
			);
		},
	)
	.openapi(
		workRoute("projectPeople", {
			summary: "Members who can read Work on the project",
			request: { params: IdParam },
			responses: { 200: json(z.array(WorkPerson), "People") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const { actor, resource } = await guard(c, "read:work", id);
			const wp = await ensureWorkProject(db, id);
			const members = await db
				.select({
					userId: user.id,
					name: user.name,
					email: user.email,
					avatar: user.image,
				})
				.from(member)
				.innerJoin(user, eq(user.id, member.userId))
				.where(eq(member.organizationId, actor.organizationId))
				.orderBy(asc(user.name));
			const grants = await memberGrants(
				db,
				actor.organizationId,
				members.map((m) => m.userId),
			);
			const showEmail = actorCan(actor, "work", resource);
			const visible = await visiblePeople(db, actor);
			const people = members.flatMap((m) => {
				const g = grants.get(m.userId);
				if (
					!g ||
					(visible && !visible.has(m.userId)) ||
					!actorCan(
						{ ...actor, id: m.userId, grants: g, keyScopes: undefined },
						"read:work",
						resource,
					)
				)
					return [];
				return [
					{
						userId: m.userId,
						name: m.name,
						...(showEmail ? { email: m.email } : {}),
						avatar: m.avatar,
						assignable: isAssignable(
							m.userId,
							g,
							resource,
							wp.guestsAssignable,
						),
						guest: isGuest(g, resource),
					},
				];
			});
			return c.json(people, 200);
		},
	)
	.openapi(
		workRoute("projectServices", {
			summary: "Service names, for the hidden-services picker",
			request: { params: IdParam },
			responses: { 200: json(z.array(WorkServiceName), "Services") },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			await guard(c, "work:admin", id, false);
			return c.json(await defaultServices(c, id), 200);
		},
	);
