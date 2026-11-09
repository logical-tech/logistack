/* The task's properties: status, people, dates, priority, tags, list, estimate, milestone, fields. */

import type { WorkField, WorkTask } from "@logistack/contracts";
import { Diamond } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCreateWorkTag } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { FieldDisplay, FieldEditor } from "../field-editor";
import { formatMinutes, parseMinutes, priorityMeta, WORK_COLORS } from "../lib";
import {
	AvatarStack,
	ColorDot,
	PriorityIcon,
	StatusIcon,
	TagChips,
} from "../parts";
import {
	DateRangeLabel,
	DateRangePicker,
	listOptions,
	PeoplePicker,
	Picker,
	priorityOptions,
	statusOptions,
	tagOptions,
} from "../pickers";
import { RepeatPicker } from "../recurrence/repeat-picker";
import { useShortcut } from "../shortcuts";
import type { useTaskEdits } from "../task-edits";
import { TaskTimeRow } from "../time/task-time-row";
import type { WorkProjectContext } from "../views/types";

type Edits = ReturnType<typeof useTaskEdits>;

function Row({
	label,
	children,
	hint,
}: {
	label: string;
	children: ReactNode;
	hint?: string | null;
}) {
	return (
		<div className="contents">
			<dt className="flex h-8 items-center text-sm text-muted-foreground">
				{hint ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="cursor-help underline decoration-dotted underline-offset-4">
								{label}
							</span>
						</TooltipTrigger>
						<TooltipContent>{hint}</TooltipContent>
					</Tooltip>
				) : (
					label
				)}
			</dt>
			<dd className="flex min-h-8 min-w-0 items-center">{children}</dd>
		</div>
	);
}

/** A value that opens its editor: looks like text, behaves like a button. */
function ValueButton({
	children,
	disabled,
	label,
	...props
}: React.ComponentProps<"button"> & { label: string }) {
	return (
		<button
			type="button"
			aria-label={label}
			disabled={disabled}
			className={cn(
				"-mx-2 flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-left text-sm transition-colors duration-(--duration-quick) outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent",
			)}
			{...props}
		>
			{children}
		</button>
	);
}

const empty = (v: unknown) =>
	v === null ||
	v === undefined ||
	v === "" ||
	(Array.isArray(v) && v.length === 0);

function FieldRow({
	field,
	task,
	project,
	edits,
	me,
}: {
	field: WorkField;
	task: WorkTask;
	project: WorkProjectContext;
	edits: Edits;
	me?: string;
}) {
	const [open, setOpen] = useState(false);
	const value = task.fields[field.id];
	const label = `${field.name}${field.required ? " (required)" : ""}`;
	if (field.kind === "checkbox")
		return (
			<Row label={label} hint={field.description}>
				<Switch
					aria-label={field.name}
					disabled={!project.canEdit}
					checked={value === true}
					onCheckedChange={(v) =>
						void edits.setField(task, field.id, v ? true : null)
					}
				/>
			</Row>
		);
	return (
		<Row label={label} hint={field.description}>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<ValueButton
						label={`${field.name}: edit`}
						disabled={!project.canEdit}
					>
						{empty(value) ? (
							<span className="text-muted-foreground/70">Empty</span>
						) : (
							<FieldDisplay
								field={field}
								value={value}
								people={project.people}
							/>
						)}
					</ValueButton>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-72 p-2">
					<FieldEditor
						field={field}
						value={value}
						people={project.people}
						me={me}
						onCommit={(v) => {
							void edits.setField(task, field.id, v);
							const multi =
								field.kind === "multi_select" ||
								(field.config.kind === "user" && field.config.multiple);
							if (!multi) setOpen(false);
						}}
						onCancel={() => setOpen(false)}
					/>
				</PopoverContent>
			</Popover>
		</Row>
	);
}

export function Properties({
	task,
	project,
	edits,
	me,
}: {
	task: WorkTask;
	project: WorkProjectContext;
	edits: Edits;
	me?: string;
}) {
	const [open, setOpen] = useState<null | "s" | "a" | "d" | "p" | "l">(null);
	const [showEmpty, setShowEmpty] = useState(false);
	const createTag = useCreateWorkTag();
	const can = project.canEdit;
	const toggle = (k: typeof open) => (o: boolean) => setOpen(o ? k : null);
	useShortcut("s", () => can && setOpen("s"));
	useShortcut("a", () => can && setOpen("a"));
	useShortcut("d", () => can && setOpen("d"));
	useShortcut("p", () => can && setOpen("p"));
	useShortcut("l", () => can && setOpen("l"));

	const status = project.statuses.find((s) => s.id === task.statusId);
	const list = project.lists.find((l) => l.id === task.listId);
	const fields = project.fields.filter(
		(f) => !f.listId || f.listId === task.listId,
	);
	const filled = fields.filter((f) => !empty(task.fields[f.id]) || f.required);
	const blank = fields.filter((f) => empty(task.fields[f.id]) && !f.required);
	const [estimate, setEstimate] = useState<string | null>(null);

	return (
		<dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 gap-y-0.5">
			<Row label="Status">
				<Picker
					open={open === "s"}
					onOpenChange={toggle("s")}
					trigger={
						<ValueButton
							label={`Status: ${status?.name}. Change (S)`}
							disabled={!can}
						>
							<StatusIcon status={status} />
							{status?.name}
						</ValueButton>
					}
					options={statusOptions(project.statuses)}
					value={[task.statusId]}
					onChange={([statusId]) =>
						statusId && void edits.patch(task, { statusId })
					}
					placeholder="Status…"
				/>
			</Row>
			<Row label="Assignees">
				<PeoplePicker
					open={open === "a"}
					onOpenChange={toggle("a")}
					people={project.people}
					me={me}
					value={task.assigneeIds}
					onChange={(ids) => void edits.setAssignees(task, ids)}
					trigger={
						<ValueButton label="Assignees: change (A)" disabled={!can}>
							{task.assigneeIds.length ? (
								<>
									<AvatarStack people={project.people} ids={task.assigneeIds} />
									{task.assigneeIds.length === 1 && (
										<span className="truncate">
											{
												project.people.find(
													(p) => p.userId === task.assigneeIds[0],
												)?.name
											}
										</span>
									)}
								</>
							) : (
								<span className="text-muted-foreground/70">No one</span>
							)}
						</ValueButton>
					}
				/>
			</Row>
			<Row label="Dates">
				<span className="flex min-w-0 flex-wrap items-center gap-1">
					<DateRangePicker
						open={open === "d"}
						onOpenChange={toggle("d")}
						value={task}
						onChange={(v) => void edits.patch(task, v)}
						trigger={
							<ValueButton label="Dates: change (D)" disabled={!can}>
								<DateRangeLabel value={task} />
							</ValueButton>
						}
					/>
					<RepeatPicker
						value={task.recurrence}
						dueDate={task.dueDate}
						disabled={!can}
						onChange={(recurrence) => void edits.patch(task, { recurrence })}
					/>
				</span>
			</Row>
			<Row label="Priority">
				<Picker
					open={open === "p"}
					onOpenChange={toggle("p")}
					trigger={
						<ValueButton
							label={`Priority: ${priorityMeta(task.priority).label}. Change (P)`}
							disabled={!can}
						>
							<PriorityIcon priority={task.priority} />
							{priorityMeta(task.priority).label}
						</ValueButton>
					}
					options={priorityOptions()}
					value={[task.priority]}
					onChange={([p]) =>
						p && void edits.patch(task, { priority: p as WorkTask["priority"] })
					}
				/>
			</Row>
			<Row label="Tags">
				<Picker
					open={open === "l"}
					onOpenChange={toggle("l")}
					multiple
					trigger={
						<ValueButton label="Tags: change (L)" disabled={!can}>
							{task.tagIds.length ? (
								<TagChips tags={project.tags} ids={task.tagIds} max={4} />
							) : (
								<span className="text-muted-foreground/70">None</span>
							)}
						</ValueButton>
					}
					options={tagOptions(project.tags)}
					value={task.tagIds}
					onChange={(ids) => void edits.setTags(task, ids)}
					onCreate={async (name) => {
						const tag = await createTag.mutateAsync({
							projectId: project.id,
							input: {
								name,
								color: WORK_COLORS[project.tags.length % WORK_COLORS.length],
							},
						});
						void edits.setTags(task, [...task.tagIds, tag.id]);
					}}
					placeholder="Tags…"
				/>
			</Row>
			<Row label="List">
				<Picker
					trigger={
						<ValueButton label={`List: ${list?.name}. Move`} disabled={!can}>
							<ColorDot color={list?.color} />
							<span className="truncate">{list?.name}</span>
						</ValueButton>
					}
					options={listOptions(project.lists)}
					value={[task.listId]}
					onChange={([listId]) =>
						listId &&
						listId !== task.listId &&
						void edits.move(task, { listId })
					}
					placeholder="Move to list…"
				/>
			</Row>
			<Row label="Estimate">
				{estimate === null ? (
					<ValueButton
						label="Estimate: change"
						disabled={!can}
						onClick={() => setEstimate(formatMinutes(task.estimateMinutes))}
					>
						{task.estimateMinutes ? (
							<span className="tabular">
								{formatMinutes(task.estimateMinutes)}
							</span>
						) : (
							<span className="text-muted-foreground/70">None</span>
						)}
					</ValueButton>
				) : (
					<Input
						autoFocus
						aria-label="Estimate"
						value={estimate}
						placeholder="1h30, 90m, 2h"
						onChange={(e) => setEstimate(e.target.value)}
						onBlur={() => {
							const m = estimate.trim() ? parseMinutes(estimate) : null;
							if (estimate.trim() && m === null) return;
							if (m !== task.estimateMinutes)
								void edits.patch(task, { estimateMinutes: m });
							setEstimate(null);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
							if (e.key === "Escape") setEstimate(null);
						}}
						aria-invalid={
							estimate.trim() !== "" && parseMinutes(estimate) === null
								? true
								: undefined
						}
						className="h-8 w-36"
					/>
				)}
			</Row>
			{project.settings.timeTracking && (
				<Row label="Time">
					<TaskTimeRow
						taskId={task.id}
						estimateMinutes={task.estimateMinutes}
					/>
				</Row>
			)}
			<Row label="Milestone">
				<span className="flex items-center gap-2">
					<Switch
						aria-label="Milestone"
						disabled={!can}
						checked={task.isMilestone}
						onCheckedChange={(v) => void edits.patch(task, { isMilestone: v })}
					/>
					{task.isMilestone && (
						<Diamond
							className="size-3.5 fill-current text-info-text"
							aria-hidden
						/>
					)}
				</span>
			</Row>
			{filled.map((f) => (
				<FieldRow
					key={f.id}
					field={f}
					task={task}
					project={project}
					edits={edits}
					me={me}
				/>
			))}
			{showEmpty &&
				blank.map((f) => (
					<FieldRow
						key={f.id}
						field={f}
						task={task}
						project={project}
						edits={edits}
						me={me}
					/>
				))}
			{blank.length > 0 && (
				<div className="col-span-2">
					<Button
						variant="ghost"
						size="sm"
						className="-ml-2 text-muted-foreground"
						onClick={() => setShowEmpty((s) => !s)}
						aria-expanded={showEmpty}
					>
						{showEmpty
							? "Hide empty fields"
							: `Show ${blank.length} empty ${blank.length === 1 ? "field" : "fields"}`}
					</Button>
				</div>
			)}
		</dl>
	);
}
