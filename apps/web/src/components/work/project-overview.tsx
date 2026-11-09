/* A project at a glance: are the services up, how far along is the work, what moved lately. */
import { Link } from "@tanstack/react-router";
import { LayoutTemplate, Link2, ListTodo, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
	useWorkHealth,
	useWorkLists,
	useWorkProjects,
	useWorkTasks,
	useWorkViews,
} from "@/lib/api/work-queries";
import { ServiceHealthList } from "./health";
import { isClosed, timeAgo } from "./lib";
import { viewRoute, type WorkBase } from "./links";
import { AvatarStack, ColorDot, StatusIcon, TaskKey } from "./parts";
import { ProjectHeader } from "./project-header";
import { ShareLinkDialog } from "./share/share-link-wizard";
import { useOpenTask } from "./task-sheet/open-task";
import { requestSaveAsTemplate } from "./templates/save-as-template-wizard";
import { useWorkProjectContext } from "./use-work-project";
import { useWorkSubscription } from "./use-work-subscription";
import type { WorkProjectContext } from "./views/types";
import { ProjectProgressCard } from "./workload/project-progress-card";

export function ProjectOverview({
	projectId,
	base,
}: {
	projectId: string;
	base: WorkBase;
}) {
	const { data: project, error } = useWorkProjectContext(projectId);
	useWorkSubscription(projectId);
	if (error)
		return (
			<Page>
				<EmptyState
					icon={ListTodo}
					title="This project's tasks didn't load"
					description={
						error instanceof Error ? error.message : "Try again in a moment."
					}
				/>
			</Page>
		);
	if (!project)
		return (
			<Page>
				<Skeleton className="mb-3 h-8 w-56" />
				<Skeleton className="mb-6 h-9 w-96" />
				<div className="grid gap-6 lg:grid-cols-2">
					<Skeleton className="h-64" />
					<Skeleton className="h-64" />
				</div>
			</Page>
		);
	return (
		<Page>
			<ProjectHeader project={project} base={base} current="overview" />
			<div
				id="work-view-panel"
				role="tabpanel"
				aria-labelledby="work-view-tab-overview"
				className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
			>
				<div className="grid content-start gap-6">
					<HealthCard projectId={projectId} />
					<ProjectProgressCard projectId={projectId} />
				</div>
				<div className="grid content-start gap-6">
					<ListsCard project={project} base={base} />
					<RecentCard project={project} />
				</div>
			</div>
		</Page>
	);
}

function HealthCard({ projectId }: { projectId: string }) {
	const { data: projects } = useWorkProjects();
	const item = projects?.find((p) => p.id === projectId);
	const { data, isLoading } = useWorkHealth(projectId);
	if (item && !item.hasServices) return null;
	return (
		<Panel title="Services" bodyClassName="p-4" id="work-health">
			{isLoading || !data ? (
				<Skeleton className="h-24" />
			) : data.services.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					Nothing is published for this project yet.
				</p>
			) : (
				<ServiceHealthList services={data.services} />
			)}
		</Panel>
	);
}

function ListsCard({
	project,
	base,
}: {
	project: WorkProjectContext;
	base: WorkBase;
}) {
	const { data: lists = [] } = useWorkLists(project.id);
	const { data: views = [] } = useWorkViews(project.id);
	const [sharing, setSharing] = useState<string | null>(null);
	const table = views.find((v) => v.kind === "table") ?? views[0];
	const canShare = project.canEdit && project.settings.allowShareLinks;
	return (
		<Panel title="Lists" id="work-lists">
			<ul className="divide-y">
				{lists
					.filter((l) => !l.archivedAt)
					.map((l) => (
						<li key={l.id} className="group/list relative flex items-center">
							{table ? (
								<Link
									to={viewRoute(base)}
									params={{ projectId: project.id, viewId: table.id }}
									search={{ list: l.id } as never}
									className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-2.5 text-sm outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
								>
									<ColorDot color={l.color} />
									<span className="truncate">{l.name}</span>
									<span className="ml-auto text-xs text-muted-foreground tabular">
										{l.openCount ?? 0} open
									</span>
								</Link>
							) : (
								<span className="flex flex-1 px-4 py-2.5 text-sm">
									{l.name}
								</span>
							)}
							{(canShare || project.canAdmin) && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label={`${l.name} actions`}
											className="mr-2 text-muted-foreground opacity-0 group-hover/list:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
										>
											<MoreHorizontal />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-52">
										{canShare && (
											<DropdownMenuItem onSelect={() => setSharing(l.id)}>
												<Link2 /> Share link…
											</DropdownMenuItem>
										)}
										{project.canAdmin && (
											<DropdownMenuItem
												onSelect={() =>
													requestSaveAsTemplate({
														source: { kind: "list", listId: l.id },
														projectId: project.id,
														defaultName: l.name,
													})
												}
											>
												<LayoutTemplate /> Save as template…
											</DropdownMenuItem>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</li>
					))}
			</ul>
			<ShareLinkDialog
				projectId={project.id}
				listId={sharing ?? undefined}
				open={sharing !== null}
				onOpenChange={(o) => !o && setSharing(null)}
			/>
		</Panel>
	);
}

function RecentCard({ project }: { project: WorkProjectContext }) {
	const openTask = useOpenTask();
	const { data } = useWorkTasks({
		projectId: project.id,
		sort: JSON.stringify([{ by: "updatedAt", dir: "desc" }]),
		include: "assignees",
		limit: 8,
	});
	const items = data?.pages[0]?.items.slice(0, 8) ?? [];
	return (
		<Panel title="Recently updated" id="work-recent">
			{items.length === 0 ? (
				<p className="px-4 py-6 text-sm text-muted-foreground">Nothing yet.</p>
			) : (
				<ul className="divide-y">
					{items.map((t) => {
						const status = project.statuses.find((s) => s.id === t.statusId);
						return (
							<li key={t.id}>
								<button
									type="button"
									onClick={() => openTask(t.id)}
									className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
								>
									<StatusIcon status={status} />
									<TaskKey value={t.key} className="w-16 shrink-0" />
									<span
										className={`min-w-0 flex-1 truncate ${isClosed(status) ? "text-muted-foreground line-through decoration-muted-foreground/40" : ""}`}
									>
										{t.title}
									</span>
									<AvatarStack
										people={project.people}
										ids={t.assigneeIds ?? []}
										max={2}
									/>
									<span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
										{timeAgo(t.updatedAt)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}
