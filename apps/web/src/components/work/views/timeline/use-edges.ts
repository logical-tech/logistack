import type { WorkTask, WorkTaskListItem } from "@logistack/contracts";
import type { DepEdge } from "@logistack/core/work";
import { useQueries } from "@tanstack/react-query";
import { workTaskQuery } from "@/lib/api/work-queries";

/**
 * Dependency edges among `tasks`, read from each task's detail.
 * shortcut: one request per task because list rows carry no edges; add
 * `include=dependencies` to the task list when projects get large.
 */
export function useDependencyEdges(
	tasks: readonly WorkTaskListItem[],
	enabled: boolean,
): DepEdge[] {
	return useQueries({
		queries: tasks.map((t) => ({
			...workTaskQuery(t.id),
			enabled,
			staleTime: 30_000,
		})),
		combine: (results) => {
			const out: DepEdge[] = [];
			for (const r of results) {
				const d = r.data as WorkTask | undefined;
				if (!d) continue;
				for (const e of d.dependencies.blockedBy)
					out.push({ taskId: d.id, blockedById: e.id, lagDays: e.lagDays });
			}
			return out;
		},
	});
}
