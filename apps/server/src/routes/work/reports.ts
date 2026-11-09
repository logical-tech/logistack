import {
	type WorkWorkload as Workload,
	WorkWorkload,
	WorkWorkloadQuery,
} from "@logistack/contracts";
import { addDays, isWorkingDay, localDate, startOfWeek } from "@logistack/core";
import {
	user,
	workProject,
	workStatus,
	workTask,
	workTaskAssignee,
	workUserPrefs,
} from "@logistack/db";
import {
	and,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	notInArray,
	sql,
} from "drizzle-orm";
import { requireActor } from "../../actor.ts";
import { errors, json, router } from "../../openapi.ts";
import { actorCan, locate } from "../../scope.ts";
import { checkWork } from "../../work/context.ts";
import { spec } from "./extras-a-spec.ts";

const DEFAULT_CAPACITY_HOURS = 32;

/** Open task minutes spread evenly over its working days (start → due, due alone without a start), split between assignees. */
export function spreadTask(
	t: {
		startDate: string | null;
		dueDate: string;
		estimateMinutes: number;
		assignees: number;
	},
	workingDays: number,
): Map<string, number> {
	const days: string[] = [];
	for (let d = t.startDate ?? t.dueDate; d <= t.dueDate; d = addDays(d, 1))
		if (isWorkingDay(d, workingDays)) days.push(d);
	if (!days.length) days.push(t.dueDate);
	const per = t.estimateMinutes / days.length / Math.max(1, t.assignees);
	const out = new Map<string, number>();
	for (const d of days) {
		const w = startOfWeek(d);
		out.set(w, (out.get(w) ?? 0) + per);
	}
	return out;
}

export const workReports = router().openapi(
	spec("workload", {
		summary: "Estimated minutes per person and week over the next weeks",
		request: { query: WorkWorkloadQuery },
		responses: { 200: json(WorkWorkload, "Workload"), ...errors },
	}),
	async (c) => {
		const q = c.req.valid("query");
		const actor = requireActor(c);
		const { db } = c.var.deps;
		const weeksN = q.weeks ?? 6;
		const from = startOfWeek(q.from ?? localDate(new Date(), "UTC"));
		const weeks = Array.from({ length: weeksN }, (_, i) =>
			addDays(from, i * 7),
		);
		const end = addDays(from, weeksN * 7 - 1);

		let projectIds: string[];
		if (q.projectIds) {
			projectIds = [...new Set(q.projectIds.split(",").filter(Boolean))];
			for (const id of projectIds) await checkWork(c, "read:work", id);
		} else {
			projectIds = [];
			for (const p of await db
				.select({ id: workProject.projectId })
				.from(workProject)
				.where(eq(workProject.organizationId, actor.organizationId)))
				if (
					actorCan(
						actor,
						"read:work",
						await locate(db, actor.organizationId, "project", p.id),
					)
				)
					projectIds.push(p.id);
		}
		const empty: Workload = { weeks, people: [] };
		if (!projectIds.length) return c.json(empty, 200);

		const tasks = await db
			.select({
				id: workTask.id,
				startDate: workTask.startDate,
				dueDate: workTask.dueDate,
				estimateMinutes: workTask.estimateMinutes,
				workingDays: workProject.workingDays,
			})
			.from(workTask)
			.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
			.innerJoin(workStatus, eq(workStatus.id, workTask.statusId))
			.where(
				and(
					inArray(workTask.projectId, projectIds),
					isNull(workTask.archivedAt),
					notInArray(workStatus.category, ["done", "cancelled"]),
					isNotNull(workTask.dueDate),
					gt(workTask.estimateMinutes, 0),
					gte(workTask.dueDate, from),
					lte(sql`coalesce(${workTask.startDate}, ${workTask.dueDate})`, end),
				),
			);
		if (!tasks.length) return c.json(empty, 200);
		const assigned = await db
			.select({
				taskId: workTaskAssignee.taskId,
				userId: workTaskAssignee.userId,
			})
			.from(workTaskAssignee)
			.where(
				inArray(
					workTaskAssignee.taskId,
					tasks.map((t) => t.id),
				),
			);
		const byTask = new Map<string, string[]>();
		for (const a of assigned)
			byTask.set(a.taskId, [...(byTask.get(a.taskId) ?? []), a.userId]);

		/** userId → weekStart → { minutes, taskIds } */
		const grid = new Map<
			string,
			Map<string, { minutes: number; taskIds: Set<string> }>
		>();
		for (const t of tasks) {
			const people = byTask.get(t.id) ?? [];
			if (!people.length || !t.dueDate || !t.estimateMinutes) continue;
			const spread = spreadTask(
				{
					startDate: t.startDate,
					dueDate: t.dueDate,
					estimateMinutes: t.estimateMinutes,
					assignees: people.length,
				},
				t.workingDays,
			);
			for (const userId of people) {
				const row = grid.get(userId) ?? new Map();
				grid.set(userId, row);
				for (const [week, minutes] of spread) {
					if (week < from || week > end) continue;
					const cell = row.get(week) ?? {
						minutes: 0,
						taskIds: new Set<string>(),
					};
					cell.minutes += minutes;
					cell.taskIds.add(t.id);
					row.set(week, cell);
				}
			}
		}
		const userIds = [...grid.keys()];
		if (!userIds.length) return c.json(empty, 200);
		const [users, prefs] = await Promise.all([
			db
				.select({ id: user.id, name: user.name, image: user.image })
				.from(user)
				.where(inArray(user.id, userIds)),
			db
				.select({
					userId: workUserPrefs.userId,
					hours: workUserPrefs.capacityHoursPerWeek,
				})
				.from(workUserPrefs)
				.where(
					and(
						eq(workUserPrefs.organizationId, actor.organizationId),
						inArray(workUserPrefs.userId, userIds),
					),
				),
		]);
		const capacity = new Map(prefs.map((p) => [p.userId, p.hours]));
		const result: Workload = {
			weeks,
			people: users
				.map((u) => ({
					userId: u.id,
					name: u.name,
					avatar: u.image ?? null,
					capacityMinutes: (capacity.get(u.id) ?? DEFAULT_CAPACITY_HOURS) * 60,
					cells: weeks.map((w) => {
						const cell = grid.get(u.id)?.get(w);
						return {
							weekStart: w,
							minutes: Math.round(cell?.minutes ?? 0),
							taskIds: [...(cell?.taskIds ?? [])],
						};
					}),
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
		};
		return c.json(result, 200);
	},
);
