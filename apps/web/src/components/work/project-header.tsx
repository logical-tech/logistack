/*
 * The top of every Work project page: title with health, the project's section tabs in the ops
 * shell, then Overview plus one tab per view and "+ View".
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import {
	ProjectSections,
	useProjectPluginTabs,
} from "@/components/projects/project-sections";
import { SlidingTabs } from "@/components/sliding-tabs";
import { Button } from "@/components/ui/button";
import type { ProjectId } from "@/lib/api/types";
import { useWorkProjects, useWorkViews } from "@/lib/api/work-queries";
import {
	overviewRoute,
	settingsRoute,
	viewRoute,
	type WorkBase,
} from "./links";
import { HealthPill, TaskKey } from "./parts";
import { useShortcut } from "./shortcuts";
import { ViewWizard } from "./view-wizard";
import { VIEW_KINDS } from "./views/registry";
import type { WorkProjectContext } from "./views/types";

export function ProjectHeader({
	project,
	base,
	current,
	actions,
}: {
	project: WorkProjectContext;
	base: WorkBase;
	/** `overview` or a view id. */
	current: string;
	actions?: React.ReactNode;
}) {
	const navigate = useNavigate();
	const { data: views = [] } = useWorkViews(project.id);
	const { data: projects } = useWorkProjects();
	const item = projects?.find((p) => p.id === project.id);
	const pluginTabs = useProjectPluginTabs();
	const [creating, setCreating] = useState(false);
	const params = { projectId: project.id };

	const go = (id: string) =>
		id === "overview"
			? navigate({ to: overviewRoute(base), params })
			: navigate({ to: viewRoute(base), params: { ...params, viewId: id } });

	// 1–4 switch to the view in that tab position.
	const nth = (n: number) => () => {
		const v = views[n - 1];
		if (v) go(v.id);
	};
	useShortcut("1", nth(1));
	useShortcut("2", nth(2));
	useShortcut("3", nth(3));
	useShortcut("4", nth(4));

	return (
		<>
			<PageHeader
				className="pb-4"
				title={
					<span className="flex items-center gap-2.5">
						{project.name}
						<TaskKey value={project.key} className="text-sm font-normal" />
					</span>
				}
				description={
					project.settings.archived ? (
						<span className="inline-flex items-center gap-1.5">
							<Archive className="size-3.5" aria-hidden /> Archived: tasks are
							read-only.
						</span>
					) : item?.hasServices ? (
						<HealthPill
							health={item.health}
							since={item.since}
							className="text-sm"
						/>
					) : base === "work" ? (
						"No services"
					) : undefined
				}
				actions={
					<>
						{actions}
						{project.canAdmin && (
							<Button variant="outline" asChild>
								<Link to={settingsRoute(base)} params={params}>
									<Settings2 data-icon="inline-start" />
									Settings
								</Link>
							</Button>
						)}
					</>
				}
			/>
			{base === "ops" && (
				<ProjectSections
					projectId={project.id as ProjectId}
					value="tasks"
					tabs={pluginTabs}
				/>
			)}
			<div className="mb-4 flex items-end gap-1 border-b">
				<SlidingTabs
					label="Views"
					idPrefix="work-view"
					value={current}
					onChange={go}
					items={[
						{ id: "overview", label: "Overview" },
						...views.map((v) => {
							const Icon = VIEW_KINDS[v.kind].icon;
							return {
								id: v.id,
								label: (
									<>
										<Icon
											className="size-3.5 text-muted-foreground"
											aria-hidden
										/>
										{v.name}
										{v.ownerId && <span className="sr-only">(personal)</span>}
									</>
								),
							};
						}),
					]}
				/>
				{project.canEdit && (
					<Button
						variant="ghost"
						size="sm"
						className="mb-1.5 shrink-0 text-muted-foreground"
						onClick={() => setCreating(true)}
					>
						<Plus data-icon="inline-start" />
						View
					</Button>
				)}
			</div>
			<ViewWizard
				open={creating}
				onOpenChange={setCreating}
				project={project}
				onCreated={(v) => go(v.id)}
			/>
		</>
	);
}
