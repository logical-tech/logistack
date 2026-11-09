import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SlidingTabs } from "@/components/sliding-tabs";
import { useSurfaces } from "@/components/work/shell/work-nav";
import { pluginContributionsQuery } from "@/lib/api/plugins";
import type { ProjectId } from "@/lib/api/types";

/** Plugin pages with `location: "project-tab"`, one tab each. */
export function useProjectPluginTabs() {
	const { data } = useQuery(pluginContributionsQuery);
	return (data ?? []).flatMap((c) =>
		c.pages
			.filter((p) => p.location === "project-tab")
			.map((p) => ({
				id: `plugin:${c.installId}:${p.id}`,
				label: p.title,
				installId: c.installId,
				pageId: p.id,
			})),
	);
}

/** Whether the section tabs show: a plugin adds a tab, or the actor uses Work (the Tasks tab). */
export function useSectionsShown(
	tabs: ReturnType<typeof useProjectPluginTabs>,
) {
	return useSurfaces().work || tabs.length > 0;
}

/** Panel attributes for the content under the section tabs; none when there are no tabs. */
export const sectionPanel = (show: boolean, tab: string) =>
	show
		? {
				id: "project-panel",
				role: "tabpanel",
				"aria-labelledby": `project-tab-${tab}`,
			}
		: {};

/**
 * The project's sections: its services, its tasks (Work), then the tabs plugins add. Rendered only
 * when there is more than Services, so a project without them looks as it always did.
 */
export function ProjectSections({
	projectId,
	value,
	tabs,
}: {
	projectId: ProjectId;
	/** `services`, `tasks`, or `plugin:<installId>:<pageId>`. */
	value: string;
	tabs: ReturnType<typeof useProjectPluginTabs>;
}) {
	const navigate = useNavigate();
	const { work } = useSurfaces();
	if (!useSectionsShown(tabs)) return null;
	return (
		<div className="mb-6 border-b">
			<SlidingTabs
				label="Project sections"
				idPrefix="project"
				value={value}
				onChange={(id) => {
					if (id === "tasks") {
						navigate({
							to: "/projects/$projectId/tasks",
							params: { projectId },
						});
						return;
					}
					const plugin = tabs.find((t) => t.id === id);
					if (!plugin) {
						navigate({ to: "/projects/$projectId", params: { projectId } });
						return;
					}
					navigate({
						to: "/projects/$projectId/plugin/$installId/$pageId/$",
						params: {
							projectId,
							installId: plugin.installId,
							pageId: plugin.pageId,
							_splat: "",
						},
					});
				}}
				items={[
					{ id: "services", label: "Services" },
					...(work ? [{ id: "tasks", label: "Tasks" }] : []),
					...tabs.map((t) => ({ id: t.id, label: t.label })),
				]}
			/>
		</div>
	);
}
