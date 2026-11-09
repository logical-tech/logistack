import { createFileRoute } from "@tanstack/react-router";
import { ViewHost, viewSearch } from "@/components/work/view-host";

export const Route = createFileRoute(
	"/_app/work/projects/$projectId/v/$viewId",
)({
	validateSearch: viewSearch,
	component: () => {
		const { projectId, viewId } = Route.useParams();
		return <ViewHost projectId={projectId} viewId={viewId} base="work" />;
	},
});
