import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { TaskPage } from "@/components/work/task-sheet/task-sheet";
import { ApiError, api } from "@/lib/api";

/**
 * `/work/t/SHOP-42`: the task as a full page. The param is a key (aliases resolve too) or a task
 * id, which links between tasks inside the page use; an id redirects to its key, the address
 * people share.
 */
export const Route = createFileRoute("/_app/work/t/$key")({
	loader: async ({ params }) => {
		try {
			if (params.key.startsWith("tsk_")) {
				const t = await api.work.tasks.get(params.key);
				throw redirect({
					to: "/work/t/$key",
					params: { key: t.key },
					replace: true,
				});
			}
			const t = await api.work.tasks.byKey(params.key.toUpperCase());
			return { taskId: t.taskId };
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
	staticData: { crumb: "Task" },
	component: function TaskRoute() {
		const { taskId } = Route.useLoaderData();
		return <TaskPage taskId={taskId} />;
	},
});
