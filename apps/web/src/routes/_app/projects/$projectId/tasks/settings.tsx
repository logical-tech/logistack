import { createFileRoute } from "@tanstack/react-router";
import { WorkSettings } from "@/components/work/settings/work-settings";

export const Route = createFileRoute(
	"/_app/projects/$projectId/tasks/settings",
)({
	staticData: { crumb: "Task settings" },
	component: () => <WorkSettings projectId={Route.useParams().projectId} />,
});
