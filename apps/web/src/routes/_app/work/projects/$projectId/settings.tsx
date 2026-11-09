import { createFileRoute } from "@tanstack/react-router";
import { WorkSettings } from "@/components/work/settings/work-settings";

export const Route = createFileRoute("/_app/work/projects/$projectId/settings")(
	{
		staticData: { crumb: "Settings" },
		component: () => <WorkSettings projectId={Route.useParams().projectId} />,
	},
);
