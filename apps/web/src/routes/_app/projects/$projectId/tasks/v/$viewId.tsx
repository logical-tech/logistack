import { createFileRoute } from "@tanstack/react-router";
import { ViewHost, viewSearch } from "@/components/work/view-host";

export const Route = createFileRoute(
	"/_app/projects/$projectId/tasks/v/$viewId",
)({
	validateSearch: viewSearch,
	staticData: { crumb: "Tasks" },
	component: () => {
		const { projectId, viewId } = Route.useParams();
		return <ViewHost projectId={projectId} viewId={viewId} base="ops" />;
	},
});
