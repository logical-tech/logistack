import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/**
 * Opens (or with `null` closes) the task sheet over the current page through `?task=`, keeping the
 * rest of the URL. The search reducer is untyped because it runs on whatever route is showing.
 */
export function useOpenTask() {
	const navigate = useNavigate();
	return useCallback(
		(taskId: string | null) =>
			navigate({
				to: ".",
				search: (prev: Record<string, unknown>) => ({
					...prev,
					task: taskId ?? undefined,
				}),
			} as never),
		[navigate],
	);
}
