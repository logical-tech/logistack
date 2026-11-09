import type { WorkImport } from "@logistack/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, FileSpreadsheet, ListChecks } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { useWorkImports } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/work/import/")({
	staticData: { crumb: "Import" },
	component: ImportHome,
});

const SOURCES = [
	{
		to: "/work/import/clickup" as const,
		icon: ListChecks,
		title: "ClickUp",
		description:
			"Spaces and lists with tasks, subtasks, checklists, custom fields, comments, attachments and time entries.",
	},
	{
		to: "/work/import/csv" as const,
		icon: FileSpreadsheet,
		title: "CSV file",
		description:
			"A spreadsheet export from anywhere. Each row becomes a task in the list you pick.",
	},
];

const STATUS: Record<WorkImport["status"], { label: string; dot: string }> = {
	draft: { label: "Draft", dot: "bg-idle" },
	ready: { label: "Ready", dot: "bg-info" },
	running: { label: "Running", dot: "bg-busy animate-pulse" },
	succeeded: { label: "Finished", dot: "bg-ok" },
	failed: { label: "Failed", dot: "bg-bad" },
	cancelled: { label: "Cancelled", dot: "bg-idle" },
};

function ImportHome() {
	const imports = useWorkImports();
	const past = (imports.data ?? []).filter((i) => i.startedAt);
	return (
		<Page className="max-w-4xl">
			<PageHeader
				title="Import tasks"
				description="Bring work from another tool. Imports run in the background and can be run again to pick up changes."
			/>
			<div className="grid gap-3 sm:grid-cols-2">
				{SOURCES.map((s) => (
					<Link
						key={s.to}
						to={s.to}
						className="group flex flex-col gap-3 rounded-xl bg-card p-5 shadow-card ring-1 ring-border transition-shadow t-press hover:ring-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<s.icon
							className="size-5 text-muted-foreground"
							strokeWidth={1.75}
							aria-hidden
						/>
						<span className="flex items-center gap-1.5 font-medium">
							{s.title}
							<ArrowRight
								className="size-3.5 -translate-x-1 opacity-0 transition-[translate,opacity] group-hover:translate-x-0 group-hover:opacity-100"
								aria-hidden
							/>
						</span>
						<span className="text-sm text-muted-foreground">
							{s.description}
						</span>
					</Link>
				))}
			</div>
			<Panel title="Past imports" className="mt-10">
				{imports.isPending ? (
					<SkeletonRows rows={2} />
				) : !past.length ? (
					<EmptyState
						icon={FileSpreadsheet}
						title="No imports yet"
						description="Imports you run show up here with what they created."
					/>
				) : (
					<ul className="divide-y rounded-lg ring-1 ring-border">
						{past.map((i) => (
							<li key={i.id}>
								<Link
									to="/work/import/$importId"
									params={{ importId: i.id }}
									className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50"
								>
									<span
										className={cn(
											"size-1.5 rounded-full",
											STATUS[i.status].dot,
										)}
									/>
									<span className="font-medium">
										{i.kind === "csv" ? "CSV" : "ClickUp"}
									</span>
									<span className="text-muted-foreground">
										{STATUS[i.status].label}
									</span>
									<span className="ml-auto text-muted-foreground tabular-nums">
										{(i.report?.created.task ?? 0) +
											(i.report?.updated.task ?? 0)}{" "}
										tasks ·{" "}
										{new Date(i.startedAt ?? i.createdAt).toLocaleDateString(
											undefined,
											{ day: "numeric", month: "short" },
										)}
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</Panel>
		</Page>
	);
}
