import type {
	WorkPerson,
	WorkStatus,
	WorkTaskListItem,
	WorkTaskListQuery,
	WorkViewConfig,
} from "@logistack/contracts";
import { useEffect, useMemo } from "react";
import {
	useWorkFields,
	useWorkLists,
	useWorkPeople,
	useWorkProject,
	useWorkStatuses,
	useWorkTags,
	useWorkTasks,
} from "@/lib/api/work-queries";

/** The task query a view runs: its effective filter, sort and closed/subtask switches. */
export function viewTaskQuery(
	projectId: string,
	config: WorkViewConfig,
	listId: string | undefined,
	extra: Partial<WorkTaskListQuery> = {},
): WorkTaskListQuery {
	return {
		projectId,
		listId,
		filter: config.filter ? JSON.stringify(config.filter) : undefined,
		sort: config.sort.length ? JSON.stringify(config.sort) : undefined,
		includeClosed: config.showClosed ? "true" : "false",
		topLevel: config.showSubtasks === "hidden" ? "true" : undefined,
		include: "fields,assignees,tags,counts",
		limit: 200,
		...extra,
	};
}

/** Every page of a task query, fetched eagerly (timeline and calendar need the whole set). */
export function useAllTasks(query: WorkTaskListQuery) {
	const q = useWorkTasks(query);
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
	useEffect(() => {
		if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);
	const tasks = useMemo(
		() => q.data?.pages.flatMap((p) => p.items) ?? [],
		[q.data],
	);
	return { tasks, pending: q.isPending, error: q.error, refetch: q.refetch };
}

/** Statuses, people, lists, tags, fields and settings of a project, indexed. */
export function useProjectMeta(projectId: string) {
	const project = useWorkProject(projectId).data;
	const statuses = useWorkStatuses(projectId).data;
	const people = useWorkPeople(projectId).data;
	const lists = useWorkLists(projectId).data;
	const tags = useWorkTags(projectId).data;
	const fields = useWorkFields(projectId).data;
	return useMemo(() => {
		const sorted = [...(statuses ?? [])].sort((a, b) =>
			a.position.localeCompare(b.position),
		);
		return {
			ready: !!statuses && !!people && !!lists,
			workingDays: project?.workingDays ?? 31,
			defaultListId: project?.defaultListId ?? lists?.[0]?.id ?? null,
			statuses: sorted,
			statusById: new Map<string, WorkStatus>(sorted.map((s) => [s.id, s])),
			people: people ?? [],
			personById: new Map<string, WorkPerson>(
				(people ?? []).map((p) => [p.userId, p]),
			),
			lists: [...(lists ?? [])]
				.filter((l) => !l.archivedAt)
				.sort((a, b) => a.position.localeCompare(b.position)),
			tags: tags ?? [],
			fields: fields ?? [],
		};
	}, [project, statuses, people, lists, tags, fields]);
}
export type ProjectMeta = ReturnType<typeof useProjectMeta>;

export const isClosedTask = (meta: ProjectMeta, t: WorkTaskListItem) => {
	const c = meta.statusById.get(t.statusId)?.category;
	return c === "done" || c === "cancelled";
};

/** Subtasks plus checklist done / total, or null when there is nothing to count. */
export function taskProgress(t: WorkTaskListItem): number | null {
	const c = t.counts;
	if (!c) return null;
	const total = c.subtasks + c.checklist;
	return total ? (c.subtasksDone + c.checklistDone) / total : null;
}

const SHORT = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});
/** `Nov 9` for a `YYYY-MM-DD`. */
export const shortDate = (date: string) =>
	SHORT.format(new Date(`${date}T00:00:00Z`));
