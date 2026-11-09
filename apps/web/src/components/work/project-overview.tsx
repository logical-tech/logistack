/* A project at a glance: are the services up, how far along is the work, what moved lately. */
import { Link } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import {
	useWorkHealth,
	useWorkLists,
	useWorkProjects,
	useWorkSummary,
	useWorkTasks,
	useWorkViews,
} from "@/lib/api/work-queries";
import { ServiceHealthList } from "./health";
import { isClosed, timeAgo } from "./lib";
import { viewRoute, type WorkBase } from "./links";
import { AvatarStack, ColorDot, StatusIcon, TaskKey } from "./parts";
import { ProjectHeader } from "./project-header";
import { useOpenTask } from "./task-sheet/open-task";
import { useWorkProjectContext } from "./use-work-project";
import { useWorkSubscription } from "./use-work-subscription";
import type { WorkProjectContext } from "./views/types";

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
					<ProgressCard project={project} />
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

const CATEGORY = [
	["done", "Done", "bg-ok"],
	["active", "In progress", "bg-info"],
	["backlog", "Not started", "bg-muted-foreground/30"],
	["cancelled", "Cancelled", "bg-muted-foreground/15"],
] as const;

function ProgressCard({ project }: { project: WorkProjectContext }) {
	const { data } = useWorkSummary(project.id);
	if (!data) return <Skeleton className="h-48" />;
	const total = Math.max(1, data.total);
	const done = data.byCategory.done ?? 0;
	const max = Math.max(1, ...data.completedPerWeek.map((w) => w.count));
	return (
		<Panel title="Progress" bodyClassName="p-4" id="work-progress">
			<div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
				<p className="text-2xl font-semibold tabular">
					{Math.round((done / total) * 100)}%
					<span className="ml-1.5 text-sm font-normal text-muted-foreground">
						done
					</span>
				</p>
				<p className="text-sm text-muted-foreground tabular">
					{done} of {data.total} tasks
				</p>
				{data.overdue > 0 && (
					<p className="text-sm font-medium text-bad-text tabular">
						{data.overdue} overdue
					</p>
				)}
			</div>
			<div
				role="img"
				aria-label={CATEGORY.map(
					([k, label]) => `${label} ${data.byCategory[k] ?? 0}`,
				).join(", ")}
				className="mt-4 flex h-2 overflow-hidden rounded-full bg-muted"
			>
				{CATEGORY.map(([k, , cls]) => (
					<span
						key={k}
						className={cls}
						style={{ width: `${((data.byCategory[k] ?? 0) / total) * 100}%` }}
					/>
				))}
			</div>
			<ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
				{CATEGORY.map(([k, label, cls]) => (
					<li key={k} className="inline-flex items-center gap-1.5 tabular">
						<span aria-hidden className={`size-2 rounded-full ${cls}`} />
						{label} {data.byCategory[k] ?? 0}
					</li>
				))}
			</ul>
			<h3 className="mt-6 mb-2 text-xs font-medium text-muted-foreground">
				Completed per week, last 12 weeks
			</h3>
			<div
				role="img"
				aria-label={`Completed per week: ${data.completedPerWeek.map((w) => w.count).join(", ")}`}
				className="flex h-16 items-end gap-1"
			>
				{data.completedPerWeek.map((w) => (
					<span
						key={w.weekStart}
						title={`Week of ${w.weekStart}: ${w.count}`}
						className="min-h-0.5 flex-1 rounded-[2px] bg-foreground/70"
						style={{ height: `${(w.count / max) * 100}%` }}
					/>
				))}
			</div>
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
	const table = views.find((v) => v.kind === "table") ?? views[0];
	return (
		<Panel title="Lists" id="work-lists">
			<ul className="divide-y">
				{lists
					.filter((l) => !l.archivedAt)
					.map((l) => (
						<li key={l.id}>
							{table ? (
								<Link
									to={viewRoute(base)}
									params={{ projectId: project.id, viewId: table.id }}
									search={{ list: l.id } as never}
									className="flex items-center gap-2.5 px-4 py-2.5 text-sm outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
								>
									<ColorDot color={l.color} />
									<span className="truncate">{l.name}</span>
									<span className="ml-auto text-xs text-muted-foreground tabular">
										{l.openCount ?? 0} open
									</span>
								</Link>
							) : (
								<span className="flex px-4 py-2.5 text-sm">{l.name}</span>
							)}
						</li>
					))}
			</ul>
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
