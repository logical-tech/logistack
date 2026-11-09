import type { WorkTaskListItem } from "@logistack/contracts";
import type { DepEdge } from "@logistack/core/work";
import { useMemo } from "react";

/** Dependency edges among `tasks`, from the rows' `dependencies` (the list's `include=dependencies`). */
export function useDependencyEdges(
	tasks: readonly WorkTaskListItem[],
	enabled: boolean,
): DepEdge[] {
	return useMemo(
		() =>
			enabled
				? tasks.flatMap((t) =>
						(t.dependencies ?? []).map((d) => ({
							taskId: t.id,
							blockedById: d.blockedById,
							lagDays: d.lagDays,
						})),
					)
				: [],
		[tasks, enabled],
	);
}
