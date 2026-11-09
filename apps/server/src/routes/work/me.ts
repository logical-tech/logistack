import { z } from "@hono/zod-openapi";
import { dueBuckets, WorkMyTasks } from "@logistack/contracts";
import { dueBucket } from "@logistack/core";
import { workTask, workTaskWatcher } from "@logistack/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { requireActor } from "../../actor.ts";
import { json, router } from "../../openapi.ts";
import {
	enrich,
	readableProjects,
	tasksFrom,
	viewerTz,
	workRoute,
} from "../../work/api.ts";

const MY_TASKS_MAX = 500;

export const meRoutes = router().openapi(
	workRoute("myTasks", {
		summary:
			"Open tasks assigned to me (and watched, with include=watching), by due bucket",
		request: { query: z.object({ include: z.string().optional() }) },
		responses: { 200: json(WorkMyTasks, "My tasks") },
	}),
	async (c) => {
		const watching = c.req.valid("query").include === "watching";
		const actor = requireActor(c);
		const { db } = c.var.deps;
		const projects = await readableProjects(c);
		const empty = {
			buckets: dueBuckets.map((bucket) => ({ bucket, items: [] })),
		};
		if (projects.length === 0) return c.json(empty, 200);
		const me = actor.userId;
		const mine = sql`exists (select 1 from work_task_assignee a where a.task_id = ${workTask.id} and a.user_id = ${me})`;
		const watched = sql`exists (select 1 from work_task_watcher w where w.task_id = ${workTask.id} and w.user_id = ${me} and not w.muted)`;
		const rows = await tasksFrom(db)
			.where(
				and(
					inArray(
						workTask.projectId,
						projects.map((p) => p.id),
					),
					isNull(workTask.archivedAt),
					sql`${workTask.listId} not in (select l.id from work_list l where l.archived_at is not null)`,
					sql`${workTask.statusId} in (select s.id from work_status s where s.category in ('backlog', 'active'))`,
					watching ? sql`(${mine} or ${watched})` : mine,
				),
			)
			.orderBy(
				sql`${workTask.dueDate} asc nulls last`,
				asc(workTask.position),
				asc(workTask.id),
			)
			.limit(MY_TASKS_MAX);
		const items = await enrich(
			db,
			rows,
			new Set(["assignees", "tags"] as const),
		);
		const watchedIds = new Set(
			rows.length
				? (
						await db
							.select({ id: workTaskWatcher.taskId })
							.from(workTaskWatcher)
							.where(
								and(
									eq(workTaskWatcher.userId, me),
									eq(workTaskWatcher.muted, false),
									inArray(
										workTaskWatcher.taskId,
										rows.map((r) => r.id),
									),
								),
							)
					).map((w) => w.id)
				: [],
		);
		const names = new Map(projects.map((p) => [p.id, p.name]));
		const tz = await viewerTz(c);
		const now = new Date();
		const buckets = dueBuckets.map((bucket) => ({
			bucket,
			items: items
				.filter((t) => dueBucket(t.dueDate, now, tz) === bucket)
				.map((t) => ({
					...t,
					projectName: names.get(t.projectId) ?? "",
					watching: watchedIds.has(t.id),
				})),
		}));
		return c.json({ buckets }, 200);
	},
);
