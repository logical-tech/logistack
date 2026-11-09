import { useNavigate } from "@tanstack/react-router";
import { createContext, useCallback, useContext } from "react";

/**
 * Set by the full task page: inside it, opening another task (a subtask, the parent) moves to
 * that task's page instead of stacking a sheet over it.
 */
export const OpenTaskOverride = createContext<
	((taskId: string | null) => void) | null
>(null);

/**
 * Opens (or with `null` closes) the task sheet over the current page through `?task=`, keeping the
 * rest of the URL. The search reducer is untyped because it runs on whatever route is showing.
 */
export function useOpenTask() {
	const navigate = useNavigate();
	const override = useContext(OpenTaskOverride);
	const sheet = useCallback(
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
	return override ?? sheet;
}
