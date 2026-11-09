import { createFileRoute } from "@tanstack/react-router";
import { ProjectOverview } from "@/components/work/project-overview";

export const Route = createFileRoute("/_app/projects/$projectId/tasks/")({
	staticData: { crumb: "Tasks" },
	component: () => (
		<ProjectOverview projectId={Route.useParams().projectId} base="ops" />
	),
});
