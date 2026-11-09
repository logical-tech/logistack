import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { ApiError, api } from "@/lib/api";

/** `/work/t/SHOP-42`: resolves the key (aliases too) and opens the task over its project. */
export const Route = createFileRoute("/_app/work/t/$key")({
	beforeLoad: async ({ params }) => {
		try {
			const t = await api.work.tasks.byKey(params.key.toUpperCase());
			throw redirect({
				to: "/work/projects/$projectId",
				params: { projectId: t.projectId },
				search: { task: t.taskId },
				replace: true,
			});
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
});
