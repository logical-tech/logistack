/*
 * One table cell per column kind: how it reads, and how it edits (in place for text, in a popover
 * for pickers). Editors are the same ones the task sheet uses.
 */
import type { ColumnKey, WorkTaskListItem } from "@logistack/contracts";
import { ChevronRight, CornerDownRight, Repeat } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Column } from "../columns";
import { FieldDisplay, FieldEditor } from "../field-editor";
import {
	formatDay,
	formatMinutes,
	isClosed,
	parseMinutes,
	priorityMeta,
	timeAgo,
} from "../lib";
import {
	AvatarStack,
	ColorDot,
	DueDate,
	PriorityIcon,
	StatusIcon,
	TagChips,
	TaskKey,
} from "../parts";
import {
	DateRangePicker,
	listOptions,
	OptionList,
	peopleOptions,
	priorityOptions,
	statusOptions,
	tagOptions,
} from "../pickers";
import type { useTaskEdits } from "../task-edits";
import type { WorkProjectContext } from "./types";

/** Columns that can't be edited in the table. */
export const READ_ONLY = new Set<string>([
	"key",
	"tracked",
	"createdAt",
	"updatedAt",
]);

/** Edited by typing straight into the cell. */
const INLINE = new Set<string>(["title", "estimate"]);
const isInlineField = (col: Column) =>
	!!col.field &&
	["text", "number", "currency", "percent", "url", "email", "phone"].includes(
		col.field.kind,
	);

export function isEditable(col: Column) {
	return !READ_ONLY.has(col.key);
}

type Edits = ReturnType<typeof useTaskEdits>;

function CellPopover({
	open,
	onClose,
	anchor,
	children,
	className,
}: {
	open: boolean;
	onClose: () => void;
	anchor: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Popover open={open} onOpenChange={(o) => !o && onClose()}>
			<PopoverAnchor asChild>{anchor}</PopoverAnchor>
			<PopoverContent
				align="start"
				sideOffset={2}
				className={cn("w-64 p-1", className)}
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				{children}
			</PopoverContent>
		</Popover>
	);
}

function InlineInput({
	initial,
	label,
	onCommit,
	onCancel,
	parse,
}: {
	initial: string;
	label: string;
	onCommit: (v: string, next: boolean) => void;
	onCancel: () => void;
	parse?: (v: string) => string | null;
}) {
	const [v, setV] = useState(initial);
	const [bad, setBad] = useState(false);
	const commit = (next: boolean) => {
		if (parse && v.trim() && parse(v) === null) {
			setBad(true);
			return;
		}
		onCommit(v, next);
	};
	return (
		<Input
			autoFocus
			aria-label={label}
			aria-invalid={bad || undefined}
			value={v}
			onChange={(e) => {
				setV(e.target.value);
				setBad(false);
			}}
			onFocus={(e) => e.currentTarget.select()}
			onBlur={() => commit(false)}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Escape") {
					e.preventDefault();
					onCancel();
				} else if (e.key === "Enter") {
					e.preventDefault();
					commit(false);
				} else if (e.key === "Tab") {
					e.preventDefault();
					commit(true);
				}
			}}
			className="h-7 rounded-sm px-1.5 text-sm"
		/>
	);
}

export function TableCell({
	col,
	task,
	project,
	edits,
	editing,
	onStopEdit,
	me,
	nested,
}: {
	col: Column;
	task: WorkTaskListItem;
	project: WorkProjectContext;
	edits: Edits;
	editing: boolean;
	/** `next`: move to the next cell (Tab). */
	onStopEdit: (next?: boolean) => void;
	me?: string;
	nested?: {
		depth: number;
		expandable: boolean;
		expanded: boolean;
		onToggle: () => void;
	};
}) {
	const status = project.statuses.find((s) => s.id === task.statusId);
	const closed = isClosed(status);
	const close = () => onStopEdit(false);

	switch (col.key) {
		case "key":
			return <TaskKey value={task.key} />;
		case "title": {
			const counts = task.counts;
			return (
				<span className="flex min-w-0 flex-1 items-center gap-1.5">
					{nested && nested.depth > 0 && (
						<CornerDownRight
							className="ml-1 size-3.5 shrink-0 text-muted-foreground/60"
							aria-hidden
						/>
					)}
					{nested?.expandable && (
						<button
							type="button"
							tabIndex={-1}
							aria-label={nested.expanded ? "Hide subtasks" : "Show subtasks"}
							aria-expanded={nested.expanded}
							onClick={(e) => {
								e.stopPropagation();
								nested.onToggle();
							}}
							className="-ml-1 grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
						>
							<ChevronRight
								className={cn(
									"size-3.5 transition-transform duration-(--duration-quick)",
									nested.expanded && "rotate-90",
								)}
							/>
						</button>
					)}
					{editing ? (
						<InlineInput
							initial={task.title}
							label="Title"
							onCancel={close}
							onCommit={(v, next) => {
								const t = v.trim();
								if (t && t !== task.title) void edits.patch(task, { title: t });
								onStopEdit(next);
							}}
						/>
					) : (
						<span
							className={cn(
								"truncate font-medium",
								closed &&
									"font-normal text-muted-foreground line-through decoration-muted-foreground/40",
							)}
						>
							{task.title}
						</span>
					)}
					{!editing && task.recurring && (
						<Repeat
							className="size-3 shrink-0 text-muted-foreground"
							aria-label="Repeats"
						/>
					)}
					{!editing && counts && counts.subtasks > 0 && (
						<span className="shrink-0 text-xs text-muted-foreground tabular">
							{counts.subtasksDone}/{counts.subtasks}
						</span>
					)}
					{!editing && task.blocked && (
						<span className="shrink-0 rounded-sm bg-bad/12 px-1 text-2xs font-medium text-bad-text">
							Blocked
						</span>
					)}
				</span>
			);
		}
		case "status": {
			const anchor = (
				<span className="flex min-w-0 items-center gap-1.5">
					<StatusIcon status={status} />
					<span className="truncate">{status?.name}</span>
				</span>
			);
			return editing ? (
				<CellPopover open onClose={close} anchor={anchor}>
					<OptionList
						options={statusOptions(project.statuses)}
						value={[task.statusId]}
						onChange={([statusId]) =>
							statusId && void edits.patch(task, { statusId })
						}
						onDone={close}
						placeholder="Status…"
					/>
				</CellPopover>
			) : (
				anchor
			);
		}
		case "priority": {
			const anchor = (
				<span className="flex items-center gap-1.5">
					<PriorityIcon priority={task.priority} />
					{task.priority !== "none" && (
						<span>{priorityMeta(task.priority).label}</span>
					)}
				</span>
			);
			return editing ? (
				<CellPopover open onClose={close} anchor={anchor}>
					<OptionList
						options={priorityOptions()}
						value={[task.priority]}
						onChange={([p]) =>
							p &&
							void edits.patch(task, {
								priority: p as WorkTaskListItem["priority"],
							})
						}
						onDone={close}
						placeholder="Priority…"
					/>
				</CellPopover>
			) : (
				anchor
			);
		}
		case "assignees": {
			const anchor = (
				<span className="flex min-h-5 items-center">
					<AvatarStack people={project.people} ids={task.assigneeIds ?? []} />
				</span>
			);
			return editing ? (
				<CellPopover open onClose={close} anchor={anchor}>
					<OptionList
						options={peopleOptions(project.people, {
							assignableOnly: true,
							me,
						})}
						value={task.assigneeIds ?? []}
						multiple
						onChange={(ids) => void edits.setAssignees(task, ids)}
						placeholder="Assign to…"
					/>
				</CellPopover>
			) : (
				anchor
			);
		}
		case "tags": {
			const anchor = (
				<span className="flex min-w-0 items-center">
					<TagChips tags={project.tags} ids={task.tagIds ?? []} max={2} />
				</span>
			);
			return editing ? (
				<CellPopover open onClose={close} anchor={anchor}>
					<OptionList
						options={tagOptions(project.tags)}
						value={task.tagIds ?? []}
						multiple
						onChange={(ids) => void edits.setTags(task, ids)}
						placeholder="Tags…"
					/>
				</CellPopover>
			) : (
				anchor
			);
		}
		case "list": {
			const list = project.lists.find((l) => l.id === task.listId);
			const anchor = (
				<span className="flex min-w-0 items-center gap-1.5">
					<ColorDot color={list?.color} />
					<span className="truncate">{list?.name}</span>
				</span>
			);
			return editing ? (
				<CellPopover open onClose={close} anchor={anchor}>
					<OptionList
						options={listOptions(project.lists)}
						value={[task.listId]}
						onChange={([listId]) => {
							if (listId && listId !== task.listId)
								void edits.move(task, { listId });
						}}
						onDone={close}
						placeholder="Move to list…"
					/>
				</CellPopover>
			) : (
				anchor
			);
		}
		case "startDate":
		case "dueDate": {
			const display =
				col.key === "dueDate" ? (
					<DueDate date={task.dueDate} closed={closed} />
				) : (
					<span className="text-xs text-muted-foreground tabular">
						{formatDay(task.startDate)}
					</span>
				);
			return editing ? (
				<DateRangePicker
					open
					onOpenChange={(o) => !o && close()}
					value={task}
					onChange={(v) => void edits.patch(task, v)}
					trigger={<span className="flex min-h-5 items-center">{display}</span>}
				/>
			) : (
				display
			);
		}
		case "estimate":
			return editing ? (
				<InlineInput
					initial={
						task.estimateMinutes ? formatMinutes(task.estimateMinutes) : ""
					}
					label="Estimate"
					parse={(v) => (parseMinutes(v) === null ? null : v)}
					onCancel={close}
					onCommit={(v, next) => {
						const m = v.trim() ? parseMinutes(v) : null;
						if (m !== task.estimateMinutes)
							void edits.patch(task, { estimateMinutes: m });
						onStopEdit(next);
					}}
				/>
			) : (
				<span className="text-xs text-muted-foreground tabular">
					{formatMinutes(task.estimateMinutes)}
				</span>
			);
		case "tracked":
			return (
				<span className="text-xs text-muted-foreground tabular">
					{task.trackedSec
						? formatMinutes(Math.round(task.trackedSec / 60))
						: ""}
				</span>
			);
		case "createdAt":
		case "updatedAt":
			return (
				<span className="text-xs text-muted-foreground">
					{timeAgo(task[col.key])}
				</span>
			);
	}

	const field = col.field;
	if (!field) return null;
	const value = task.fields?.[field.id];
	const display = (
		<FieldDisplay
			field={field}
			value={value}
			people={project.people}
			className="min-w-0"
		/>
	);
	// Checkboxes toggle without an editor (the table handles it).
	if (!editing || field.kind === "checkbox") return display;
	const commit = (v: unknown) => {
		void edits.setField(task, field.id, v);
	};
	if (isInlineField(col))
		return (
			<FieldEditor
				field={field}
				value={value}
				people={project.people}
				onCommit={(v) => {
					commit(v);
					close();
				}}
				onCancel={close}
			/>
		);
	return (
		<CellPopover
			open
			onClose={close}
			anchor={<span className="min-w-0">{display}</span>}
			className={
				field.kind === "long_text" || field.kind === "date"
					? "w-72 p-2"
					: undefined
			}
		>
			<FieldEditor
				field={field}
				value={value}
				people={project.people}
				me={me}
				onCommit={(v) => {
					commit(v);
					if (
						field.kind !== "multi_select" &&
						!(field.config.kind === "user" && field.config.multiple)
					)
						close();
				}}
				onCancel={close}
			/>
		</CellPopover>
	);
}

export const isInlineColumn = (col: Column) =>
	INLINE.has(col.key as ColumnKey) || isInlineField(col);
