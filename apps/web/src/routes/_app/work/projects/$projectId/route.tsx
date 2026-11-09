import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { ApiError } from "@/lib/api";
import { workProjectQuery } from "@/lib/api/work-queries";

export const Route = createFileRoute("/_app/work/projects/$projectId")({
	loader: async ({ context, params }) => {
		try {
			const project = await context.queryClient.ensureQueryData(
				workProjectQuery(params.projectId),
			);
			return { crumb: project.name };
		} catch (e) {
			if (e instanceof ApiError && (e.status === 404 || e.status === 403))
				throw notFound();
			throw e;
		}
	},
	component: Outlet,
});
