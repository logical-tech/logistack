import type { WorkImport, WorkImportPlan } from "@logistack/contracts";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useWorkImportAction } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";

const PHASES: Record<string, string> = {
	fetch: "Reading ClickUp",
	structure: "Statuses, fields and lists",
	tasks: "Tasks",
	checklists: "Checklists",
	dependencies: "Dependencies",
	comments: "Comments",
	attachments: "Attachments",
	time: "Time entries",
};

const ENTITY: Record<string, string> = {
	task: "Tasks",
	list: "Lists",
	field: "Fields",
	checklistItem: "Checklist items",
	dependency: "Dependencies",
	comment: "Comments",
	attachment: "Attachments",
	timeEntry: "Time entries",
	invitation: "Invitations",
	tasks: "Tasks",
	subtasks: "Subtasks",
	lists: "Lists",
	checklistItems: "Checklist items",
	attachments: "Attachments",
};

export const entityLabel = (k: string) => ENTITY[k] ?? k;

export const formatBytes = (n: number) =>
	n < 1024 * 1024
		? `${Math.ceil(n / 1024)} KB`
		: n < 1024 ** 3
			? `${(n / 1024 / 1024).toFixed(1)} MB`
			: `${(n / 1024 ** 3).toFixed(2)} GB`;

/** The dry run's counts, per target and in total, with its warnings. */
export function ImportPlan({ plan }: { plan: WorkImportPlan }) {
	return (
		<div className="grid gap-4">
			<dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border ring-1 ring-border sm:grid-cols-3">
				{Object.entries(plan.counts).map(([k, v]) => (
					<div key={k} className="bg-card px-4 py-3">
						<dt className="text-xs text-muted-foreground">{entityLabel(k)}</dt>
						<dd className="mt-0.5 text-lg font-semibold tabular-nums">
							{v.toLocaleString()}
						</dd>
					</div>
				))}
				{plan.attachmentBytes > 0 && (
					<div className="bg-card px-4 py-3">
						<dt className="text-xs text-muted-foreground">Attachment size</dt>
						<dd className="mt-0.5 text-lg font-semibold tabular-nums">
							{formatBytes(plan.attachmentBytes)}
						</dd>
					</div>
				)}
			</dl>
			{plan.perProject.length > 1 && (
				<ul className="grid gap-1 text-sm">
					{plan.perProject.map((p) => (
						<li key={p.target} className="flex justify-between gap-4">
							<span>{p.target}</span>
							<span className="text-muted-foreground tabular-nums">
								{p.counts.tasks ?? 0} tasks · {p.counts.subtasks ?? 0} subtasks
							</span>
						</li>
					))}
				</ul>
			)}
			<Warnings items={plan.warnings} />
		</div>
	);
}

function Warnings({ items }: { items: string[] }) {
	if (!items.length) return null;
	return (
		<div className="rounded-lg bg-warn/10 p-4">
			<p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-warn-text">
				<CircleAlert className="size-4" aria-hidden />
				{items.length === 1
					? "1 thing to know"
					: `${items.length} things to know`}
			</p>
			<ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
				{items.map((w) => (
					<li key={w}>{w}</li>
				))}
			</ul>
		</div>
	);
}

/** Live phases while an import runs, then what it created, updated and skipped. */
export function ImportRun({ imp }: { imp: WorkImport }) {
	const action = useWorkImportAction();
	const phases = Object.values(imp.progress ?? {});
	const running = imp.status === "running";
	return (
		<div className="grid gap-6">
			<div className="flex items-center gap-3" aria-live="polite">
				{running ? (
					<Loader2
						className="size-5 animate-spin text-muted-foreground"
						aria-hidden
					/>
				) : imp.status === "succeeded" ? (
					<CircleCheck className="t-reveal size-5 text-ok-text" aria-hidden />
				) : (
					<CircleAlert className="t-reveal size-5 text-bad-text" aria-hidden />
				)}
				<p key={imp.status} className="t-swap flex-1 text-sm font-medium">
					{running
						? "Importing… you can leave this page; it keeps going."
						: imp.status === "succeeded"
							? "Import finished"
							: imp.status === "cancelled"
								? "Import cancelled; what it wrote stays."
								: imp.status === "failed"
									? "Import stopped"
									: "Not started"}
				</p>
				{running && (
					<Button
						variant="outline"
						size="sm"
						disabled={action.isPending}
						onClick={() => action.mutate({ id: imp.id, action: "cancel" })}
					>
						Cancel
					</Button>
				)}
			</div>
			{phases.length > 0 && (
				<ol className="grid gap-3">
					{phases.map((p) => {
						const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
						return (
							<li key={p.phase} className="grid gap-1.5">
								<div className="flex justify-between text-sm">
									<span className={cn(pct === 100 && "text-muted-foreground")}>
										{PHASES[p.phase] ?? p.phase}
									</span>
									<span className="text-muted-foreground tabular-nums">
										{p.done.toLocaleString()} / {p.total.toLocaleString()}
									</span>
								</div>
								<Progress value={pct} aria-label={PHASES[p.phase] ?? p.phase} />
							</li>
						);
					})}
				</ol>
			)}
			{imp.report && (
				<div className="grid gap-4">
					<ReportTable title="Created" counts={imp.report.created} />
					<ReportTable title="Updated" counts={imp.report.updated} />
					{imp.report.skipped.length > 0 && (
						<details className="rounded-lg ring-1 ring-border">
							<summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">
								Skipped{" "}
								<span className="text-muted-foreground tabular-nums">
									{imp.report.skipped.length}
								</span>
							</summary>
							<ul className="divide-y border-t text-sm">
								{imp.report.skipped.slice(0, 200).map((s, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and never reorder
									<li key={i} className="flex justify-between gap-4 px-4 py-2">
										<span className="min-w-0 truncate">
											<span className="text-muted-foreground">
												{entityLabel(s.entity)} ·{" "}
											</span>
											{s.name}
										</span>
										<span className="shrink-0 text-muted-foreground">
											{s.reason}
										</span>
									</li>
								))}
							</ul>
						</details>
					)}
					<Warnings items={imp.report.warnings} />
				</div>
			)}
		</div>
	);
}

function ReportTable({
	title,
	counts,
}: {
	title: string;
	counts: Record<string, number>;
}) {
	const rows = Object.entries(counts).filter(([, n]) => n > 0);
	if (!rows.length) return null;
	return (
		<div>
			<h3 className="mb-2 text-sm font-medium">{title}</h3>
			<dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
				{rows.map(([k, n]) => (
					<div key={k} className="flex justify-between gap-2">
						<dt className="text-muted-foreground">{entityLabel(k)}</dt>
						<dd className="tabular-nums">{n.toLocaleString()}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
