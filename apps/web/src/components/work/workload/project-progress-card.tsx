import { Panel, SkeletonRows } from "@/components/panel";
import { Progress } from "@/components/ui/progress";
import { useWorkSummary } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";

const weekLabel = (day: string) =>
	new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${day}T00:00:00Z`));

/** Project overview "Progress": done of total, overdue, and tasks completed per week (last 12). */
export function ProjectProgressCard({
	projectId,
	className,
}: {
	projectId: string;
	className?: string;
}) {
	const { data: s } = useWorkSummary(projectId);
	const done = s?.byCategory.done ?? 0;
	// Cancelled work leaves the scope, so it counts in neither side.
	const scope = s ? s.total - (s.byCategory.cancelled ?? 0) : 0;
	const pct = scope ? Math.round((done / scope) * 100) : 0;
	const weeks = s?.completedPerWeek ?? [];
	const max = Math.max(1, ...weeks.map((w) => w.count));
	const last = weeks.at(-1);

	return (
		<Panel title="Progress" className={className}>
			{!s ? (
				<SkeletonRows rows={3} />
			) : (
				<div className="grid gap-5 p-4">
					<div className="grid grid-cols-3 gap-4">
						<Figure
							label="Done"
							value={`${pct}%`}
							detail={`${done} of ${scope}`}
						/>
						<Figure
							label="Open"
							value={String(
								(s.byCategory.active ?? 0) + (s.byCategory.backlog ?? 0),
							)}
							detail={`${s.byCategory.backlog ?? 0} in backlog`}
						/>
						<Figure
							label="Overdue"
							value={String(s.overdue)}
							tone={s.overdue > 0 ? "bad" : undefined}
						/>
					</div>
					<Progress
						aria-label="Tasks done"
						value={pct}
						className="h-1.5 [&>*]:bg-ok"
					/>
					<figure>
						<figcaption className="mb-2 flex items-baseline justify-between text-xs text-muted-foreground">
							<span>Completed per week</span>
							{last && <span className="tabular">{last.count} this week</span>}
						</figcaption>
						<ol
							className="flex h-20 items-end gap-1"
							aria-label="Tasks completed per week, oldest first"
						>
							{weeks.map((w, i) => (
								<li
									key={w.weekStart}
									className="group relative flex h-full flex-1 items-end"
									title={`Week of ${weekLabel(w.weekStart)}: ${w.count}`}
								>
									<span className="sr-only">
										Week of {weekLabel(w.weekStart)}: {w.count}
									</span>
									<span
										aria-hidden
										className={cn(
											"w-full rounded-t-sm transition-colors duration-(--duration-quick)",
											i === weeks.length - 1
												? "bg-chart-1"
												: "bg-chart-1/45 group-hover:bg-chart-1/70",
										)}
										style={{
											height: w.count
												? `${Math.max(4, (w.count / max) * 100)}%`
												: "2px",
										}}
									/>
								</li>
							))}
						</ol>
						{weeks.length > 0 && (
							<div className="mt-1.5 flex justify-between text-2xs text-muted-foreground tabular">
								<span>{weekLabel(weeks[0]?.weekStart ?? "")}</span>
								<span>{weekLabel(last?.weekStart ?? "")}</span>
							</div>
						)}
					</figure>
				</div>
			)}
		</Panel>
	);
}

function Figure({
	label,
	value,
	detail,
	tone,
}: {
	label: string;
	value: string;
	detail?: string;
	tone?: "bad";
}) {
	return (
		<div className="min-w-0">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p
				className={cn(
					"mt-0.5 text-xl font-semibold tabular",
					tone === "bad" && "text-bad-text",
				)}
			>
				{value}
			</p>
			{detail && (
				<p className="truncate text-xs text-muted-foreground tabular">
					{detail}
				</p>
			)}
		</div>
	);
}
