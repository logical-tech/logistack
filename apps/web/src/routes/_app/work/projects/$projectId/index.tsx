import { createFileRoute } from "@tanstack/react-router";
import { ProjectOverview } from "@/components/work/project-overview";

export const Route = createFileRoute("/_app/work/projects/$projectId/")({
	component: () => (
		<ProjectOverview projectId={Route.useParams().projectId} base="work" />
	),
});
