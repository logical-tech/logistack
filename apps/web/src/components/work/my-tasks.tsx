/* My tasks: everything assigned to me across projects, by when it's due (section 13.2). */
import type { DueBucket, WorkMyTask } from "@logistack/contracts";
import { CheckCheck } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
	useMyWorkTasks,
	usePatchWorkTask,
	useWorkStatuses,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { isClosed } from "./lib";
import { DueDate, PriorityIcon, StatusIcon, TaskKey } from "./parts";
import { DateRangePicker, Picker, statusOptions } from "./pickers";
import { useShortcut } from "./shortcuts";
import { useOpenTask } from "./task-sheet/open-task";

const BUCKET_LABEL: Record<DueBucket, string> = {
	overdue: "Overdue",
	today: "Today",
	tomorrow: "Tomorrow",
	this_week: "This week",
	next_week: "Next week",
	later: "Later",
	none: "No due date",
};

function StatusCell({ task }: { task: WorkMyTask }) {
	const { data: statuses = [] } = useWorkStatuses(task.projectId);
	const patch = usePatchWorkTask();
	const status = statuses.find((s) => s.id === task.statusId);
	return (
		<Picker
			trigger={
				<button
					type="button"
					aria-label={`Status: ${status?.name ?? "unknown"}. Change`}
					className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-muted"
				>
					<StatusIcon status={status} />
				</button>
			}
			options={statusOptions(statuses)}
			value={[task.statusId]}
			onChange={([statusId]) =>
				statusId &&
				patch.mutate(
					{ id: task.id, patch: { statusId } },
					{ onError: () => toast.error(`${task.key} wasn't updated`) },
				)
			}
			placeholder="Change status…"
		/>
	);
}

function DueCell({ task, closed }: { task: WorkMyTask; closed: boolean }) {
	const patch = usePatchWorkTask();
	return (
		<DateRangePicker
			value={task}
			onChange={(v) =>
				patch.mutate(
					{ id: task.id, patch: v },
					{ onError: () => toast.error(`${task.key} wasn't updated`) },
				)
			}
			trigger={
				<button
					type="button"
					aria-label={`Due ${task.dueDate ?? "never"}. Change`}
					className="h-7 min-w-16 rounded-md px-1.5 text-right hover:bg-muted"
				>
					{task.dueDate ? (
						<DueDate date={task.dueDate} closed={closed} />
					) : (
						<span className="text-xs text-muted-foreground/60">Set date</span>
					)}
				</button>
			}
		/>
	);
}

function Row({
	task,
	focused,
	onFocus,
}: {
	task: WorkMyTask;
	focused: boolean;
	onFocus: () => void;
}) {
	const openTask = useOpenTask();
	const { data: statuses = [] } = useWorkStatuses(task.projectId);
	const closed = isClosed(statuses.find((s) => s.id === task.statusId));
	return (
		<li
			data-task-row={task.id}
			className={cn(
				"group flex items-center gap-2 px-2 py-1 text-sm transition-colors duration-(--duration-quick)",
				focused && "bg-muted/70",
			)}
		>
			<StatusCell task={task} />
			<button
				type="button"
				data-row-focus
				tabIndex={focused ? 0 : -1}
				onFocus={onFocus}
				onClick={() => openTask(task.id)}
				className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<TaskKey value={task.key} className="w-16 shrink-0" />
				<span
					className={cn(
						"truncate",
						closed && "text-muted-foreground line-through",
					)}
				>
					{task.title}
				</span>
				{task.watching && !task.assigneeIds?.length && (
					<span className="shrink-0 text-2xs text-muted-foreground">
						Watching
					</span>
				)}
				<span className="ml-auto hidden shrink-0 truncate text-xs text-muted-foreground sm:block">
					{task.projectName}
				</span>
			</button>
			<PriorityIcon priority={task.priority} />
			<DueCell task={task} closed={closed} />
		</li>
	);
}

export function MyTasks() {
	const [watching, setWatching] = useState(false);
	const { data, isLoading } = useMyWorkTasks(watching);
	const openTask = useOpenTask();
	const buckets = data?.buckets.filter((b) => b.items.length) ?? [];
	const flat = buckets.flatMap((b) => b.items);
	const [focus, setFocus] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const move = (d: number) => {
		const next = Math.max(0, Math.min(flat.length - 1, focus + d));
		setFocus(next);
		listRef.current
			?.querySelector<HTMLElement>(
				`[data-task-row="${flat[next]?.id}"] [data-row-focus]`,
			)
			?.focus();
	};
	useShortcut("j", () => move(1));
	useShortcut("k", () => move(-1));
	useShortcut("Enter", () => {
		const t = flat[focus];
		if (t) openTask(t.id);
	});

	return (
		<Page className="max-w-4xl">
			<PageHeader
				title="My tasks"
				description="Assigned to you across every project, by when they're due."
				actions={
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Switch
							id="work-show-watching"
							checked={watching}
							onCheckedChange={setWatching}
						/>
						<label htmlFor="work-show-watching">Show watching</label>
					</div>
				}
			/>
			{isLoading ? (
				<div className="grid gap-2">
					{[0, 1, 2, 3, 4].map((i) => (
						<Skeleton key={i} className="h-9" />
					))}
				</div>
			) : buckets.length === 0 ? (
				<EmptyState
					icon={CheckCheck}
					title="Nothing assigned to you"
					description="Tasks you're assigned show up here, sorted by when they're due."
				/>
			) : (
				<div ref={listRef} className="grid gap-6">
					{buckets.map((b) => (
						<section key={b.bucket} aria-labelledby={`bucket-${b.bucket}`}>
							<h2
								id={`bucket-${b.bucket}`}
								className={cn(
									"mb-1 flex items-center gap-2 px-2 text-xs font-semibold",
									b.bucket === "overdue"
										? "text-bad-text"
										: "text-muted-foreground",
								)}
							>
								{BUCKET_LABEL[b.bucket]}
								<span className="font-normal tabular">{b.items.length}</span>
							</h2>
							<ul className="divide-y overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
								{b.items.map((t) => {
									const i = flat.indexOf(t);
									return (
										<Row
											key={t.id}
											task={t}
											focused={i === focus}
											onFocus={() => setFocus(i)}
										/>
									);
								})}
							</ul>
						</section>
					))}
				</div>
			)}
		</Page>
	);
}
