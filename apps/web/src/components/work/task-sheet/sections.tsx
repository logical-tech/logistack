/* Task sheet sections: subtasks, checklist, dependencies and attachments. */
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
	WorkAttachment,
	WorkChecklistItem,
	WorkDependencyEdge,
	WorkTask,
	WorkTaskListItem,
} from "@logistack/contracts";
import {
	ChevronLeft,
	ChevronRight,
	Download,
	File as FileIcon,
	GripVertical,
	MoreHorizontal,
	Paperclip,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	useAddWorkDependency,
	useConvertWorkChecklistItem,
	useCreateWorkChecklistItem,
	useDeleteWorkAttachment,
	useDeleteWorkChecklistItem,
	useRemoveWorkDependency,
	useUpdateWorkChecklistItem,
	useUploadWorkAttachment,
	useWorkSearch,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { isClosed } from "../lib";
import {
	AvatarStack,
	DueDate,
	PersonAvatar,
	StatusIcon,
	TaskKey,
} from "../parts";
import { OptionList, PeoplePicker, statusOptions } from "../pickers";
import type { useTaskEdits } from "../task-edits";
import type { WorkProjectContext } from "../views/types";
import { useOpenTask } from "./open-task";

type Edits = ReturnType<typeof useTaskEdits>;

export function Section({
	title,
	count,
	actions,
	children,
	id,
}: {
	title: string;
	count?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	id: string;
}) {
	return (
		<section aria-labelledby={id} className="grid gap-2">
			<div className="flex min-h-7 items-center gap-2">
				<h3 id={id} className="text-sm font-semibold [font-stretch:100%]">
					{title}
				</h3>
				{count !== undefined && (
					<span className="text-xs text-muted-foreground tabular">{count}</span>
				)}
				<div className="ml-auto flex items-center gap-1">{actions}</div>
			</div>
			{children}
		</section>
	);
}

/** Up/down neighbours for a drag: the API wants `before` or `after` an id. */
function dropPosition(ids: string[], active: string, over: string) {
	const from = ids.indexOf(active);
	const to = ids.indexOf(over);
	return from < to ? { after: over } : { before: over };
}

function useDnd() {
	return useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
}

function SortableRow({
	id,
	children,
	label,
	disabled,
}: {
	id: string;
	children: ReactNode;
	label: string;
	disabled?: boolean;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id, disabled });
	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			className={cn(
				"group/item flex min-h-9 items-center gap-2 rounded-md px-1 hover:bg-muted/50",
				isDragging && "z-10 bg-card shadow-float",
			)}
		>
			{!disabled && (
				<button
					type="button"
					aria-label={`Reorder ${label}`}
					className="grid size-5 shrink-0 cursor-grab place-items-center rounded-sm text-muted-foreground/50 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100"
					{...attributes}
					{...listeners}
				>
					<GripVertical className="size-3.5" />
				</button>
			)}
			{children}
		</li>
	);
}

function AddRow({
	placeholder,
	onAdd,
	label,
}: {
	placeholder: string;
	label: string;
	onAdd: (text: string) => Promise<unknown>;
}) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<form
			onSubmit={async (e) => {
				e.preventDefault();
				const t = text.trim();
				if (!t) return;
				setBusy(true);
				try {
					await onAdd(t);
					setText("");
				} catch (err) {
					toast.error(`${label} wasn't added`, {
						description: err instanceof Error ? err.message : undefined,
					});
				} finally {
					setBusy(false);
				}
			}}
			className="flex items-center gap-2 pl-7"
		>
			<Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
			<Input
				value={text}
				disabled={busy}
				aria-label={label}
				placeholder={placeholder}
				onChange={(e) => setText(e.target.value)}
				className="h-8 border-transparent bg-transparent px-1 shadow-none hover:border-input focus-visible:border-input dark:bg-transparent"
			/>
		</form>
	);
}

// --- subtasks ---------------------------------------------------------------

export function Subtasks({
	task,
	project,
	edits,
	onCreate,
}: {
	task: WorkTask;
	project: WorkProjectContext;
	edits: Edits;
	onCreate: (title: string) => Promise<unknown>;
}) {
	const openTask = useOpenTask();
	const sensors = useDnd();
	const subs = task.subtasks;
	if (task.parentId) return null;
	const done = subs.filter((s) =>
		isClosed(project.statuses.find((x) => x.id === s.statusId)),
	).length;
	const onDragEnd = (e: DragEndEvent) => {
		if (!e.over || e.active.id === e.over.id) return;
		const sub = subs.find((s) => s.id === e.active.id);
		if (sub)
			void edits.move(
				sub,
				dropPosition(
					subs.map((s) => s.id),
					String(e.active.id),
					String(e.over.id),
				),
			);
	};
	return (
		<Section
			id="sheet-subtasks"
			title="Subtasks"
			count={subs.length ? `${done}/${subs.length}` : undefined}
		>
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={onDragEnd}
			>
				<SortableContext
					items={subs.map((s) => s.id)}
					strategy={verticalListSortingStrategy}
				>
					<ul className="grid">
						{subs.map((s) => (
							<SubtaskRow
								key={s.id}
								sub={s}
								project={project}
								edits={edits}
								onOpen={() => openTask(s.id)}
							/>
						))}
					</ul>
				</SortableContext>
			</DndContext>
			{project.canEdit && (
				<AddRow
					placeholder="Add a subtask, then Enter"
					label="Subtask"
					onAdd={onCreate}
				/>
			)}
		</Section>
	);
}

function SubtaskRow({
	sub,
	project,
	edits,
	onOpen,
}: {
	sub: WorkTaskListItem;
	project: WorkProjectContext;
	edits: Edits;
	onOpen: () => void;
}) {
	const status = project.statuses.find((s) => s.id === sub.statusId);
	const [open, setOpen] = useState(false);
	return (
		<SortableRow id={sub.id} label={sub.key} disabled={!project.canEdit}>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={`${sub.key} status: ${status?.name}. Change`}
						disabled={!project.canEdit}
						className="grid size-6 shrink-0 place-items-center rounded-sm hover:bg-muted"
					>
						<StatusIcon status={status} />
					</button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-56 p-1">
					<OptionList
						options={statusOptions(project.statuses)}
						value={[sub.statusId]}
						onChange={([statusId]) =>
							statusId && void edits.patch(sub, { statusId })
						}
						onDone={() => setOpen(false)}
					/>
				</PopoverContent>
			</Popover>
			<button
				type="button"
				onClick={onOpen}
				className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none focus-visible:underline"
			>
				<TaskKey value={sub.key} className="shrink-0" />
				<span
					className={cn(
						"truncate",
						isClosed(status) && "text-muted-foreground line-through",
					)}
				>
					{sub.title}
				</span>
			</button>
			<AvatarStack
				people={project.people}
				ids={sub.assigneeIds ?? []}
				max={2}
			/>
			<DueDate
				date={sub.dueDate}
				closed={isClosed(status)}
				className="w-16 text-right"
			/>
		</SortableRow>
	);
}

// --- checklist ----------------------------------------------------------------

export function Checklist({
	task,
	project,
	me,
}: {
	task: WorkTask;
	project: WorkProjectContext;
	me?: string;
}) {
	const create = useCreateWorkChecklistItem();
	const update = useUpdateWorkChecklistItem();
	const remove = useDeleteWorkChecklistItem();
	const convert = useConvertWorkChecklistItem();
	const sensors = useDnd();
	const items = task.checklist;
	const done = items.filter((i) => i.done).length;
	const onDragEnd = (e: DragEndEvent) => {
		if (!e.over || e.active.id === e.over.id) return;
		update.mutate({
			taskId: task.id,
			id: String(e.active.id),
			patch: dropPosition(
				items.map((i) => i.id),
				String(e.active.id),
				String(e.over.id),
			),
		});
	};
	return (
		<Section
			id="sheet-checklist"
			title="Checklist"
			count={items.length ? `${done}/${items.length}` : undefined}
		>
			{items.length > 0 && (
				<div
					role="progressbar"
					aria-label="Checklist progress"
					aria-valuenow={done}
					aria-valuemax={items.length}
					className="h-1 overflow-hidden rounded-full bg-muted"
				>
					<span
						className="block h-full rounded-full bg-ok transition-[width] duration-(--duration-slow) ease-(--ease-smooth-out)"
						style={{ width: `${(done / items.length) * 100}%` }}
					/>
				</div>
			)}
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={onDragEnd}
			>
				<SortableContext
					items={items.map((i) => i.id)}
					strategy={verticalListSortingStrategy}
				>
					<ul className="grid">
						{items.map((item) => (
							<ChecklistRow
								key={item.id}
								item={item}
								project={project}
								me={me}
								onPatch={(patch) =>
									update.mutate({ taskId: task.id, id: item.id, patch })
								}
								onDelete={() => remove.mutate({ taskId: task.id, id: item.id })}
								onConvert={() =>
									convert.mutate(
										{ taskId: task.id, id: item.id },
										{ onSuccess: (t) => toast.success(`Now subtask ${t.key}`) },
									)
								}
							/>
						))}
					</ul>
				</SortableContext>
			</DndContext>
			{project.canEdit && (
				<AddRow
					placeholder="Add an item, then Enter"
					label="Checklist item"
					onAdd={(text) =>
						create.mutateAsync({ taskId: task.id, input: { text } })
					}
				/>
			)}
		</Section>
	);
}

function ChecklistRow({
	item,
	project,
	me,
	onPatch,
	onDelete,
	onConvert,
}: {
	item: WorkChecklistItem;
	project: WorkProjectContext;
	me?: string;
	onPatch: (p: {
		text?: string;
		done?: boolean;
		assigneeId?: string | null;
	}) => void;
	onDelete: () => void;
	onConvert: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(item.text);
	// Commenters may tick items assigned to them.
	const canTick = project.canEdit || item.assigneeId === me;
	const assignee = project.people.find((p) => p.userId === item.assigneeId);
	return (
		<SortableRow id={item.id} label={item.text} disabled={!project.canEdit}>
			<Checkbox
				aria-label={item.text}
				checked={item.done}
				disabled={!canTick}
				onCheckedChange={(v) => onPatch({ done: v === true })}
			/>
			{editing ? (
				<Input
					autoFocus
					aria-label="Item text"
					value={text}
					onChange={(e) => setText(e.target.value)}
					onBlur={() => {
						setEditing(false);
						if (text.trim() && text.trim() !== item.text)
							onPatch({ text: text.trim() });
						else setText(item.text);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							setText(item.text);
							setEditing(false);
						}
					}}
					className="h-7"
				/>
			) : (
				<button
					type="button"
					disabled={!project.canEdit}
					onClick={() => setEditing(true)}
					className={cn(
						"min-w-0 flex-1 truncate text-left text-sm",
						item.done && "text-muted-foreground line-through",
					)}
				>
					{item.text}
				</button>
			)}
			<PeoplePicker
				people={project.people}
				me={me}
				multiple={false}
				value={item.assigneeId ? [item.assigneeId] : []}
				onChange={([id]) => onPatch({ assigneeId: id ?? null })}
				trigger={
					<button
						type="button"
						disabled={!project.canEdit}
						aria-label={
							assignee ? `Assigned to ${assignee.name}. Change` : "Assign item"
						}
						className={cn(
							"grid size-6 shrink-0 place-items-center rounded-full",
							!assignee &&
								"opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100",
						)}
					>
						{assignee ? (
							<PersonAvatar person={assignee} />
						) : (
							<span className="size-5 rounded-full border border-dashed border-muted-foreground/50" />
						)}
					</button>
				}
			/>
			{project.canEdit && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={`More for “${item.text}”`}
							className="opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
						>
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={onConvert}>
							Convert to subtask
						</DropdownMenuItem>
						<DropdownMenuItem variant="destructive" onSelect={onDelete}>
							<Trash2 /> Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</SortableRow>
	);
}

// --- dependencies -------------------------------------------------------------

function TaskSearchPicker({
	projectId,
	exclude,
	onPick,
	trigger,
}: {
	projectId: string;
	exclude: string[];
	onPick: (id: string) => void;
	trigger: ReactNode;
}) {
	const [q, setQ] = useState("");
	const [open, setOpen] = useState(false);
	const { data } = useWorkSearch(q, projectId);
	const hits = (data?.items ?? []).filter(
		(h) => !exclude.includes(h.id) && h.projectId === projectId,
	);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-1">
				<Input
					autoFocus
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Search by key or title"
					aria-label="Find a task"
					className="mb-1 h-8"
				/>
				<ul className="max-h-64 overflow-y-auto">
					{hits.map((h) => (
						<li key={h.id}>
							<button
								type="button"
								onClick={() => {
									onPick(h.id);
									setOpen(false);
									setQ("");
								}}
								className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
							>
								<TaskKey value={h.key} className="w-16 shrink-0" />
								<span className="truncate">{h.title}</span>
							</button>
						</li>
					))}
					{q && hits.length === 0 && (
						<li className="px-2 py-1.5 text-sm text-muted-foreground">
							No task in this project matches.
						</li>
					)}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

function DependencyList({
	edges,
	project,
	onRemove,
	empty,
}: {
	edges: WorkDependencyEdge[];
	project: WorkProjectContext;
	onRemove?: (e: WorkDependencyEdge) => void;
	empty: string;
}) {
	const openTask = useOpenTask();
	if (!edges.length)
		return <p className="pl-1 text-sm text-muted-foreground/80">{empty}</p>;
	return (
		<ul className="grid">
			{edges.map((e) => {
				const status = project.statuses.find((s) => s.id === e.statusId);
				return (
					<li
						key={e.id}
						className="group/item flex min-h-8 items-center gap-2 rounded-md px-1 hover:bg-muted/50"
					>
						<StatusIcon status={status} />
						<button
							type="button"
							onClick={() => openTask(e.id)}
							className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
						>
							<TaskKey value={e.key} />
							<span
								className={cn(
									"truncate",
									e.done && "text-muted-foreground line-through",
								)}
							>
								{e.title}
							</span>
							{e.lagDays !== 0 && (
								<span className="shrink-0 text-xs text-muted-foreground">
									{e.lagDays > 0 ? `+${e.lagDays}` : e.lagDays} d
								</span>
							)}
						</button>
						{onRemove && (
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={`Remove ${e.key}`}
								onClick={() => onRemove(e)}
								className="opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100"
							>
								<X />
							</Button>
						)}
					</li>
				);
			})}
		</ul>
	);
}

export function Dependencies({
	task,
	project,
}: {
	task: WorkTask;
	project: WorkProjectContext;
}) {
	const add = useAddWorkDependency();
	const remove = useRemoveWorkDependency();
	const { blockedBy, blocking } = task.dependencies;
	const open = blockedBy.filter((e) => !e.done).length;
	const exclude = [
		task.id,
		...blockedBy.map((e) => e.id),
		...blocking.map((e) => e.id),
	];
	return (
		<Section
			id="sheet-deps"
			title="Dependencies"
			count={open ? `Blocked by ${open}` : undefined}
			actions={
				project.canEdit && (
					<TaskSearchPicker
						projectId={project.id}
						exclude={exclude}
						onPick={(blockedById) =>
							add.mutate(
								{ id: task.id, input: { blockedById } },
								{
									onError: (e) =>
										toast.error("That dependency wasn't added", {
											description: e instanceof Error ? e.message : undefined,
										}),
								},
							)
						}
						trigger={
							<Button variant="ghost" size="xs">
								<Plus data-icon="inline-start" /> Blocked by…
							</Button>
						}
					/>
				)
			}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="grid content-start gap-1">
					<h4 className="text-xs font-medium text-muted-foreground">
						Blocked by
					</h4>
					<DependencyList
						edges={blockedBy}
						project={project}
						empty="Nothing has to finish first."
						onRemove={
							project.canEdit
								? (e) => remove.mutate({ id: task.id, blockedById: e.id })
								: undefined
						}
					/>
				</div>
				<div className="grid content-start gap-1">
					<h4 className="text-xs font-medium text-muted-foreground">
						Blocking
					</h4>
					<DependencyList
						edges={blocking}
						project={project}
						empty="Nothing waits on this."
					/>
				</div>
			</div>
		</Section>
	);
}

// --- attachments --------------------------------------------------------------

const isImage = (a: WorkAttachment) =>
	a.contentType.startsWith("image/") && a.contentType !== "image/svg+xml";
const size = (n: number) =>
	n < 1024
		? `${n} B`
		: n < 1_048_576
			? `${Math.round(n / 1024)} KB`
			: `${(n / 1_048_576).toFixed(1)} MB`;

export function useUploadFiles(task: WorkTask) {
	const upload = useUploadWorkAttachment();
	return (files: File[]) =>
		Promise.all(
			files.map((file) =>
				upload.mutateAsync({ file, taskId: task.id }).catch((e) =>
					toast.error(`${file.name} wasn't uploaded`, {
						description: e instanceof Error ? e.message : undefined,
					}),
				),
			),
		);
}

export function Attachments({
	task,
	project,
}: {
	task: WorkTask;
	project: WorkProjectContext;
}) {
	const upload = useUploadFiles(task);
	const remove = useDeleteWorkAttachment();
	const input = useRef<HTMLInputElement>(null);
	const [viewing, setViewing] = useState<number | null>(null);
	const items = task.attachments.filter(
		(a) => a.inlineIn === "none" && !a.commentId,
	);
	const images = items.filter(isImage);
	const files = items.filter((a) => !isImage(a));
	return (
		<Section
			id="sheet-attachments"
			title="Attachments"
			count={items.length || undefined}
			actions={
				project.canEdit && (
					<>
						<input
							ref={input}
							type="file"
							multiple
							hidden
							onChange={(e) => {
								void upload([...(e.target.files ?? [])]);
								e.target.value = "";
							}}
						/>
						<Button
							variant="ghost"
							size="xs"
							onClick={() => input.current?.click()}
						>
							<Paperclip data-icon="inline-start" /> Attach
						</Button>
					</>
				)
			}
		>
			{items.length === 0 ? (
				<p className="text-sm text-muted-foreground/80">
					{project.canEdit
						? "Drop files anywhere on this panel, or paste a screenshot."
						: "No files."}
				</p>
			) : (
				<>
					{images.length > 0 && (
						<ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
							{images.map((a, i) => (
								<li key={a.id} className="group/att relative">
									<button
										type="button"
										onClick={() => setViewing(i)}
										aria-label={`View ${a.name}`}
										className="block aspect-[4/3] w-full overflow-hidden rounded-lg bg-muted outline-1 -outline-offset-1 outline-black/10 focus-visible:ring-2 focus-visible:ring-ring dark:outline-white/10"
									>
										<img
											src={a.thumbUrl ?? a.url}
											alt=""
											loading="lazy"
											className="size-full object-cover transition-transform duration-(--duration-fast) group-hover/att:scale-[1.03]"
										/>
									</button>
									<span className="mt-1 block truncate text-xs text-muted-foreground">
										{a.name}
									</span>
								</li>
							))}
						</ul>
					)}
					{files.length > 0 && (
						<ul className="grid gap-1">
							{files.map((a) => (
								<li
									key={a.id}
									className="group/item flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50"
								>
									<FileIcon
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
									<a
										href={a.url}
										download={a.name}
										className="min-w-0 flex-1 truncate text-sm hover:underline"
									>
										{a.name}
									</a>
									<span className="text-xs text-muted-foreground tabular">
										{size(a.size)}
									</span>
									{project.canEdit && (
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label={`Delete ${a.name}`}
											onClick={() =>
												remove.mutate({ taskId: task.id, id: a.id })
											}
											className="opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100"
										>
											<Trash2 />
										</Button>
									)}
								</li>
							))}
						</ul>
					)}
				</>
			)}
			<Lightbox images={images} index={viewing} onIndex={setViewing} />
		</Section>
	);
}

export function Lightbox({
	images,
	index,
	onIndex,
}: {
	images: WorkAttachment[];
	index: number | null;
	onIndex: (i: number | null) => void;
}) {
	const current = index === null ? undefined : images[index];
	const step = (d: number) =>
		index !== null && onIndex((index + d + images.length) % images.length);
	return (
		<Dialog open={!!current} onOpenChange={(o) => !o && onIndex(null)}>
			<DialogContent
				className="max-w-[min(92vw,1200px)] gap-3 bg-popover p-3 sm:max-w-[min(92vw,1200px)]"
				onKeyDown={(e) => {
					if (e.key === "ArrowRight") step(1);
					if (e.key === "ArrowLeft") step(-1);
				}}
			>
				<DialogTitle className="pr-8 text-sm font-medium">
					{current?.name}
					{images.length > 1 && (
						<span className="ml-2 font-normal text-muted-foreground tabular">
							{(index ?? 0) + 1} of {images.length}
						</span>
					)}
				</DialogTitle>
				{current && (
					<img
						src={current.url}
						alt={current.name}
						className="max-h-[75vh] w-full rounded-md object-contain"
					/>
				)}
				<div className="flex items-center justify-between">
					<div className="flex gap-1">
						<Button
							variant="outline"
							size="icon-sm"
							aria-label="Previous image"
							disabled={images.length < 2}
							onClick={() => step(-1)}
						>
							<ChevronLeft />
						</Button>
						<Button
							variant="outline"
							size="icon-sm"
							aria-label="Next image"
							disabled={images.length < 2}
							onClick={() => step(1)}
						>
							<ChevronRight />
						</Button>
					</div>
					{current && (
						<Button variant="outline" size="sm" asChild>
							<a href={current.url} download={current.name}>
								<Download data-icon="inline-start" /> Download
							</a>
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
