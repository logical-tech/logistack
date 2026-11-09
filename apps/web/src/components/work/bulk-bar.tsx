/*
 * The bar that slides up while tasks are selected: status, assignee, priority, dates (set or
 * shift), tags, list, archive, delete. One bulk call per action; per-task errors are reported.
 */
import type { WorkTaskBulk } from "@logistack/contracts";
import {
	Archive,
	CalendarDays,
	CircleDot,
	Flag,
	FolderInput,
	Tag,
	Trash2,
	UserRound,
	X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useBulkWorkTasks } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import {
	DateRangePicker,
	listOptions,
	OptionList,
	type PickerOption,
	peopleOptions,
	priorityOptions,
	statusOptions,
	tagOptions,
} from "./pickers";
import type { WorkProjectContext } from "./views/types";

function BarPicker({
	icon: Icon,
	label,
	options,
	multiple,
	onPick,
}: {
	icon: typeof Flag;
	label: string;
	options: PickerOption[];
	multiple?: boolean;
	onPick: (ids: string[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<string[]>([]);
	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (!o && multiple && picked.length) onPick(picked);
				if (!o) setPicked([]);
			}}
		>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm">
					<Icon data-icon="inline-start" />
					{label}
				</Button>
			</PopoverTrigger>
			<PopoverContent side="top" className="w-60 p-1">
				<OptionList
					options={options}
					value={picked}
					multiple={multiple}
					onChange={(ids) => (multiple ? setPicked(ids) : onPick(ids))}
					onDone={() => setOpen(false)}
				/>
			</PopoverContent>
		</Popover>
	);
}

export function BulkBar({
	project,
	selected,
	onClear,
}: {
	project: WorkProjectContext;
	selected: string[];
	onClear: () => void;
}) {
	const bulk = useBulkWorkTasks();
	const [deleting, setDeleting] = useState(false);
	const [shift, setShift] = useState("");
	const n = selected.length;
	const run = async (input: Omit<WorkTaskBulk, "taskIds">, done: string) => {
		try {
			const r = await bulk.mutateAsync({ taskIds: selected, ...input });
			if (r.errors.length)
				toast.warning(`${r.updated.length} updated, ${r.errors.length} not`, {
					description: r.errors
						.slice(0, 3)
						.map((e) => e.message)
						.join(" "),
				});
			else
				toast.success(
					`${done} ${r.updated.length} ${r.updated.length === 1 ? "task" : "tasks"}`,
				);
			if (input.archive || input.delete) onClear();
		} catch (e) {
			toast.error("Nothing was changed", {
				description: e instanceof Error ? e.message : undefined,
			});
		}
	};

	return (
		<>
			<div
				role="toolbar"
				aria-label={`${n} selected`}
				aria-hidden={n === 0}
				className={cn(
					"fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-0.5 rounded-xl bg-popover p-1.5 shadow-float ring-1 ring-foreground/10 transition-[translate,opacity] duration-(--duration-fast) ease-(--ease-smooth-out) motion-reduce:transition-none",
					n
						? "translate-y-0 opacity-100"
						: "pointer-events-none translate-y-6 opacity-0",
				)}
			>
				<span className="px-2 text-sm font-medium tabular">{n} selected</span>
				<BarPicker
					icon={CircleDot}
					label="Status"
					options={statusOptions(project.statuses)}
					onPick={([statusId]) =>
						statusId && run({ set: { statusId } }, "Moved")
					}
				/>
				<BarPicker
					icon={UserRound}
					label="Assign"
					multiple
					options={peopleOptions(project.people, { assignableOnly: true })}
					onPick={(ids) => run({ set: { addAssignees: ids } }, "Assigned")}
				/>
				<BarPicker
					icon={Flag}
					label="Priority"
					options={priorityOptions()}
					onPick={([p]) =>
						p &&
						run(
							{
								set: {
									priority: p as "urgent" | "high" | "normal" | "low" | "none",
								},
							},
							"Updated",
						)
					}
				/>
				<DateRangePicker
					withTime={false}
					value={{ startDate: null, dueDate: null }}
					onChange={(v) =>
						run(
							{
								set: {
									...(v.startDate !== null && { startDate: v.startDate }),
									...(v.dueDate !== null && { dueDate: v.dueDate }),
								},
							},
							"Rescheduled",
						)
					}
					trigger={
						<Button variant="ghost" size="sm">
							<CalendarDays data-icon="inline-start" />
							Dates
						</Button>
					}
					extra={
						<form
							className="flex items-end gap-2 border-t pt-3"
							onSubmit={(e) => {
								e.preventDefault();
								const d = Number(shift);
								if (Number.isInteger(d) && d !== 0)
									void run({ set: { shiftDays: d } }, "Shifted");
							}}
						>
							<div className="grid flex-1 gap-1 text-xs text-muted-foreground">
								<label htmlFor="work-bulk-shift">Shift by working days</label>
								<Input
									id="work-bulk-shift"
									type="number"
									value={shift}
									onChange={(e) => setShift(e.target.value)}
									placeholder="3 or -2"
								/>
							</div>
							<Button type="submit" size="sm" variant="outline">
								Shift
							</Button>
						</form>
					}
				/>
				<BarPicker
					icon={Tag}
					label="Tags"
					multiple
					options={tagOptions(project.tags)}
					onPick={(ids) => run({ set: { addTags: ids } }, "Tagged")}
				/>
				{project.lists.length > 1 && (
					<BarPicker
						icon={FolderInput}
						label="List"
						options={listOptions(project.lists)}
						onPick={([listId]) => listId && run({ set: { listId } }, "Moved")}
					/>
				)}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => run({ archive: true }, "Archived")}
				>
					<Archive data-icon="inline-start" />
					Archive
				</Button>
				{project.canAdmin && (
					<Button
						variant="ghost"
						size="sm"
						className="text-bad-text hover:text-bad-text"
						onClick={() => setDeleting(true)}
					>
						<Trash2 data-icon="inline-start" />
						Delete
					</Button>
				)}
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Clear selection"
					onClick={onClear}
				>
					<X />
				</Button>
			</div>
			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete ${n} ${n === 1 ? "task" : "tasks"}?`}
				description="Their subtasks, comments and attachments go too. This can't be undone; archive keeps them."
				confirmLabel="Delete"
				destructive
				pending={bulk.isPending}
				onConfirm={async () => {
					await run({ delete: true }, "Deleted");
					setDeleting(false);
				}}
			/>
		</>
	);
}
