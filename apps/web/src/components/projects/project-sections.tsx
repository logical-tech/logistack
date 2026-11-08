import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SlidingTabs } from "@/components/sliding-tabs";
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
 * The project's sections: its services, then the tabs plugins add. Rendered only when a plugin
 * adds one, so a project without plugins looks as it always did.
 */
export function ProjectSections({
	projectId,
	value,
	tabs,
}: {
	projectId: ProjectId;
	/** `services`, or `plugin:<installId>:<pageId>`. */
	value: string;
	tabs: ReturnType<typeof useProjectPluginTabs>;
}) {
	const navigate = useNavigate();
	if (!tabs.length) return null;
	return (
		<div className="mb-6 border-b">
			<SlidingTabs
				label="Project sections"
				idPrefix="project"
				value={value}
				onChange={(id) => {
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
					...tabs.map((t) => ({ id: t.id, label: t.label })),
				]}
			/>
		</div>
	);
}
