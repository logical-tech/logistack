import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PluginFrame } from "@/components/plugins/plugin-frame";
import { pluginContributionsQuery } from "@/lib/api/plugins";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/plugin/$installId/$pageId/$",
)({
	component: PluginTab,
});

function PluginTab() {
	const { projectId, serviceId, installId, pageId, _splat } = Route.useParams();
	const { data } = useQuery(pluginContributionsQuery);
	const contribution = data?.find((c) => c.installId === installId);
	const page = contribution?.pages.find(
		(p) => p.id === pageId && p.location === "service-tab",
	);
	if (!data) return null;
	if (!contribution || !page)
		return (
			<EmptyState
				icon={Puzzle}
				title="This tab isn't available"
				description="The plugin that adds it was turned off or uninstalled."
			/>
		);
	return (
		<PluginFrame
			contribution={contribution}
			page={page}
			subpath={_splat ?? ""}
			context={{ serviceId, projectId }}
		/>
	);
}
