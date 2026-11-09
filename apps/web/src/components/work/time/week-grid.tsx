import type { WorkTimeEntry } from "@logistack/contracts";
import {
	addDays,
	formatDuration,
	parseDuration,
	startOfWeek,
} from "@logistack/core/work";
import { useQueries } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock, Plus } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import {
	useCreateWorkTimeEntry,
	useDeleteWorkTimeEntry,
	useUpdateWorkTimeEntry,
	useWorkSearch,
	useWorkTimeReport,
	workKeys,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { localDay, morningOf } from "./clock";

type Row = { id: string; key: string; title: string };

const dayLabel = (day: string) =>
	new Intl.DateTimeFormat("en", {
		weekday: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${day}T00:00:00Z`));

/** One person's week: rows are tasks, columns are days, each cell edits that day's time. */
export function WeekGrid({ userId }: { userId: string }) {
	const [week, setWeek] = useState(() => startOfWeek(localDay(new Date())));
	const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
	const [added, setAdded] = useState<Row[]>([]);
	const report = useWorkTimeReport({
		userId,
		from: week,
		to: days[6] as string,
		groupBy: "task",
	});
	const fromReport: Row[] = (report.data?.rows ?? []).map((r) => {
		const [key = "", ...title] = r.label.split(" ");
		return { id: r.key, key, title: title.join(" ") };
	});
	const rows = [
		...fromReport,
		...added.filter((a) => !fromReport.some((r) => r.id === a.id)),
	];
	const entryQueries = useQueries({
		queries: rows.map((r) => ({
			queryKey: workKeys.taskPart(r.id, "time"),
			queryFn: () => api.work.time.list(r.id),
		})),
	});
	const mine = (i: number, day: string) =>
		(entryQueries[i]?.data ?? []).filter(
			(e) => e.userId === userId && e.endedAt && localDay(e.startedAt) === day,
		);
	const dayTotal = (day: string) =>
		rows.reduce(
			(s, _, i) =>
				s + mine(i, day).reduce((t, e) => t + (e.durationSec ?? 0), 0),
			0,
		);
	const weekTotal = days.reduce((s, d) => s + dayTotal(d), 0);
	const today = localDay(new Date());

	return (
		<div className="grid gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label="Previous week"
						onClick={() => setWeek(addDays(week, -7))}
					>
						<ChevronLeft />
					</Button>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label="Next week"
						onClick={() => setWeek(addDays(week, 7))}
					>
						<ChevronRight />
					</Button>
					<span className="ml-1 text-sm font-medium tabular">
						Week of {dayLabel(week)}
					</span>
					{week !== startOfWeek(today) && (
						<Button
							type="button"
							size="sm"
							variant="link"
							onClick={() => setWeek(startOfWeek(today))}
						>
							This week
						</Button>
					)}
				</div>
				<AddRow
					onPick={(r) =>
						setAdded((a) => [...a.filter((x) => x.id !== r.id), r])
					}
				/>
			</div>

			<div className="overflow-x-auto rounded-xl bg-card shadow-card ring-1 ring-border">
				{report.isPending ? (
					<SkeletonRows rows={3} />
				) : rows.length === 0 ? (
					<EmptyState
						icon={Clock}
						title="No time this week"
						description="Add a task to log hours by day, or start a timer from a task."
						className="m-3"
					/>
				) : (
					<table className="w-full min-w-[44rem] text-sm">
						<thead>
							<tr className="border-b text-xs text-muted-foreground">
								<th className="px-4 py-2.5 text-left font-medium">Task</th>
								{days.map((d) => (
									<th
										key={d}
										scope="col"
										className={cn(
											"w-20 px-1 py-2.5 text-center font-medium tabular",
											d === today && "text-foreground",
										)}
									>
										{dayLabel(d)}
									</th>
								))}
								<th className="w-20 px-4 py-2.5 text-right font-medium">
									Total
								</th>
							</tr>
						</thead>
						<tbody className="divide-y">
							{rows.map((r, i) => {
								const total = days.reduce(
									(s, d) =>
										s +
										mine(i, d).reduce((t, e) => t + (e.durationSec ?? 0), 0),
									0,
								);
								return (
									<tr key={r.id}>
										<th
											scope="row"
											className="max-w-0 px-4 py-1.5 text-left font-normal"
										>
											<span className="mr-2 font-mono text-xs text-muted-foreground">
												{r.key}
											</span>
											<span className="truncate">{r.title}</span>
										</th>
										{days.map((d) => (
											<td key={d} className="px-1 py-1">
												<Cell
													taskId={r.id}
													day={d}
													entries={mine(i, d)}
													label={`${r.key} on ${dayLabel(d)}`}
												/>
											</td>
										))}
										<td className="px-4 py-1.5 text-right font-medium tabular">
											{total ? formatDuration(total) : ""}
										</td>
									</tr>
								);
							})}
						</tbody>
						<tfoot>
							<tr className="border-t text-xs text-muted-foreground">
								<th className="px-4 py-2.5 text-left font-medium">Total</th>
								{days.map((d) => (
									<td key={d} className="px-1 py-2.5 text-center tabular">
										{dayTotal(d) ? formatDuration(dayTotal(d)) : ""}
									</td>
								))}
								<td className="px-4 py-2.5 text-right font-semibold text-foreground tabular">
									{formatDuration(weekTotal)}
								</td>
							</tr>
						</tfoot>
					</table>
				)}
			</div>
		</div>
	);
}

/** Edits one day's time on a task: creates, resizes or deletes the single entry behind it. */
function Cell({
	taskId,
	day,
	entries,
	label,
}: {
	taskId: string;
	day: string;
	entries: WorkTimeEntry[];
	label: string;
}) {
	const total = entries.reduce((s, e) => s + (e.durationSec ?? 0), 0);
	const shown = total ? formatDuration(total) : "";
	const [draft, setDraft] = useState<string | null>(null);
	const create = useCreateWorkTimeEntry();
	const update = useUpdateWorkTimeEntry();
	const remove = useDeleteWorkTimeEntry();
	const [entry] = entries;
	// shortcut: a day with several entries or a locked one is read-only here; edit those in the task sheet.
	const readOnly = entries.length > 1 || entries.some((e) => e.locked);
	const fail = (e: unknown) =>
		toast.error(e instanceof Error ? e.message : String(e));

	const commit = () => {
		if (draft === null) return;
		const text = draft.trim();
		setDraft(null);
		if (text === shown) return;
		const seconds = text === "" || text === "0" ? 0 : parseDuration(text);
		if (seconds === null || seconds > 24 * 3600) {
			toast.error("Use a duration like 1h30, 90m or 1.5h");
			return;
		}
		if (seconds !== 0 && seconds < 60) return;
		if (!entry) {
			if (seconds)
				create.mutate(
					{
						taskId,
						input: { startedAt: morningOf(day), durationSec: seconds },
					},
					{ onError: fail },
				);
		} else if (seconds === 0)
			remove.mutate({ taskId, id: entry.id }, { onError: fail });
		else
			update.mutate(
				{ taskId, id: entry.id, patch: { durationSec: seconds } },
				{ onError: fail },
			);
	};

	return (
		<input
			aria-label={label}
			value={draft ?? shown}
			readOnly={readOnly}
			title={
				readOnly
					? "Several or locked entries: edit them on the task"
					: undefined
			}
			onFocus={(e) => {
				if (!readOnly) setDraft(shown);
				e.currentTarget.select();
			}}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setDraft(null);
					requestAnimationFrame(() => e.currentTarget?.blur());
				}
			}}
			placeholder="–"
			className={cn(
				"h-8 w-full rounded-md bg-transparent px-1 text-center tabular outline-none transition-colors duration-(--duration-quick) placeholder:text-muted-foreground/40",
				"hover:bg-muted focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring",
				readOnly && "cursor-default text-muted-foreground hover:bg-transparent",
			)}
		/>
	);
}

function AddRow({ onPick }: { onPick: (row: Row) => void }) {
	const [open, setOpen] = useState(false);
	const [q, setQ] = useState("");
	const { data } = useWorkSearch(q);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" size="sm" variant="outline">
					<Plus data-icon="inline-start" />
					Add task
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-0">
				<Command shouldFilter={false}>
					<CommandInput
						value={q}
						onValueChange={setQ}
						placeholder="Search tasks by key or title"
					/>
					<CommandList>
						<CommandEmpty>
							{q.trim() ? "No tasks found" : "Type to search"}
						</CommandEmpty>
						{(q.trim() ? (data?.items ?? []) : []).map((t) => (
							<CommandItem
								key={t.id}
								value={t.id}
								onSelect={() => {
									onPick({ id: t.id, key: t.key, title: t.title });
									setOpen(false);
									setQ("");
								}}
							>
								<span className="font-mono text-xs text-muted-foreground">
									{t.key}
								</span>
								<span className="truncate">{t.title}</span>
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
