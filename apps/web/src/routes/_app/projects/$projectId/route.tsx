import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { ApiError } from "@/lib/api";
import { projectQuery } from "@/lib/api/projects";
import type { ProjectId } from "@/lib/api/types";

export const Route = createFileRoute("/_app/projects/$projectId")({
	params: {
		parse: ({ projectId }) => {
			if (!projectId.startsWith("prj_")) throw notFound();
			return { projectId: projectId as ProjectId };
		},
		stringify: ({ projectId }) => ({ projectId }),
	},
	loader: async ({ context, params }) => {
		try {
			const project = await context.queryClient.ensureQueryData(
				projectQuery(params.projectId),
			);
			return { crumb: project.name };
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
	component: Outlet,
});
