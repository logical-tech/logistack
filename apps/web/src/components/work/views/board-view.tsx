/*
 * Board: columns from `groupBy`, optional swimlanes from `subGroupBy`. Each column
 * pages its own query (50 cards at a time); drags go through dnd-kit with pointer
 * and keyboard sensors, and land optimistically before the server answers.
 */
import {
	type Announcements,
	closestCorners,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	MouseSensor,
	TouchSensor,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
	GroupKey,
	WorkTaskCreate,
	WorkTaskListItem,
} from "@logistack/contracts";
import { localDate } from "@logistack/core/work";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Columns3, Lock, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
	patchCachedTask,
	useCreateWorkTask,
	useMoveWorkTask,
	usePatchWorkTask,
	useSetWorkTaskField,
	useWorkTaskAssignee,
	useWorkTasks,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { TaskCard } from "./board/card";
import {
	applyWrite,
	createDefaults,
	type Group,
	type GroupWrite,
	groupsFor,
	groupValues,
	writeFor,
} from "./board/groups";
import { boardKeyboardCoordinates } from "./board/keyboard";
import { WORK_DOT } from "./common/colors";
import { type ProjectMeta, useProjectMeta, viewTaskQuery } from "./common/data";
import type { ViewProps } from "./types";

const PAGE = 50;
const ALL = "*";

type Instance = { id: string; task: WorkTaskListItem };
/** A card shown somewhere other than where the server put it: a drag preview or an unsettled drop. */
type Placement = {
	instanceId: string;
	task: WorkTaskListItem;
	fromCell: string;
	toCell: string;
	/** Insert before this task; null = at the end. */
	before: string | null;
};

const cellId = (col: string, lane: string) => `${col}~${lane}`;
const splitCell = (id: string) => {
	const [col = "", lane = ALL] = id.split("~");
	return { col, lane };
};
const instanceOf = (cell: string, taskId: string) => `${cell}|${taskId}`;
const cellOfInstance = (id: string) => id.split("|")[0] ?? "";

const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function BoardView({
	project,
	config,
	onConfigChange,
	onOpenTask,
	listId,
}: ViewProps) {
	const meta = useProjectMeta(project.id);
	const now = useMemo(() => new Date(), []);
	const today = localDate(now);
	const groupBy: GroupKey = config.groupBy ?? "status";
	const columns = useMemo(
		() => (meta.ready ? groupsFor(groupBy, meta, now) : null),
		[groupBy, meta, now],
	);
	const lanes = useMemo<Group[] | null>(() => {
		if (!config.subGroupBy || !meta.ready) return null;
		return groupsFor(config.subGroupBy, meta, now);
	}, [config.subGroupBy, meta, now]);
	const baseQuery = useMemo(
		() => viewTaskQuery(project.id, config, listId, { limit: PAGE, groupBy }),
		[project.id, config, listId, groupBy],
	);

	const [placements, setPlacements] = useState<Placement[]>([]);
	const [preview, setPreview] = useState<Placement | null>(null);
	const [active, setActive] = useState<Instance | null>(null);
	const [blockedDrop, setBlockedDrop] = useState(false);
	/** Rendered order of every cell, refreshed each render, for drop maths and announcements. */
	const rendered = useRef(new Map<string, Instance[]>());
	const lastSwitch = useRef(0);

	const qc = useQueryClient();
	const move = useMoveWorkTask();
	const patch = usePatchWorkTask();
	const assignee = useWorkTaskAssignee();
	const setField = useSetWorkTaskField();

	const collapsed = new Set(config.collapsedGroups);
	const toggleCollapsed = (key: string) =>
		onConfigChange({
			collapsedGroups: collapsed.has(key)
				? config.collapsedGroups.filter((k) => k !== key)
				: [...config.collapsedGroups, key],
		});

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
		// A short press on touch, so swiping still scrolls the board.
		useSensor(TouchSensor, {
			activationConstraint: { delay: 220, tolerance: 6 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: boardKeyboardCoordinates,
			// Enter opens the card; Space lifts and drops.
			keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
		}),
	);

	if (!meta.ready || !columns)
		return meta.ready ? (
			<EmptyState
				icon={Columns3}
				title="This field can't be a board"
				description="Group by status, priority, assignee, list, tag, due date, or a select, checkbox or person field."
			/>
		) : (
			<BoardSkeleton />
		);

	const laneList = lanes ?? [
		{
			key: ALL,
			label: "",
			color: null,
			droppable: true,
			wipLimit: null,
		} satisfies Group,
	];
	const colOf = (key: string) => columns.find((c) => c.key === key);
	const laneOf = (key: string) => laneList.find((l) => l.key === key);
	const cellLabel = (cell: string) => {
		const { col, lane } = splitCell(cell);
		const l = laneOf(lane);
		return [colOf(col)?.label, lanes && l ? l.label : null]
			.filter(Boolean)
			.join(", ");
	};
	const cellOf = (overId: string | number | undefined, data?: unknown) => {
		if (overId === undefined) return null;
		const s = String(overId);
		if (!s.includes("|")) return s;
		const c = (data as { sortable?: { containerId?: string } } | undefined)
			?.sortable?.containerId;
		return c ?? cellOfInstance(s);
	};

	/** The writes a move between cells needs, or null when it's not allowed. */
	const writesFor = (
		t: WorkTaskListItem,
		from: string,
		to: string,
	): GroupWrite[] | null => {
		const a = splitCell(from);
		const b = splitCell(to);
		const out: GroupWrite[] = [];
		if (a.col !== b.col) {
			const w = writeFor(groupBy, columns, t, a.col, b.col, now);
			if (!w) return null;
			out.push(w);
		}
		if (lanes && config.subGroupBy && a.lane !== b.lane) {
			const w = writeFor(config.subGroupBy, lanes, t, a.lane, b.lane, now);
			if (!w) return null;
			out.push(w);
		}
		return out;
	};

	const onDragStart = ({ active: a }: DragStartEvent) => {
		const task = a.data.current?.task as WorkTaskListItem | undefined;
		if (task) setActive({ id: String(a.id), task });
	};

	const onDragOver = ({ active: a, over }: DragOverEvent) => {
		const task = a.data.current?.task as WorkTaskListItem | undefined;
		const from = cellOfInstance(String(a.id));
		const to = cellOf(over?.id, over?.data.current);
		if (!task || !to || !over) return;
		// Inserting the preview reflows the columns, which can flip `over` straight back;
		// ignore container switches for a moment after one so the two never oscillate.
		const target = preview?.toCell ?? from;
		if (to !== target) {
			const now = performance.now();
			if (now - lastSwitch.current < 120) return;
			lastSwitch.current = now;
		}
		if (to === from) {
			setBlockedDrop(false);
			if (preview) setPreview(null);
			return;
		}
		if (!writesFor(task, from, to)) {
			setBlockedDrop(true);
			if (preview) setPreview(null);
			return;
		}
		setBlockedDrop(false);
		let before: string | null = null;
		const top = a.rect.current.translated?.top ?? 0;
		if (!String(over.id).includes("|")) {
			// Over the cell itself: slot in by height among the cards already there.
			const cards = document.querySelectorAll<HTMLElement>(
				`[data-cell="${to}"] [data-task-id]`,
			);
			for (const el of cards) {
				const r = el.getBoundingClientRect();
				if (el.dataset.taskId !== task.id && r.top + r.height / 2 > top) {
					before = el.dataset.taskId ?? null;
					break;
				}
			}
		} else {
			const overTask =
				(over.data.current?.task as WorkTaskListItem | undefined)?.id ?? null;
			const list = rendered.current.get(to) ?? [];
			const i = list.findIndex((x) => x.id === String(over.id));
			const below = top > over.rect.top + over.rect.height / 2;
			before = below ? (list[i + 1]?.task.id ?? null) : overTask;
			if (before === task.id) before = null;
		}
		if (preview?.toCell === to && preview.before === before) return;
		setPreview({
			instanceId: String(a.id),
			task,
			fromCell: from,
			toCell: to,
			before,
		});
	};

	const onDragEnd = ({ active: a, over }: DragEndEvent) => {
		const task = a.data.current?.task as WorkTaskListItem | undefined;
		const from = cellOfInstance(String(a.id));
		const to = preview?.toCell ?? cellOf(over?.id, over?.data.current) ?? from;
		setActive(null);
		setPreview(null);
		setBlockedDrop(false);
		if (!task || !over) return;
		const list = (rendered.current.get(to) ?? []).map((x) => x.id);
		const ai = list.indexOf(String(a.id));
		const oi = String(over.id).includes("|")
			? list.indexOf(String(over.id))
			: list.length - 1;
		const order = ai >= 0 && oi >= 0 ? arrayMove(list, ai, oi) : list;
		const at = order.indexOf(String(a.id));
		const neighbour = (i: number) =>
			rendered.current.get(to)?.find((x) => x.id === order[i])?.task ?? null;
		const prev = at > 0 ? neighbour(at - 1) : null;
		const next = at >= 0 ? neighbour(at + 1) : null;
		const writes = writesFor(task, from, to);
		if (!writes) return;
		const manual = config.sort.length === 0;
		if (!writes.length && (!manual || ai === oi)) return;
		commit(task, String(a.id), from, to, writes, prev, next, manual);
	};

	const commit = async (
		task: WorkTaskListItem,
		instanceId: string,
		from: string,
		to: string,
		writes: GroupWrite[],
		prev: WorkTaskListItem | null,
		next: WorkTaskListItem | null,
		manual: boolean,
	) => {
		const updated = writes.reduce(applyWrite, task);
		const placement: Placement = {
			instanceId,
			task: updated,
			fromCell: from,
			toCell: to,
			before: next?.id ?? null,
		};
		setPlacements((ps) => [
			...ps.filter((p) => p.task.id !== task.id),
			placement,
		]);
		// Position only counts among siblings in the same list.
		const sameList = (n: WorkTaskListItem | null) =>
			n && n.listId === updated.listId && n.id !== task.id ? n.id : undefined;
		const position = manual
			? sameList(next)
				? { before: sameList(next) }
				: sameList(prev)
					? { after: sameList(prev) }
					: {}
			: {};
		try {
			let moved = false;
			for (const w of writes) {
				if (w.kind === "move") {
					moved = true;
					await move.mutateAsync({
						id: task.id,
						move: {
							...(w.statusId ? { statusId: w.statusId } : {}),
							...(w.listId ? { listId: w.listId } : {}),
							...position,
						},
					});
				} else if (w.kind === "patch") {
					await patch.mutateAsync({ id: task.id, patch: w.patch });
				} else if (w.kind === "assignee") {
					const rollback = patchCachedTask(qc, task.id, (x) =>
						applyWrite(x, w),
					);
					try {
						if (w.remove)
							await assignee.mutateAsync({
								id: task.id,
								userId: w.remove,
								on: false,
							});
						if (w.add)
							await assignee.mutateAsync({
								id: task.id,
								userId: w.add,
								on: true,
							});
					} catch (e) {
						rollback();
						throw e;
					}
				} else {
					const rollback = patchCachedTask(qc, task.id, (x) =>
						applyWrite(x, w),
					);
					await setField
						.mutateAsync({ id: task.id, fieldId: w.fieldId, value: w.value })
						.catch((e) => {
							rollback();
							throw e;
						});
				}
			}
			if (!moved && ("before" in position || "after" in position))
				await move.mutateAsync({ id: task.id, move: position });
		} catch (e) {
			toast.error(`Couldn't move ${task.key}`, {
				description: e instanceof Error ? e.message : undefined,
			});
		} finally {
			setPlacements((ps) => ps.filter((p) => p !== placement));
		}
	};

	const announcements: Announcements = {
		onDragStart: ({ active: a }) => {
			const t = a.data.current?.task as WorkTaskListItem | undefined;
			return `Picked up ${t?.key ?? "task"}. Use the arrow keys to move, space to drop, escape to cancel.`;
		},
		onDragOver: ({ active: a, over }) => {
			const t = a.data.current?.task as WorkTaskListItem | undefined;
			const to = cellOf(over?.id, over?.data.current);
			if (!t || !to) return `${t?.key ?? "Task"} is no longer over a column.`;
			if (!writesFor(t, cellOfInstance(String(a.id)), to))
				return `${t.key} can't be dropped in ${cellLabel(to)}.`;
			const list = rendered.current.get(to) ?? [];
			const i = list.findIndex((x) => x.id === String(over?.id));
			return `${t.key} is over ${cellLabel(to)}, position ${i < 0 ? list.length + 1 : i + 1} of ${Math.max(list.length, 1)}.`;
		},
		onDragEnd: ({ active: a, over }) => {
			const t = a.data.current?.task as WorkTaskListItem | undefined;
			const to = cellOf(over?.id, over?.data.current);
			if (!t || !to) return `${t?.key ?? "Task"} was dropped back in place.`;
			const list = rendered.current.get(to) ?? [];
			const i = list.findIndex((x) => x.task.id === t.id);
			return `Moved ${t.key} to ${cellLabel(to)}, position ${i < 0 ? list.length : i + 1} of ${list.length}.`;
		},
		onDragCancel: ({ active: a }) => {
			const t = a.data.current?.task as WorkTaskListItem | undefined;
			return `Cancelled. ${t?.key ?? "The task"} went back to where it was.`;
		},
	};

	const pendingById = new Map(placements.map((p) => [p.task.id, p.task]));
	const ctx: CellCtx = {
		groupBy,
		subGroupBy: lanes ? config.subGroupBy : null,
		baseQuery,
		meta,
		now,
		today,
		cardFields: config.cardFields,
		placements: preview ? [...placements, preview] : placements,
		pendingById,
		rendered: rendered.current,
		onOpenTask,
	};
	const wide = (c: Group) => !collapsed.has(c.key);
	const multiField =
		meta.fields.find((f) => `field:${f.id}` === groupBy)?.config.kind ===
		"multi_select";

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCorners}
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDragEnd={onDragEnd}
			onDragCancel={() => {
				setActive(null);
				setPreview(null);
				setBlockedDrop(false);
			}}
			accessibility={{
				announcements,
				screenReaderInstructions: {
					draggable:
						"To move a card, press space. Use the arrow keys to choose a column and position, space to drop, escape to cancel. Enter opens the task.",
				},
			}}
		>
			<div
				className={cn(
					"h-full min-h-0 overflow-auto overscroll-x-contain pb-3 max-md:snap-x max-md:snap-mandatory",
					blockedDrop && "cursor-not-allowed",
				)}
			>
				<div
					className="grid w-max gap-x-3"
					style={{
						gridTemplateColumns: columns
							.map((c) => (wide(c) ? "17.5rem" : "2.75rem"))
							.join(" "),
					}}
				>
					{columns.map((c) => (
						<ColumnHeader
							key={c.key}
							group={c}
							ctx={ctx}
							collapsed={!wide(c)}
							onToggle={() => toggleCollapsed(c.key)}
							defaults={{
								listId,
								fallbackListId: meta.defaultListId,
								values: createDefaults(groupBy, c.key, now, multiField),
							}}
						/>
					))}
					{laneList.map((lane) => {
						const laneKey = `lane:${lane.key}`;
						const laneOpen = !collapsed.has(laneKey);
						return (
							<Lane
								key={lane.key}
								lane={lanes ? lane : null}
								span={columns.length}
								open={laneOpen}
								onToggle={() => toggleCollapsed(laneKey)}
							>
								{laneOpen &&
									columns.map((c) =>
										wide(c) ? (
											<Cell
												key={c.key}
												id={cellId(c.key, lane.key)}
												column={c}
												lane={lane}
												ctx={ctx}
												blocked={
													!!active &&
													!writesFor(
														active.task,
														cellOfInstance(active.id),
														cellId(c.key, lane.key),
													)
												}
												lastLane={lane === laneList.at(-1)}
											/>
										) : (
											<div key={c.key} aria-hidden />
										),
									)}
							</Lane>
						);
					})}
				</div>
			</div>
			<DragOverlay
				dropAnimation={
					prefersReducedMotion()
						? null
						: { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
				}
			>
				{active && (
					<div
						className={cn(
							"w-[17.5rem] rotate-[0.6deg]",
							blockedDrop ? "cursor-not-allowed opacity-80" : "cursor-grabbing",
						)}
					>
						<TaskCard
							task={active.task}
							meta={meta}
							cardFields={config.cardFields}
							today={today}
							dragging
						/>
					</div>
				)}
			</DragOverlay>
		</DndContext>
	);
}

type CellCtx = {
	groupBy: GroupKey;
	subGroupBy: GroupKey | null;
	baseQuery: ReturnType<typeof viewTaskQuery>;
	meta: ProjectMeta;
	now: Date;
	today: string;
	cardFields: ViewProps["config"]["cardFields"];
	placements: Placement[];
	pendingById: Map<string, WorkTaskListItem>;
	rendered: Map<string, Instance[]>;
	onOpenTask: (id: string) => void;
};

/** One column's paged query; cells and the header share it through the cache. */
function useColumn(ctx: CellCtx, col: string) {
	const q = useWorkTasks({ ...ctx.baseQuery, group: col });
	const items = useMemo(
		() => q.data?.pages.flatMap((p) => p.items) ?? [],
		[q.data],
	);
	return {
		items,
		total: q.data?.pages[0]?.total,
		pending: q.isPending,
		error: q.error,
		hasMore: !!q.hasNextPage,
		loadingMore: q.isFetchingNextPage,
		more: q.fetchNextPage,
	};
}

/** Base cards of a cell (server order, optimistic values), then drops and the live drag preview. */
function cellInstances(
	id: string,
	items: WorkTaskListItem[],
	ctx: CellCtx,
	column: string,
	lane: string,
): Instance[] {
	const belongs = (t: WorkTaskListItem) =>
		groupValues(t, ctx.groupBy, ctx.now).includes(column) &&
		(!ctx.subGroupBy || groupValues(t, ctx.subGroupBy, ctx.now).includes(lane));
	let list: Instance[] = items
		.filter((t) => belongs(ctx.pendingById.get(t.id) ?? t))
		.map((t) => ({
			id: instanceOf(id, t.id),
			task: ctx.pendingById.get(t.id) ?? t,
		}));
	for (const p of ctx.placements) {
		list = list.filter(
			(x) =>
				!(
					x.task.id === p.task.id &&
					(id === p.toCell || x.id === p.instanceId)
				),
		);
		if (id !== p.toCell) continue;
		const at = p.before ? list.findIndex((x) => x.task.id === p.before) : -1;
		list.splice(at < 0 ? list.length : at, 0, {
			id: p.instanceId,
			task: p.task,
		});
	}
	return list;
}

function ColumnHeader({
	group: c,
	ctx,
	collapsed,
	onToggle,
	defaults,
}: {
	group: Group;
	ctx: CellCtx;
	collapsed: boolean;
	onToggle: () => void;
	defaults: {
		listId?: string;
		fallbackListId: string | null;
		values: Partial<WorkTaskCreate>;
	};
}) {
	const col = useColumn(ctx, c.key);
	const shown = col.items.filter((t) =>
		groupValues(ctx.pendingById.get(t.id) ?? t, ctx.groupBy, ctx.now).includes(
			c.key,
		),
	).length;
	const moved = ctx.placements.filter(
		(p) =>
			splitCell(p.toCell).col === c.key && splitCell(p.fromCell).col !== c.key,
	).length;
	const count =
		(col.total ?? col.items.length) - (col.items.length - shown) + moved;
	const over = c.wipLimit !== null && count > c.wipLimit;
	const countLabel = (
		<span
			className={cn(
				"tabular text-xs text-muted-foreground",
				over && "font-medium text-warn-text",
			)}
		>
			{col.pending ? "–" : count}
			{c.wipLimit !== null && `/${c.wipLimit}`}
		</span>
	);
	if (collapsed)
		return (
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={false}
				aria-label={`Expand ${c.label}, ${count} tasks`}
				className="flex min-h-48 self-start flex-col items-center gap-2 rounded-xl bg-muted/50 py-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring dark:bg-muted/30"
			>
				{c.color && (
					<span className={cn("size-2 rounded-full", WORK_DOT[c.color])} />
				)}
				{countLabel}
				<span className="[writing-mode:vertical-rl]">{c.label}</span>
			</button>
		);
	return (
		<div
			className={cn(
				"sticky top-0 z-10 flex h-10 items-center gap-2 rounded-t-xl bg-background px-1 max-md:snap-start",
			)}
		>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded
				aria-label={`Collapse ${c.label}`}
				className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			>
				{c.color && (
					<span
						className={cn("size-2 shrink-0 rounded-full", WORK_DOT[c.color])}
					/>
				)}
				<span className="truncate text-sm font-medium">{c.label}</span>
				{countLabel}
			</button>
			{over && (
				<span className="text-2xs font-medium text-warn-text">Over limit</span>
			)}
			{!c.droppable && (
				<Lock
					className="size-3 text-muted-foreground"
					aria-label="Cards can't be dropped here"
				/>
			)}
			<QuickAdd
				label={c.label}
				defaults={defaults}
				projectId={ctx.baseQuery.projectId ?? ""}
			/>
		</div>
	);
}

function QuickAdd({
	label,
	defaults,
	projectId,
}: {
	label: string;
	projectId: string;
	defaults: {
		listId?: string;
		fallbackListId: string | null;
		values: Partial<WorkTaskCreate>;
	};
}) {
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const create = useCreateWorkTask();
	const listId =
		defaults.values.listId ?? defaults.listId ?? defaults.fallbackListId;
	const submit = () => {
		const t = title.trim();
		if (!t || !listId) return;
		create.mutate(
			{ ...defaults.values, listId, title: t },
			{
				onSuccess: (task) => {
					setTitle("");
					toast.success(`Created ${task.key}`);
				},
				onError: (e) =>
					toast.error("Couldn't create the task", { description: e.message }),
			},
		);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon-xs"
					className="ml-auto text-muted-foreground"
					aria-label={`Add a task to ${label}`}
					disabled={!listId || !projectId}
				>
					<Plus />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-2">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
					className="flex gap-1.5"
				>
					<Input
						autoFocus
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder={`New task in ${label}`}
						aria-label="Task title"
						maxLength={500}
					/>
					<Button
						type="submit"
						size="sm"
						disabled={!title.trim() || create.isPending}
					>
						Add
					</Button>
				</form>
				<p className="mt-1.5 px-0.5 text-2xs text-muted-foreground">
					Enter adds it and keeps the box open for the next one.
				</p>
			</PopoverContent>
		</Popover>
	);
}

function Lane({
	lane,
	span,
	open,
	onToggle,
	children,
}: {
	lane: Group | null;
	span: number;
	open: boolean;
	onToggle: () => void;
	children: React.ReactNode;
}) {
	if (!lane) return <>{children}</>;
	return (
		<>
			<div
				className="sticky left-0 mt-3 flex h-9 w-max items-center"
				style={{ gridColumn: `1 / span ${span}` }}
			>
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ChevronRight
						className={cn(
							"size-3.5 transition-transform duration-(--duration-quick)",
							open && "rotate-90",
						)}
						aria-hidden
					/>
					{lane.color && (
						<span
							className={cn("size-1.5 rounded-full", WORK_DOT[lane.color])}
						/>
					)}
					{lane.label}
				</button>
			</div>
			{children}
		</>
	);
}

function Cell({
	id,
	column,
	lane,
	ctx,
	blocked,
	lastLane,
}: {
	id: string;
	column: Group;
	lane: Group;
	ctx: CellCtx;
	blocked: boolean;
	lastLane: boolean;
}) {
	const col = useColumn(ctx, column.key);
	const list = cellInstances(id, col.items, ctx, column.key, lane.key);
	ctx.rendered.set(id, list);
	const { setNodeRef, isOver } = useDroppable({ id });
	const sentinel = useRef<HTMLDivElement>(null);
	const { hasMore, loadingMore, more } = col;
	useEffect(() => {
		const el = sentinel.current;
		if (!el || !hasMore || !lastLane) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting) && !loadingMore) void more();
			},
			{ rootMargin: "240px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [hasMore, loadingMore, more, lastLane]);
	const hiddenClosed =
		ctx.groupBy === "status" &&
		ctx.baseQuery.includeClosed === "false" &&
		["done", "cancelled"].includes(
			ctx.meta.statusById.get(column.key)?.category ?? "",
		);
	return (
		<SortableContext
			id={id}
			items={list.map((x) => x.id)}
			strategy={verticalListSortingStrategy}
		>
			<section
				ref={setNodeRef}
				data-cell={id}
				aria-label={column.label + (lane.label ? `, ${lane.label}` : "")}
				className={cn(
					"flex min-h-24 flex-col gap-2 rounded-xl bg-muted/50 p-2 transition-[background-color,box-shadow] duration-(--duration-quick) dark:bg-muted/30",
					isOver && !blocked && "bg-muted ring-1 ring-border dark:bg-muted/60",
					blocked && "opacity-60",
				)}
			>
				{col.pending ? (
					<>
						<Skeleton className="h-20 rounded-lg" />
						<Skeleton className="h-16 rounded-lg" />
					</>
				) : col.error ? (
					<p className="px-1 py-2 text-xs text-bad-text">
						Couldn't load these tasks.
					</p>
				) : (
					list.map((x) => <SortableCard key={x.id} instance={x} ctx={ctx} />)
				)}
				{!col.pending && list.length === 0 && (
					<p className="px-1 py-3 text-center text-xs text-muted-foreground">
						{hiddenClosed ? "Closed tasks are hidden" : "No tasks"}
					</p>
				)}
				{lastLane && hasMore && (
					<div ref={sentinel}>
						<Button
							variant="ghost"
							size="sm"
							className="w-full text-muted-foreground"
							onClick={() => void more()}
							disabled={loadingMore}
						>
							{loadingMore ? "Loading…" : "Show more"}
						</Button>
					</div>
				)}
			</section>
		</SortableContext>
	);
}

function SortableCard({ instance, ctx }: { instance: Instance; ctx: CellCtx }) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: instance.id, data: { task: instance.task } });
	return (
		// biome-ignore lint/a11y/useSemanticElements: the card holds block content a <button> can't; dnd-kit wires role, tabIndex and keys
		<div
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			role="button"
			tabIndex={0}
			data-task-id={instance.task.id}
			aria-roledescription="Draggable task"
			aria-label={`${instance.task.key}: ${instance.task.title}`}
			onClick={() => ctx.onOpenTask(instance.task.id)}
			onKeyDown={(e) => {
				listeners?.onKeyDown?.(e);
				if (e.key === "Enter" && !e.defaultPrevented)
					ctx.onOpenTask(instance.task.id);
			}}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			className={cn(
				"cursor-grab rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:cursor-grabbing",
				isDragging && "opacity-40",
			)}
		>
			<TaskCard
				task={instance.task}
				meta={ctx.meta}
				cardFields={ctx.cardFields}
				today={ctx.today}
			/>
		</div>
	);
}

function BoardSkeleton() {
	return (
		<div className="flex gap-3" aria-busy>
			<span className="sr-only">Loading board</span>
			{[0, 1, 2, 3].map((i) => (
				<div key={i} className="flex w-[17.5rem] flex-col gap-2">
					<Skeleton className="h-6 w-28" />
					<Skeleton className="h-24 rounded-lg" />
					<Skeleton className="h-20 rounded-lg" />
				</div>
			))}
		</div>
	);
}
