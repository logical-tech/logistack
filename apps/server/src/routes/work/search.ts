import { z } from "@hono/zod-openapi";
import { type WorkSearchHit, WorkSearchResult } from "@logistack/contracts";
import { workProject, workTask } from "@logistack/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { json, router } from "../../openapi.ts";
import {
	guard,
	readableProjects,
	type TaskRow,
	tasksFrom,
	workRoute,
} from "../../work/api.ts";

const MAX = 20;

export const searchRoutes = router().openapi(
	workRoute("search", {
		summary:
			"Find tasks by key, title prefix, text or comment text (20 at most)",
		request: {
			query: z.object({
				q: z.string().trim().min(1).max(200),
				projectId: z.string().optional(),
			}),
		},
		responses: { 200: json(WorkSearchResult, "Hits") },
	}),
	async (c) => {
		const { q, projectId } = c.req.valid("query");
		const { db } = c.var.deps;
		let projects = await readableProjects(c);
		if (projectId) {
			await guard(c, "read:work", projectId);
			projects = projects.filter((p) => p.id === projectId);
		}
		if (projects.length === 0) return c.json({ items: [] }, 200);
		const names = new Map(projects.map((p) => [p.id, p.name]));
		const scope = and(
			inArray(
				workTask.projectId,
				projects.map((p) => p.id),
			),
			isNull(workTask.archivedAt),
		);
		const hits: WorkSearchHit[] = [];
		const add = (rows: TaskRow[], match: WorkSearchHit["match"]) => {
			for (const t of rows)
				if (hits.length < MAX && !hits.some((h) => h.id === t.id))
					hits.push({
						id: t.id,
						key: t.key,
						title: t.title,
						statusId: t.statusId,
						projectId: t.projectId,
						projectName: names.get(t.projectId) ?? "",
						match,
					});
		};
		const key = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(q);
		if (key)
			add(
				await tasksFrom(db).where(
					and(
						scope,
						eq(workProject.key, (key[1] as string).toUpperCase()),
						eq(workTask.number, Number(key[2])),
					),
				),
				"key",
			);
		else if (projectId && /^\d{1,9}$/.test(q))
			add(
				await tasksFrom(db).where(and(scope, eq(workTask.number, Number(q)))),
				"key",
			);
		const like = `${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
		add(
			await tasksFrom(db)
				.where(and(scope, sql`${workTask.title} ilike ${like}`))
				.orderBy(desc(workTask.updatedAt))
				.limit(MAX),
			"title",
		);
		const query = sql`websearch_to_tsquery('simple', ${q})`;
		if (hits.length < MAX)
			add(
				await tasksFrom(db)
					.where(and(scope, sql`${workTask.search} @@ ${query}`))
					.orderBy(sql`ts_rank(${workTask.search}, ${query}) desc`)
					.limit(MAX),
				"text",
			);
		if (hits.length < MAX)
			add(
				await tasksFrom(db)
					.where(
						and(
							scope,
							sql`exists (select 1 from work_comment m where m.task_id = ${workTask.id} and m.deleted_at is null and m.search @@ ${query})`,
						),
					)
					.orderBy(desc(workTask.updatedAt))
					.limit(MAX),
				"comment",
			);
		return c.json({ items: hits }, 200);
	},
);
