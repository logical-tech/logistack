import { Users } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/panel";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useWorkTask, useWorkWorkload } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";

const hours = (min: number) =>
	min === 0 ? "" : `${Math.round((min / 60) * 10) / 10}h`;
const weekLabel = (day: string) =>
	new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${day}T00:00:00Z`));

/** People × the next weeks: estimated hours of open work, over-capacity cells highlighted. */
export function WorkloadGrid({
	projectIds,
	weeks = 6,
}: {
	projectIds?: string[];
	weeks?: number;
}) {
	const { data, isPending } = useWorkWorkload({
		weeks,
		...(projectIds?.length && { projectIds: projectIds.join(",") }),
	});
	if (isPending)
		return (
			<div className="rounded-xl bg-card shadow-card ring-1 ring-border">
				<SkeletonRows rows={4} />
			</div>
		);
	if (!data?.people.length)
		return (
			<EmptyState
				icon={Users}
				title="No one to plan for"
				description="Assign open tasks with estimates and dates to see each person's load by week."
			/>
		);

	return (
		<div className="overflow-x-auto rounded-xl bg-card shadow-card ring-1 ring-border">
			<table className="w-full min-w-[40rem] text-sm">
				<thead>
					<tr className="border-b text-xs text-muted-foreground">
						<th className="px-4 py-2.5 text-left font-medium">Person</th>
						{data.weeks.map((w) => (
							<th
								key={w}
								scope="col"
								className="px-1 py-2.5 text-center font-medium tabular"
							>
								{weekLabel(w)}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="divide-y">
					{data.people.map((p) => (
						<tr key={p.userId}>
							<th scope="row" className="px-4 py-2 text-left font-normal">
								<span className="block truncate">{p.name}</span>
								<span className="block text-xs text-muted-foreground tabular">
									{hours(p.capacityMinutes)} a week
								</span>
							</th>
							{p.cells.map((c) => (
								<td key={c.weekStart} className="p-1">
									<Cell
										minutes={c.minutes}
										capacity={p.capacityMinutes}
										taskIds={c.taskIds}
										label={`${p.name}, week of ${weekLabel(c.weekStart)}`}
									/>
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Cell({
	minutes,
	capacity,
	taskIds,
	label,
}: {
	minutes: number;
	capacity: number;
	taskIds: string[];
	label: string;
}) {
	const over = capacity > 0 && minutes > capacity;
	const load = capacity > 0 ? Math.min(1, minutes / capacity) : 0;
	const body = (
		<>
			<span
				aria-hidden
				className={cn(
					"absolute inset-x-0 bottom-0 rounded-b-md transition-[height] duration-(--duration-fast)",
					over ? "bg-warn/25" : "bg-foreground/[0.06]",
				)}
				style={{ height: `${load * 100}%` }}
			/>
			<span className="relative">{hours(minutes)}</span>
		</>
	);
	const cls = cn(
		"relative flex h-11 w-full items-center justify-center overflow-hidden rounded-md text-sm tabular",
		over && "font-medium text-warn-text ring-1 ring-warn/40",
	);
	if (!taskIds.length)
		return (
			<div className={cls} role="img" aria-label={`${label}: nothing planned`}>
				{body}
			</div>
		);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={`${label}: ${hours(minutes) || "0h"}${over ? ", over capacity" : ""}, ${taskIds.length} tasks`}
					className={cn(
						cls,
						"outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
					)}
				>
					{body}
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-80 p-1" align="center">
				<p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
					{label}
				</p>
				<ul className="max-h-72 overflow-y-auto">
					{taskIds.map((id) => (
						<TaskLine key={id} id={id} />
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

function TaskLine({ id }: { id: string }) {
	const { data: t } = useWorkTask(id);
	return (
		<li className="flex h-8 items-center gap-2 rounded-md px-2 text-sm">
			<span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
				{t?.key ?? "…"}
			</span>
			<span className="min-w-0 flex-1 truncate">{t?.title}</span>
			<span className="shrink-0 text-xs text-muted-foreground tabular">
				{t?.estimateMinutes ? hours(t.estimateMinutes) : ""}
			</span>
		</li>
	);
}
