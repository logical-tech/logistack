import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { PluginFrame } from "@/components/plugins/plugin-frame";
import {
	ProjectSections,
	sectionPanel,
	useProjectPluginTabs,
	useSectionsShown,
} from "@/components/projects/project-sections";
import { pluginContributionsQuery } from "@/lib/api/plugins";
import { projectQuery } from "@/lib/api/projects";

export const Route = createFileRoute(
	"/_app/projects/$projectId/plugin/$installId/$pageId/$",
)({
	component: ProjectPluginTab,
});

function ProjectPluginTab() {
	const { projectId, installId, pageId, _splat } = Route.useParams();
	const { data: project } = useQuery(projectQuery(projectId));
	const { data } = useQuery(pluginContributionsQuery);
	const tabs = useProjectPluginTabs();
	const shown = useSectionsShown(tabs);
	const contribution = data?.find((c) => c.installId === installId);
	const page = contribution?.pages.find(
		(p) => p.id === pageId && p.location === "project-tab",
	);
	if (!data || !project) return null;
	const tab = `plugin:${installId}:${pageId}`;
	return (
		<Page className="max-w-6xl">
			<PageHeader
				title={project.name}
				description={project.description || undefined}
			/>
			<ProjectSections projectId={projectId} value={tab} tabs={tabs} />
			<div {...sectionPanel(shown, tab)}>
				{contribution && page ? (
					<PluginFrame
						contribution={contribution}
						page={page}
						subpath={_splat ?? ""}
						context={{ projectId }}
					/>
				) : (
					<EmptyState
						icon={Puzzle}
						title="This tab isn't available"
						description="The plugin that adds it was turned off or uninstalled."
					/>
				)}
			</div>
		</Page>
	);
}
