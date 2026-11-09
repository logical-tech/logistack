import type { WorkTimeGroup } from "@logistack/contracts";
import { addDays, formatDuration, startOfWeek } from "@logistack/core/work";
import { Download } from "lucide-react";
import { useId, useState } from "react";
import { Field } from "@/components/field";
import { SkeletonRows } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useWorkProjects, useWorkTimeReport } from "@/lib/api/work-queries";
import { localDay } from "./clock";

const ALL = "all";
const groups: { value: WorkTimeGroup; label: string }[] = [
	{ value: "day", label: "Day" },
	{ value: "week", label: "Week" },
	{ value: "project", label: "Project" },
	{ value: "user", label: "Person" },
	{ value: "task", label: "Task" },
];

/** Filters, a group-by switch, totals and CSV export over time entries. */
export function TimeReport() {
	const id = useId();
	const today = localDay(new Date());
	const [from, setFrom] = useState(() => startOfWeek(today));
	const [to, setTo] = useState(() => addDays(startOfWeek(today), 6));
	const [groupBy, setGroupBy] = useState<WorkTimeGroup>("day");
	const [projectId, setProjectId] = useState(ALL);
	const [billable, setBillable] = useState<"all" | "true" | "false">("all");
	const { data: projects = [] } = useWorkProjects();
	const query = {
		from,
		to,
		groupBy,
		...(projectId !== ALL && { projectId }),
		...(billable !== "all" && { billable }),
	};
	const { data, isPending } = useWorkTimeReport(query);
	const max = Math.max(1, ...(data?.rows ?? []).map((r) => r.seconds));
	const valid = from <= to;

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-end gap-3">
				<Field id={`${id}-f`} label="From" className="w-40">
					<Input
						id={`${id}-f`}
						type="date"
						className="h-8 text-sm"
						value={from}
						max={to}
						onChange={(e) => e.target.value && setFrom(e.target.value)}
					/>
				</Field>
				<Field id={`${id}-t`} label="To" className="w-40">
					<Input
						id={`${id}-t`}
						type="date"
						className="h-8 text-sm"
						value={to}
						min={from}
						onChange={(e) => e.target.value && setTo(e.target.value)}
					/>
				</Field>
				<Field id={`${id}-p`} label="Project" className="w-48">
					<Select value={projectId} onValueChange={setProjectId}>
						<SelectTrigger id={`${id}-p`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All projects</SelectItem>
							{projects.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field id={`${id}-b`} label="Billable" className="w-36">
					<Select
						value={billable}
						onValueChange={(v) => setBillable(v as typeof billable)}
					>
						<SelectTrigger id={`${id}-b`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All</SelectItem>
							<SelectItem value="true">Billable</SelectItem>
							<SelectItem value="false">Not billable</SelectItem>
						</SelectContent>
					</Select>
				</Field>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Segmented
					label="Group by"
					value={groupBy}
					onChange={setGroupBy}
					options={groups}
				/>
				<Button asChild variant="outline" size="sm" disabled={!valid}>
					<a
						href={api.work.time.reportCsvUrl({ ...query, format: "csv" })}
						download={`time-${from}-${to}.csv`}
					>
						<Download data-icon="inline-start" />
						CSV
					</a>
				</Button>
			</div>

			<div className="grid gap-3 sm:grid-cols-3">
				<Stat
					label="Tracked"
					value={data && formatDuration(data.totals.seconds)}
				/>
				<Stat
					label="Billable"
					value={data && formatDuration(data.totals.billableSeconds)}
				/>
				<Stat label="Entries" value={data?.totals.entries.toLocaleString()} />
			</div>

			<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				{isPending ? (
					<SkeletonRows rows={4} />
				) : !data?.rows.length ? (
					<p className="px-4 py-10 text-center text-sm text-muted-foreground">
						No time in this range.
					</p>
				) : (
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b text-xs text-muted-foreground">
								<th className="px-4 py-2.5 text-left font-medium">
									{groups.find((g) => g.value === groupBy)?.label}
								</th>
								<th className="w-2/5 px-4 py-2.5 max-sm:hidden">
									<span className="sr-only">Share</span>
								</th>
								<th className="px-4 py-2.5 text-right font-medium">Tracked</th>
								<th className="px-4 py-2.5 text-right font-medium max-sm:hidden">
									Billable
								</th>
							</tr>
						</thead>
						<tbody className="divide-y">
							{data.rows.map((r) => (
								<tr key={r.key}>
									<td className="max-w-0 truncate px-4 py-2.5">{r.label}</td>
									<td className="px-4 py-2.5 max-sm:hidden">
										<div className="h-1.5 rounded-full bg-muted">
											<div
												className="h-full rounded-full bg-chart-1"
												style={{ width: `${(r.seconds / max) * 100}%` }}
											/>
										</div>
									</td>
									<td className="px-4 py-2.5 text-right font-medium tabular">
										{formatDuration(r.seconds)}
									</td>
									<td className="px-4 py-2.5 text-right text-muted-foreground tabular max-sm:hidden">
										{formatDuration(r.billableSeconds)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string | undefined }) {
	return (
		<div className="rounded-xl bg-card px-4 py-3 shadow-card ring-1 ring-border">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-1 text-lg font-semibold tabular">
				{value ?? (
					<span className="t-skel inline-block h-5 w-16 rounded bg-muted" />
				)}
			</p>
		</div>
	);
}
