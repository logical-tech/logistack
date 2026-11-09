/* The Work shell's landing for projects: each with its health and where the work stands. */
import { Link } from "@tanstack/react-router";
import { Boxes } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkProjects } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { HealthPill, TaskKey } from "./parts";

export function ProjectsGrid() {
	const { data: projects, isLoading } = useWorkProjects();
	const live = projects?.filter((p) => !p.archived) ?? [];
	const archived = projects?.filter((p) => p.archived) ?? [];
	return (
		<Page>
			<PageHeader
				title="Projects"
				description="Every project you work on, whether its services are up, and what's open."
			/>
			{isLoading ? (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-40 rounded-xl" />
					))}
				</div>
			) : !projects?.length ? (
				<EmptyState
					icon={Boxes}
					title="No projects yet"
					description="When someone adds you to a project, it appears here with its tasks."
				/>
			) : (
				<>
					<ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{live.map((p) => (
							<li key={p.id}>
								<Link
									to="/work/projects/$projectId"
									params={{ projectId: p.id }}
									className="group flex h-full flex-col rounded-xl bg-card p-4 shadow-card ring-1 ring-border outline-none transition-[box-shadow] duration-(--duration-quick) hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
								>
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0">
											{p.folderPath.length > 0 && (
												<p className="truncate text-xs text-muted-foreground">
													{p.folderPath.join(" / ")}
												</p>
											)}
											<h2 className="truncate text-md font-semibold">
												{p.name}
											</h2>
										</div>
										<TaskKey value={p.key} className="pt-0.5" />
									</div>
									<div className="mt-2 min-h-5">
										{p.hasServices ? (
											<HealthPill health={p.health} since={p.since} />
										) : (
											<span className="text-sm text-muted-foreground">
												No services
											</span>
										)}
									</div>
									<dl className="mt-auto grid grid-cols-4 gap-2 pt-5 text-center">
										{(
											[
												["Open", p.counts.open, false],
												["Overdue", p.counts.overdue, p.counts.overdue > 0],
												["Mine", p.counts.mine, false],
												["Done this week", p.counts.doneThisWeek, false],
											] as const
										).map(([label, n, bad]) => (
											<div
												key={label}
												className="flex flex-col-reverse rounded-md bg-muted/50 px-1 py-1.5"
											>
												<dt className="truncate text-2xs text-muted-foreground">
													{label}
												</dt>
												<dd
													className={cn(
														"text-md font-semibold tabular",
														bad && "text-bad-text",
													)}
												>
													{n}
												</dd>
											</div>
										))}
									</dl>
								</Link>
							</li>
						))}
					</ul>
					{archived.length > 0 && (
						<p className="mt-6 text-sm text-muted-foreground">
							{archived.length} archived{" "}
							{archived.length === 1 ? "project is" : "projects are"} hidden.
						</p>
					)}
				</>
			)}
		</Page>
	);
}
