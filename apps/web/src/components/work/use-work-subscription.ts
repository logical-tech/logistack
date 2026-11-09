/*
 * Realtime for a project's Work data (section 9): task upserts refetch the task and patch it into
 * cached lists, using core `matchesTask` to decide whether it enters or leaves each list; anything
 * structural invalidates the project's queries. The actor's own echoes are skipped.
 */
import type {
	FilterNode,
	WorkRealtimeMessage,
	WorkStatus,
	WorkTask,
	WorkTaskListItem,
	WorkTaskListQuery,
	WorkTaskPage,
} from "@logistack/contracts";
import { matchesTask } from "@logistack/core/work";
import {
	type InfiniteData,
	type QueryClient,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/api/access";
import { subscribeWork } from "@/lib/api/live";
import { patchCachedTask, workKeys } from "@/lib/api/work-queries";
import { matchable } from "./lib";

type Pages = InfiniteData<WorkTaskPage, string | null>;

/** Whether a cached list query would contain `task`, judged client-side. */
export function listWants(
	query: WorkTaskListQuery,
	task: WorkTaskListItem,
	statuses: WorkStatus[],
	me: string,
): boolean {
	if (query.projectId && query.projectId !== task.projectId) return false;
	if (query.listId && query.listId !== task.listId) return false;
	if (query.parentId && query.parentId !== task.parentId) return false;
	if (query.topLevel === "true" && task.parentId) return false;
	if (query.includeArchived !== "true" && task.archivedAt) return false;
	if (query.assignee === "me" && !(task.assigneeIds ?? []).includes(me))
		return false;
	const category = statuses.find((s) => s.id === task.statusId)?.category;
	if (
		query.includeClosed === "false" &&
		(category === "done" || category === "cancelled")
	)
		return false;
	if (query.viewId) return true; // the view's own filter is server-side; keep what's there
	if (!query.filter) return true;
	try {
		return matchesTask(
			JSON.parse(query.filter) as FilterNode,
			matchable(task, statuses),
			{
				me,
				now: new Date(),
				tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
			},
		);
	} catch {
		return true;
	}
}

/** Puts a fresh task into, or takes it out of, every cached list of its project. */
export function applyTaskToLists(
	qc: QueryClient,
	task: WorkTask,
	statuses: WorkStatus[],
	me: string,
) {
	patchCachedTask(qc, task.id, (t) => ({ ...t, ...task }));
	for (const [key, data] of qc.getQueriesData<Pages>({
		queryKey: workKeys.tasks(),
	})) {
		const query = key[2] as WorkTaskListQuery | undefined;
		if (!data || !query) continue;
		const has = data.pages.some((p) => p.items.some((t) => t.id === task.id));
		const wants = listWants(query, task, statuses, me);
		if (has && !wants)
			qc.setQueryData<Pages>(key, {
				...data,
				pages: data.pages.map((p) => ({
					...p,
					items: p.items.filter((t) => t.id !== task.id),
				})),
			});
		// A new arrival's place depends on the server's sort: refetch rather than guess.
		if (!has && wants)
			void qc.invalidateQueries({ queryKey: key, exact: true });
	}
}

export function useWorkSubscription(projectId: string | undefined) {
	const qc = useQueryClient();
	const { data: me } = useMe();
	const myId = me?.userId;
	useEffect(() => {
		if (!projectId) return;
		return subscribeWork(projectId, async (msg: WorkRealtimeMessage) => {
			const ownEcho =
				msg.actorId === myId && qc.isMutating({ mutationKey: undefined }) > 0;
			if (ownEcho) return;
			if (msg.entity === "task" && msg.taskIds?.length) {
				const statuses =
					qc.getQueryData<WorkStatus[]>(
						workKeys.projectPart(projectId, "statuses"),
					) ?? [];
				for (const id of msg.taskIds) {
					if (msg.op === "delete") {
						qc.removeQueries({ queryKey: workKeys.task(id) });
						void qc.invalidateQueries({ queryKey: workKeys.tasks() });
						continue;
					}
					try {
						const task = await api.work.tasks.get(id);
						qc.setQueryData(workKeys.task(id), task);
						applyTaskToLists(qc, task, statuses, myId ?? "");
					} catch {
						void qc.invalidateQueries({ queryKey: workKeys.tasks() });
					}
				}
				void qc.invalidateQueries({ queryKey: workKeys.me() });
				return;
			}
			if (msg.entity === "comment" && msg.taskIds)
				for (const id of msg.taskIds)
					void qc.invalidateQueries({
						queryKey: workKeys.taskPart(id, "activity"),
					});
			if (msg.entity === "health") {
				void qc.invalidateQueries({
					queryKey: workKeys.projectPart(projectId, "health"),
				});
				void qc.invalidateQueries({ queryKey: workKeys.projects() });
				return;
			}
			// Structural: statuses, fields, lists, tags, views, settings.
			void qc.invalidateQueries({ queryKey: workKeys.project(projectId) });
			void qc.invalidateQueries({ queryKey: workKeys.tasks() });
		});
	}, [projectId, qc, myId]);
}
