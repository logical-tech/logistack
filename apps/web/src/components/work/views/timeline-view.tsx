/*
 * Timeline (waterfall): a task tree on the left, a day grid on the right, both in
 * one scroller so rows stay aligned. Rows are virtualised; header ticks, weekend
 * shading and bars render only for the visible date window plus one screen.
 */
import type { WorkTaskListItem } from "@logistack/contracts";
import {
	addDays,
	addWorkingDays,
	barGeometry,
	daysBetween,
	isWorkingDay,
	localDate,
	scaleFor,
	type TimelineZoom,
	violatedEdges,
	visibleRange,
	workingDaysBetween,
	wouldCycle,
} from "@logistack/core/work";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	CalendarClock,
	ChevronRight,
	GanttChart,
	List,
	Settings2,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import {
	patchCachedTask,
	useAddWorkDependency,
	useBulkWorkTasks,
	usePatchWorkTask,
	useRemoveWorkDependency,
	useWorkShiftPreview,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { WORK_BAR, WORK_DOT, WORK_FILL } from "./common/colors";
import {
	isClosedTask,
	type ProjectMeta,
	shortDate,
	taskProgress,
	useAllTasks,
	useProjectMeta,
	viewTaskQuery,
} from "./common/data";
import { AvatarStack } from "./common/people";
import { roundedPath, routeArrow } from "./timeline/arrows";
import { DependencyDialog } from "./timeline/dependency-dialog";
import {
	buildRows,
	HEADER_UNITS,
	type TimelineRow,
	ticks,
} from "./timeline/layout";
import { ListEquivalentDialog } from "./timeline/list-dialog";
import { useDependencyEdges } from "./timeline/use-edges";
import type { ViewProps } from "./types";

const ROW = 36;
const BAR = 22;
const HEADER = 52;
const ZOOMS: TimelineZoom[] = ["day", "week", "month", "quarter"];

type Dates = { startDate: string | null; dueDate: string | null };
type DragMode = "move" | "start" | "end";
type Drag = {
	task: WorkTaskListItem;
	mode: DragMode;
	startX: number;
	moved: boolean;
	next: Dates;
};
type ShiftPrompt = {
	task: WorkTaskListItem;
	changes: { id: string; startDate: string | null; dueDate: string | null }[];
};

const reducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Dates after dragging `mode` by `days` calendar days; null when nothing would change. */
function dragDates(
	t: Dates & { isMilestone?: boolean },
	mode: DragMode,
	days: number,
): Dates {
	const s = t.startDate;
	const d = t.dueDate;
	if (mode === "move" || t.isMilestone)
		return {
			startDate: s ? addDays(s, days) : null,
			dueDate: d ? addDays(d, days) : null,
		};
	if (mode === "start" && s) {
		const ns = addDays(s, days);
		return { startDate: d && ns > d ? d : ns, dueDate: d };
	}
	if (mode === "end" && d) {
		const nd = addDays(d, days);
		return { startDate: s, dueDate: s && nd < s ? s : nd };
	}
	if (mode === "end" && s && !d)
		return { startDate: s, dueDate: addDays(s, Math.max(0, days)) };
	return { startDate: s, dueDate: d };
}

export function TimelineView({
	project,
	config,
	onConfigChange,
	onOpenTask,
	listId,
}: ViewProps) {
	const meta = useProjectMeta(project.id);
	const tl = config.timeline;
	const setTl = (next: Partial<typeof tl>) =>
		onConfigChange({ timeline: { ...tl, ...next } });
	const { tasks, pending } = useAllTasks(
		useMemo(
			() => viewTaskQuery(project.id, config, listId),
			[project.id, config, listId],
		),
	);
	const edges = useDependencyEdges(tasks, tl.showDependencies);
	const readOnly = useIsMobile();
	const today = useMemo(() => localDate(new Date()), []);
	const { pxPerDay } = scaleFor(tl.zoom);

	const [overrides, setOverrides] = useState<Map<string, Dates>>(new Map());
	const effective = useCallback(
		<T extends WorkTaskListItem>(t: T): T => {
			const o = overrides.get(t.id);
			return o ? { ...t, ...o } : t;
		},
		[overrides],
	);

	const collapsed = useMemo(
		() => new Set(config.collapsedGroups),
		[config.collapsedGroups],
	);
	const toggle = (key: string) => {
		const k = `tl:${key}`;
		onConfigChange({
			collapsedGroups: collapsed.has(k)
				? config.collapsedGroups.filter((x) => x !== k)
				: [...config.collapsedGroups, k],
		});
	};
	const { rows, unscheduled } = useMemo(
		() =>
			buildRows(tasks, {
				rowsBy: tl.rowsBy,
				nested: config.showSubtasks === "nested",
				chronological: config.sort.length === 0,
				collapsed,
				lists: meta.lists,
				people: meta.people,
			}),
		[
			tasks,
			tl.rowsBy,
			config.showSubtasks,
			config.sort.length,
			collapsed,
			meta.lists,
			meta.people,
		],
	);

	// The grid spans every date with generous padding; only the visible window renders.
	const [origin, end] = useMemo(() => {
		let lo = today;
		let hi = today;
		for (const t of tasks)
			for (const d of [t.startDate, t.dueDate])
				if (d) {
					if (d < lo) lo = d;
					if (d > hi) hi = d;
				}
		return [addDays(lo, -120), addDays(hi, 240)];
	}, [tasks, today]);

	const scrollRef = useRef<HTMLElement>(null);
	const gridRef = useRef<HTMLDivElement>(null);
	const [paneWidth, setLeftWidth] = useState(280);
	// Phones get a narrow tree so the grid stays visible.
	const leftWidth = readOnly ? 148 : paneWidth;
	const [view, setView] = useState({ left: 0, width: 1200 });
	// At wide zooms the padded range can be narrower than the screen: fill it.
	const totalDays = Math.max(
		daysBetween(origin, end) + 1,
		Math.ceil((view.width - leftWidth) / pxPerDay),
	);
	const gridWidth = totalDays * pxPerDay;
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW,
		overscan: 10,
		paddingStart: 0,
	});

	const empty = !pending && meta.ready && tasks.length === 0;
	// Track the horizontal window, at most once a frame.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `empty` swaps the scroller element out, so the listeners must re-attach
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		let frame = 0;
		const read = () => {
			frame = 0;
			setView((v) =>
				Math.abs(v.left - el.scrollLeft) < pxPerDay * 2 &&
				v.width === el.clientWidth
					? v
					: { left: el.scrollLeft, width: el.clientWidth },
			);
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(read);
		};
		read();
		el.addEventListener("scroll", onScroll, { passive: true });
		const ro = new ResizeObserver(onScroll);
		ro.observe(el);
		return () => {
			el.removeEventListener("scroll", onScroll);
			ro.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [pxPerDay, empty]);
	const range = visibleRange(
		Math.max(0, view.left - leftWidth),
		view.width,
		origin,
		pxPerDay,
	);
	const inWindow = (x: number, w: number) => {
		const a = daysBetween(origin, range.from) * pxPerDay;
		const b = daysBetween(origin, range.to) * pxPerDay;
		return x + w >= a && x <= b;
	};
	const xOf = (date: string) => daysBetween(origin, date) * pxPerDay;

	const scrollToDate = useCallback(
		(date: string, smooth = true) => {
			const el = scrollRef.current;
			if (!el) return;
			el.scrollTo({
				left: Math.max(
					0,
					daysBetween(origin, date) * pxPerDay -
						(el.clientWidth - leftWidth) / 3,
				),
				behavior: smooth && !reducedMotion() ? "smooth" : "auto",
			});
		},
		[origin, pxPerDay, leftWidth],
	);
	// Land on today once the data is in.
	const landed = useRef(false);
	useLayoutEffect(() => {
		if (landed.current || pending) return;
		landed.current = true;
		scrollToDate(today, false);
	}, [pending, scrollToDate, today]);

	// ⌘/ctrl + wheel zooms around the pointer: the day under it stays under it.
	const zoomAnchor = useRef<{ day: number; offset: number } | null>(null);
	/** Zoom keeping the day at `offset` (px from the scroller's left; default: mid-grid) in place. */
	const zoomTo = (next: TimelineZoom, offset?: number) => {
		const el = scrollRef.current;
		if (el) {
			const at = offset ?? leftWidth + (el.clientWidth - leftWidth) / 2;
			zoomAnchor.current = {
				day: (el.scrollLeft + at - leftWidth) / pxPerDay,
				offset: at,
			};
		}
		setTl({ zoom: next });
	};
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if (!(e.ctrlKey || e.metaKey)) return;
			e.preventDefault();
			const i = ZOOMS.indexOf(tl.zoom) + (e.deltaY > 0 ? 1 : -1);
			const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i))];
			if (!next || next === tl.zoom) return;
			zoomTo(next, e.clientX - el.getBoundingClientRect().left);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	});
	useLayoutEffect(() => {
		const a = zoomAnchor.current;
		const el = scrollRef.current;
		if (!a || !el) return;
		zoomAnchor.current = null;
		el.scrollLeft = a.day * pxPerDay + leftWidth - a.offset;
	}, [pxPerDay, leftWidth]);

	// --- writes ----------------------------------------------------------------
	const qc = useQueryClient();
	const patch = usePatchWorkTask();
	const preview = useWorkShiftPreview();
	const bulk = useBulkWorkTasks();
	const addDep = useAddWorkDependency();
	const removeDep = useRemoveWorkDependency();
	const [prompt, setPrompt] = useState<ShiftPrompt | null>(null);

	const commitDates = async (
		t: WorkTaskListItem,
		next: Dates,
		dueOnly: boolean,
	) => {
		const before = t.startDate ?? t.dueDate;
		const after = next.startDate ?? next.dueDate;
		// Show the new dates now; the patch below confirms or rolls them back.
		patchCachedTask(qc, t.id, (x) => ({ ...x, ...next }));
		setOverrides((m) => {
			const n = new Map(m);
			n.delete(t.id);
			return n;
		});
		const anchorBefore = dueOnly ? t.dueDate : before;
		const anchorAfter = dueOnly ? next.dueDate : after;
		const delta =
			anchorBefore && anchorAfter
				? workingDaysBetween(anchorBefore, anchorAfter, meta.workingDays)
				: 0;
		const hasDependants = edges.some((e) => e.blockedById === t.id);
		const shift =
			tl.showDependencies && hasDependants && delta > 0
				? await preview
						.mutateAsync({ id: t.id, input: { deltaDays: delta, dueOnly } })
						.catch(() => null)
				: null;
		try {
			await patch.mutateAsync({ id: t.id, patch: next });
		} catch (e) {
			toast.error(`Couldn't reschedule ${t.key}`, {
				description: e instanceof Error ? e.message : undefined,
			});
			return;
		}
		const changes = shift?.changes.filter((c) => c.id !== t.id) ?? [];
		if (changes.length) setPrompt({ task: t, changes });
	};

	const applyShift = async (p: ShiftPrompt) => {
		setPrompt(null);
		// One bulk call per distinct shift (usually one): bulk keeps each task's duration.
		const byDelta = new Map<number, string[]>();
		for (const c of p.changes) {
			const cur = tasks.find((x) => x.id === c.id);
			const from = cur?.startDate ?? cur?.dueDate;
			const to = c.startDate ?? c.dueDate;
			if (!from || !to) continue;
			const d = workingDaysBetween(from, to, meta.workingDays);
			if (d) byDelta.set(d, [...(byDelta.get(d) ?? []), c.id]);
			patchCachedTask(qc, c.id, (x) => ({
				...x,
				startDate: c.startDate,
				dueDate: c.dueDate,
			}));
		}
		try {
			for (const [shiftDays, taskIds] of byDelta)
				await bulk.mutateAsync({ taskIds, set: { shiftDays } });
			toast.success(
				`Moved ${p.changes.length} dependent task${p.changes.length === 1 ? "" : "s"}`,
			);
		} catch (e) {
			toast.error("Couldn't move the dependent tasks", {
				description: e instanceof Error ? e.message : undefined,
			});
		}
	};

	// --- pointer drag on bars ------------------------------------------------------
	const drag = useRef<Drag | null>(null);
	const [dragTip, setDragTip] = useState<{ id: string; dates: Dates } | null>(
		null,
	);
	const onBarPointerDown = (
		e: React.PointerEvent,
		t: WorkTaskListItem,
		mode: DragMode,
	) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		if (readOnly) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag.current = { task: t, mode, startX: e.clientX, moved: false, next: t };
	};
	const onBarPointerMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const days = Math.round((e.clientX - d.startX) / pxPerDay);
		if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return;
		d.moved = true;
		const next = dragDates(d.task, d.mode, days);
		if (next.startDate === d.next.startDate && next.dueDate === d.next.dueDate)
			return;
		d.next = next;
		setOverrides((m) => new Map(m).set(d.task.id, next));
		setDragTip({ id: d.task.id, dates: next });
	};
	const onBarPointerUp = (t: WorkTaskListItem) => {
		const d = drag.current;
		drag.current = null;
		setDragTip(null);
		if (!d?.moved) {
			onOpenTask(t.id);
			return;
		}
		if (d.next.startDate === t.startDate && d.next.dueDate === t.dueDate) {
			setOverrides((m) => {
				const n = new Map(m);
				n.delete(t.id);
				return n;
			});
			return;
		}
		void commitDates(t, d.next, d.mode === "end");
	};

	// --- connector drag: draw a line, drop on another bar ---------------------------
	type Link = {
		from: WorkTaskListItem;
		x0: number;
		y0: number;
		x: number;
		y: number;
	};
	const [link, setLinkState] = useState<Link | null>(null);
	// The ref is what pointer-up reads: a fast drag can end before React re-renders.
	const linkRef = useRef<Link | null>(null);
	const setLink = (l: Link | null) => {
		linkRef.current = l;
		setLinkState(l);
	};
	const gridPoint = (e: { clientX: number; clientY: number }) => {
		const r = gridRef.current?.getBoundingClientRect();
		return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
	};
	const onLinkDown = (
		e: React.PointerEvent,
		t: WorkTaskListItem,
		x0: number,
		y0: number,
	) => {
		e.stopPropagation();
		if (readOnly) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		const p = gridPoint(e);
		setLink({ from: t, x0, y0, ...p });
	};
	const onLinkMove = (e: React.PointerEvent) => {
		if (!linkRef.current) return;
		setLink({ ...linkRef.current, ...gridPoint(e) });
	};
	const onLinkUp = (e: React.PointerEvent) => {
		const l = linkRef.current;
		setLink(null);
		if (!l) return;
		const target = document
			.elementsFromPoint(e.clientX, e.clientY)
			.map((el) => (el as HTMLElement).closest?.("[data-bar-task]"))
			.find(Boolean)
			?.getAttribute("data-bar-task");
		const to = tasks.find((x) => x.id === target);
		if (!to || to.id === l.from.id) return;
		if (edges.some((x) => x.taskId === to.id && x.blockedById === l.from.id))
			return;
		const loop = wouldCycle(edges, to.id, l.from.id);
		if (loop) {
			toast.error("That would make a loop", {
				description: `${to.key} already leads to ${l.from.key}.`,
			});
			return;
		}
		addDep.mutate(
			{ id: to.id, input: { blockedById: l.from.id } },
			{
				onSuccess: () => toast.success(`${l.from.key} now blocks ${to.key}`),
				onError: (err) =>
					toast.error("Couldn't link them", { description: err.message }),
			},
		);
	};

	// --- keyboard nudges: coalesced, then one commit ---------------------------------
	const nudge = useRef<{
		task: WorkTaskListItem;
		next: Dates;
		dueOnly: boolean;
		timer: number;
	} | null>(null);
	const onBarKey = (e: React.KeyboardEvent, t: WorkTaskListItem) => {
		if (e.key === "Enter") {
			e.preventDefault();
			onOpenTask(t.id);
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
			e.preventDefault();
			setDepTask(t);
			return;
		}
		if (readOnly || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
		e.preventDefault();
		const step = e.key === "ArrowLeft" ? -1 : 1;
		const n = nudge.current?.task.id === t.id ? nudge.current : null;
		const base = n?.next ?? t;
		const next = dragDates(
			{ ...base, isMilestone: t.isMilestone },
			e.shiftKey ? "end" : "move",
			step,
		);
		if (n) window.clearTimeout(n.timer);
		const dueOnly = (n?.dueOnly ?? true) && e.shiftKey;
		setOverrides((m) => new Map(m).set(t.id, next));
		nudge.current = {
			task: t,
			next,
			dueOnly,
			timer: window.setTimeout(() => {
				nudge.current = null;
				void commitDates(t, next, dueOnly);
			}, 600),
		};
	};

	// --- dependency arrows ----------------------------------------------------------
	const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
	const [depTask, setDepTask] = useState<WorkTaskListItem | null>(null);
	const [listOpen, setListOpen] = useState(false);
	const rowIndex = useMemo(() => {
		const m = new Map<string, number>();
		rows.forEach((r, i) => {
			if (r.kind === "task" && !m.has(r.task.id)) m.set(r.task.id, i);
		});
		return m;
	}, [rows]);
	const violated = useMemo(
		() =>
			new Set(
				violatedEdges(tasks.map(effective), edges, meta.workingDays).map(
					(e) => `${e.blockedById}>${e.taskId}`,
				),
			),
		[tasks, edges, meta.workingDays, effective],
	);

	if (empty)
		return (
			<EmptyState
				icon={GanttChart}
				title="Nothing to plan yet"
				description="Tasks with a start or due date show up here as bars. Add dates to a task, or clear the filters."
			/>
		);

	const vRows = virtualizer.getVirtualItems();
	const first = vRows[0]?.index ?? 0;
	const last = vRows.at(-1)?.index ?? 0;
	const height = virtualizer.getTotalSize();
	const units = HEADER_UNITS[tl.zoom];
	const bandTop = ticks(range.from, range.to, units.top);
	const bandBottom = ticks(range.from, range.to, units.bottom);
	const days =
		tl.showWeekends && pxPerDay >= 16
			? Array.from({ length: daysBetween(range.from, range.to) + 1 }, (_, i) =>
					addDays(range.from, i),
				).filter((d) => !isWorkingDay(d, meta.workingDays))
			: [];
	const taskById = new Map(tasks.map((t) => [t.id, effective(t)]));
	const geom = (t: WorkTaskListItem) =>
		barGeometry(effective(t), origin, pxPerDay);

	const arrows = tl.showDependencies
		? edges.flatMap((e) => {
				const bi = rowIndex.get(e.blockedById);
				const ti = rowIndex.get(e.taskId);
				const b = taskById.get(e.blockedById);
				const t = taskById.get(e.taskId);
				if (bi === undefined || ti === undefined || !b || !t) return [];
				if (Math.max(bi, ti) < first - 20 || Math.min(bi, ti) > last + 20)
					return [];
				const gb = geom(b);
				const gt = geom(t);
				if (!gb || !gt) return [];
				const half = gb.kind === "milestone" ? 7 : 0;
				const a = {
					x:
						gb.kind === "milestone"
							? gb.x + gb.width / 2 + half
							: gb.x + gb.width,
					y: bi * ROW + ROW / 2,
				};
				const z = {
					x: gt.kind === "milestone" ? gt.x + gt.width / 2 - 7 : gt.x,
					y: ti * ROW + ROW / 2,
				};
				const id = `${e.blockedById}>${e.taskId}`;
				return [
					{
						id,
						d: roundedPath(
							routeArrow(a, { x: z.x - 2, y: z.y }, { rowHalf: ROW / 2 }),
							5,
						),
						bad: violated.has(id),
						label: `${b.key} blocks ${t.key}`,
						edge: e,
					},
				];
			})
		: [];

	return (
		<div className="relative flex h-full min-h-0 flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<Segmented
					label="Zoom"
					value={tl.zoom}
					onChange={(zoom) => zoomTo(zoom)}
					options={[
						{ value: "day", label: "Day" },
						{ value: "week", label: "Week" },
						{ value: "month", label: "Month" },
						{ value: "quarter", label: "Quarter" },
					]}
				/>
				<Button variant="outline" size="sm" onClick={() => scrollToDate(today)}>
					Today
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="sm" className="text-muted-foreground">
							<Settings2 />
							Display
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-52">
						<DropdownMenuLabel>Rows</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={tl.rowsBy}
							onValueChange={(v) => setTl({ rowsBy: v as typeof tl.rowsBy })}
						>
							<DropdownMenuRadioItem value="list">
								By list
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="assignee">
								By assignee
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="none">
								No grouping
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuCheckboxItem
							checked={tl.showDependencies}
							onCheckedChange={(v) => setTl({ showDependencies: !!v })}
						>
							Dependencies
						</DropdownMenuCheckboxItem>
						<DropdownMenuCheckboxItem
							checked={tl.showWeekends}
							onCheckedChange={(v) => setTl({ showWeekends: !!v })}
						>
							Shade days off
						</DropdownMenuCheckboxItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<span className="ml-auto hidden text-xs text-muted-foreground lg:inline">
					{readOnly
						? "Read only on small screens"
						: "Drag bars to reschedule · ⌘ scroll to zoom · ⌘D on a bar for dependencies"}
				</span>
				<Button variant="ghost" size="sm" onClick={() => setListOpen(true)}>
					<List />
					List equivalent
				</Button>
			</div>

			<section
				ref={scrollRef}
				data-timeline-scroller=""
				className="relative min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl bg-card ring-1 ring-border"
				aria-label="Timeline"
			>
				<div
					style={{ width: leftWidth + gridWidth, minHeight: "100%" }}
					className="relative"
				>
					{/* Header: sticky on top, the corner sticky on both axes. */}
					<div
						className="sticky top-0 z-30 flex border-b border-border bg-card"
						style={{ height: HEADER }}
					>
						<div
							className="sticky left-0 z-10 flex items-end border-r border-border bg-card px-3 pb-2 text-xs font-medium text-muted-foreground"
							style={{ width: leftWidth, minWidth: leftWidth }}
						>
							Task
						</div>
						<div className="relative" style={{ width: gridWidth }} aria-hidden>
							{bandTop.map((tk) => (
								<div
									key={tk.date}
									className="absolute top-0 flex h-6 items-center border-l border-border/70 text-xs font-medium"
									style={{ left: xOf(tk.date), width: tk.days * pxPerDay }}
								>
									<span
										className="sticky left-[calc(var(--lw)+8px)] truncate px-2"
										style={{ "--lw": `${leftWidth}px` } as React.CSSProperties}
									>
										{units.topLabel(tk.date)}
									</span>
								</div>
							))}
							{bandBottom.map((tk) => (
								<div
									key={tk.date}
									className={cn(
										"absolute bottom-0 flex h-6 items-center border-l border-border/50 px-1.5 text-2xs text-muted-foreground tabular",
										tl.zoom === "day" && "justify-center px-0",
										tk.date === today && "font-semibold text-foreground",
									)}
									style={{ left: xOf(tk.date), width: tk.days * pxPerDay }}
								>
									{tk.label}
								</div>
							))}
							<div
								className="absolute top-1 z-10 -translate-x-1/2 rounded-sm bg-brand px-1 text-[0.625rem] leading-4 font-medium text-brand-foreground"
								style={{ left: xOf(today) + pxPerDay / 2 }}
							>
								Today
							</div>
						</div>
					</div>

					<div className="relative" style={{ height }}>
						{/* Left pane: the task tree. */}
						<div
							className="sticky left-0 z-20 border-r border-border bg-card"
							style={{ width: leftWidth, height }}
						>
							{pending &&
								[0, 1, 2, 3, 4].map((i) => (
									<div key={i} className="flex h-9 items-center px-3">
										<Skeleton className="h-3.5 w-3/4" />
									</div>
								))}
							{vRows.map((vr) => {
								const r = rows[vr.index] as TimelineRow;
								return (
									<TreeRow
										key={r.key}
										row={r}
										top={vr.start}
										meta={meta}
										onToggle={() => toggle(r.key)}
										onOpenTask={onOpenTask}
									/>
								);
							})}
							<PaneResizer width={leftWidth} onChange={setLeftWidth} />
						</div>

						{/* Right pane: the grid. */}
						<div
							ref={gridRef}
							className="absolute top-0"
							style={{ left: leftWidth, width: gridWidth, height }}
							onPointerMove={onLinkMove}
							onPointerUp={onLinkUp}
						>
							{days.map((d) => (
								<div
									key={d}
									aria-hidden
									className="absolute inset-y-0 bg-muted/60 dark:bg-muted/35"
									style={{ left: xOf(d), width: pxPerDay }}
								/>
							))}
							{bandBottom.map((tk) => (
								<div
									key={tk.date}
									aria-hidden
									className="absolute inset-y-0 border-l border-border/40"
									style={{ left: xOf(tk.date) }}
								/>
							))}
							{vRows.map((vr) =>
								rows[vr.index]?.kind === "group" ? (
									<div
										key={vr.key}
										aria-hidden
										className="absolute inset-x-0 bg-muted/50 dark:bg-muted/25"
										style={{ top: vr.start, height: ROW }}
									/>
								) : null,
							)}
							<div
								aria-hidden
								className="absolute inset-y-0 w-px bg-brand/70"
								style={{ left: xOf(today) + pxPerDay / 2 }}
							/>

							<svg
								className="pointer-events-none absolute inset-0 overflow-visible"
								width={gridWidth}
								height={height}
								aria-hidden={arrows.length === 0}
							>
								<title>Dependencies between tasks</title>
								<defs>
									<marker
										id="tl-arrow"
										viewBox="0 0 8 8"
										refX="7"
										refY="4"
										markerWidth="7"
										markerHeight="7"
										orient="auto"
									>
										<path
											d="M0 0.5 L7.5 4 L0 7.5 Z"
											className="fill-muted-foreground/70"
										/>
									</marker>
									<marker
										id="tl-arrow-bad"
										viewBox="0 0 8 8"
										refX="7"
										refY="4"
										markerWidth="7"
										markerHeight="7"
										orient="auto"
									>
										<path d="M0 0.5 L7.5 4 L0 7.5 Z" className="fill-bad" />
									</marker>
									<marker
										id="tl-arrow-on"
										viewBox="0 0 8 8"
										refX="7"
										refY="4"
										markerWidth="7"
										markerHeight="7"
										orient="auto"
									>
										<path
											d="M0 0.5 L7.5 4 L0 7.5 Z"
											className="fill-foreground"
										/>
									</marker>
								</defs>
								{arrows.map((a) => {
									const on = selectedEdge === a.id;
									return (
										<g key={a.id}>
											<path
												d={a.d}
												fill="none"
												strokeWidth={on ? 2 : 1.25}
												className={cn(
													"transition-[stroke] duration-(--duration-quick)",
													on
														? "stroke-foreground"
														: a.bad
															? "stroke-bad"
															: "stroke-muted-foreground/60",
												)}
												markerEnd={`url(#${on ? "tl-arrow-on" : a.bad ? "tl-arrow-bad" : "tl-arrow"})`}
											/>
											{/* biome-ignore lint/a11y/useSemanticElements: an SVG path can't be a <button> */}
											<path
												d={a.d}
												fill="none"
												stroke="transparent"
												strokeWidth={12}
												className="pointer-events-auto cursor-pointer outline-none"
												tabIndex={0}
												role="button"
												aria-label={`${a.label}${a.bad ? ", starts too early" : ""}. Press Delete to remove.`}
												aria-pressed={on}
												onClick={(e) => {
													e.stopPropagation();
													setSelectedEdge(a.id);
												}}
												onFocus={() => setSelectedEdge(a.id)}
												onBlur={() =>
													setSelectedEdge((cur) => (cur === a.id ? null : cur))
												}
												onKeyDown={(e) => {
													if (e.key === "Escape") setSelectedEdge(null);
													if (
														(e.key === "Delete" || e.key === "Backspace") &&
														!readOnly
													) {
														e.preventDefault();
														setSelectedEdge(null);
														removeDep.mutate(
															{
																id: a.edge.taskId,
																blockedById: a.edge.blockedById,
															},
															{
																onSuccess: () =>
																	toast.success(`Removed: ${a.label}`),
																onError: (err) =>
																	toast.error("Couldn't remove it", {
																		description: err.message,
																	}),
															},
														);
													}
												}}
											/>
										</g>
									);
								})}
								{link && (
									<path
										d={`M${link.x0} ${link.y0} L${link.x} ${link.y}`}
										className="stroke-brand"
										strokeWidth={1.5}
										strokeDasharray="4 3"
										fill="none"
									/>
								)}
							</svg>

							{vRows.map((vr) => {
								const r = rows[vr.index];
								if (r?.kind !== "task") return null;
								const t = effective(r.task);
								const g = barGeometry(t, origin, pxPerDay);
								if (!g || !inWindow(g.x - 200, g.width + 400)) return null;
								return (
									<Bar
										key={r.key}
										task={t}
										geometry={g}
										top={vr.start}
										meta={meta}
										readOnly={readOnly}
										tip={dragTip?.id === t.id ? dragTip.dates : null}
										onPointerDown={(e, mode) =>
											onBarPointerDown(e, r.task, mode)
										}
										onPointerMove={onBarPointerMove}
										onPointerUp={() => onBarPointerUp(r.task)}
										onKeyDown={(e) => onBarKey(e, r.task)}
										onLinkDown={(e) =>
											onLinkDown(
												e,
												r.task,
												g.x + g.width + 8,
												vr.start + ROW / 2,
											)
										}
									/>
								);
							})}
						</div>
					</div>
				</div>
			</section>

			<UnscheduledTray
				tasks={unscheduled}
				readOnly={readOnly}
				gridRef={gridRef}
				origin={origin}
				pxPerDay={pxPerDay}
				today={today}
				workingDays={meta.workingDays}
				onOpenTask={onOpenTask}
				onSchedule={(t, start) => {
					const len = Math.max(1, Math.ceil((t.estimateMinutes ?? 0) / 480));
					void commitDates(
						t,
						{
							startDate: start,
							dueDate: addWorkingDays(start, len - 1, meta.workingDays),
						},
						false,
					);
				}}
			/>

			{prompt && (
				<div
					role="status"
					className="t-reveal absolute right-4 bottom-4 z-40 w-80 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-float ring-1 ring-border"
				>
					<p className="font-medium text-balance">
						{prompt.task.key} now ends later. Also move {prompt.changes.length}{" "}
						dependent task
						{prompt.changes.length === 1 ? "" : "s"}?
					</p>
					<ul className="mt-2 flex max-h-32 flex-col gap-1 overflow-auto text-xs text-muted-foreground">
						{prompt.changes.map((c) => {
							const cur = tasks.find((x) => x.id === c.id);
							return (
								<li key={c.id} className="flex gap-2 tabular">
									<span className="font-mono">{cur?.key}</span>
									<span className="truncate">
										{cur?.startDate ? shortDate(cur.startDate) : "–"} →{" "}
										<span className="text-foreground">
											{c.startDate ? shortDate(c.startDate) : "–"}
										</span>
									</span>
								</li>
							);
						})}
					</ul>
					<div className="mt-3 flex justify-end gap-2">
						<Button variant="ghost" size="sm" onClick={() => setPrompt(null)}>
							Keep them
						</Button>
						<Button size="sm" onClick={() => void applyShift(prompt)}>
							Move {prompt.changes.length}
						</Button>
					</div>
				</div>
			)}

			<DependencyDialog
				task={depTask}
				tasks={tasks}
				edges={edges}
				onClose={() => setDepTask(null)}
			/>
			<ListEquivalentDialog
				open={listOpen}
				onOpenChange={setListOpen}
				rows={rows}
				unscheduled={unscheduled}
				edges={edges}
				meta={meta}
				onOpenTask={(id) => {
					setListOpen(false);
					onOpenTask(id);
				}}
			/>
		</div>
	);
}

function TreeRow({
	row: r,
	top,
	meta,
	onToggle,
	onOpenTask,
}: {
	row: TimelineRow;
	top: number;
	meta: ProjectMeta;
	onToggle: () => void;
	onOpenTask: (id: string) => void;
}) {
	const base = "absolute inset-x-0 flex items-center gap-1.5 pr-3";
	if (r.kind === "group")
		return (
			<div
				className={cn(base, "bg-muted/50 pl-2 dark:bg-muted/25")}
				style={{ top, height: ROW }}
			>
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={!r.collapsed}
					className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-semibold outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ChevronRight
						className={cn(
							"size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-quick)",
							!r.collapsed && "rotate-90",
						)}
						aria-hidden
					/>
					{r.color && (
						<span
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								WORK_DOT[r.color],
							)}
						/>
					)}
					<span className="truncate">{r.label}</span>
					<span className="font-normal text-muted-foreground tabular">
						{r.count}
					</span>
				</button>
			</div>
		);
	const t = r.task;
	const closed = isClosedTask(meta, t);
	return (
		<div
			className={base}
			style={{ top, height: ROW, paddingLeft: 8 + r.depth * 16 }}
		>
			{r.hasChildren ? (
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={!r.collapsed}
					aria-label={`${r.collapsed ? "Show" : "Hide"} subtasks of ${t.key}`}
					className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ChevronRight
						className={cn(
							"size-3.5 transition-transform duration-(--duration-quick)",
							!r.collapsed && "rotate-90",
						)}
					/>
				</button>
			) : (
				<span className="size-5 shrink-0" />
			)}
			<button
				type="button"
				onClick={() => onOpenTask(t.id)}
				className={cn(
					"flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-1 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
					closed && "text-muted-foreground",
				)}
			>
				<span className="shrink-0 font-mono text-2xs text-muted-foreground tabular">
					{t.key}
				</span>
				<span className={cn("truncate", closed && "line-through decoration-1")}>
					{t.title}
				</span>
			</button>
		</div>
	);
}

/** Drag the pane's edge (or focus it and use ←/→) to resize the tree. */
function PaneResizer({
	width,
	onChange,
}: {
	width: number;
	onChange: (w: number) => void;
}) {
	const clamp = (w: number) => Math.max(200, Math.min(560, w));
	return (
		// biome-ignore lint/a11y/useSemanticElements: a focusable, draggable splitter; <hr> can't take focus or pointer drags
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize task column"
			aria-valuenow={width}
			aria-valuemin={200}
			aria-valuemax={560}
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === "ArrowLeft") onChange(clamp(width - 16));
				if (e.key === "ArrowRight") onChange(clamp(width + 16));
			}}
			onPointerDown={(e) => {
				const x0 = e.clientX;
				const w0 = width;
				const el = e.currentTarget;
				el.setPointerCapture(e.pointerId);
				const move = (ev: PointerEvent) =>
					onChange(clamp(w0 + ev.clientX - x0));
				const up = () => {
					el.removeEventListener("pointermove", move);
					el.removeEventListener("pointerup", up);
				};
				el.addEventListener("pointermove", move);
				el.addEventListener("pointerup", up);
			}}
			className="absolute top-0 -right-1 bottom-0 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent hover:after:bg-brand focus-visible:after:bg-brand"
		/>
	);
}

function Bar({
	task: t,
	geometry: g,
	top,
	meta,
	readOnly,
	tip,
	onPointerDown,
	onPointerMove,
	onPointerUp,
	onKeyDown,
	onLinkDown,
}: {
	task: WorkTaskListItem;
	geometry: NonNullable<ReturnType<typeof barGeometry>>;
	top: number;
	meta: ProjectMeta;
	readOnly: boolean;
	tip: Dates | null;
	onPointerDown: (e: React.PointerEvent, mode: DragMode) => void;
	onPointerMove: (e: React.PointerEvent) => void;
	onPointerUp: () => void;
	onKeyDown: (e: React.KeyboardEvent) => void;
	onLinkDown: (e: React.PointerEvent) => void;
}) {
	const status = meta.statusById.get(t.statusId);
	const color = status?.color ?? "gray";
	const closed = isClosedTask(meta, t);
	const progress = taskProgress(t);
	const milestone = g.kind === "milestone";
	const width = Math.max(g.width, 6);
	// Rough text width at 12px: label inside when it fits, else to the right.
	const inside = !milestone && width > t.title.length * 6.4 + 20;
	const dates =
		t.startDate && t.dueDate && t.startDate !== t.dueDate
			? `${shortDate(t.startDate)} to ${shortDate(t.dueDate)}`
			: shortDate((t.dueDate ?? t.startDate) as string);
	const handlers = {
		onPointerMove,
		onPointerUp,
		onPointerCancel: onPointerUp,
	};
	return (
		<div
			className="group/bar absolute"
			style={{ left: g.x, top: top + (ROW - BAR) / 2, height: BAR, width }}
		>
			<button
				type="button"
				data-bar-task={t.id}
				aria-label={`${t.key} ${t.title}, ${milestone ? "milestone on " : ""}${dates}${status ? `, ${status.name}` : ""}${t.blocked ? ", blocked" : ""}`}
				aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Meta+D Enter"
				onPointerDown={(e) => onPointerDown(e, "move")}
				onKeyDown={onKeyDown}
				{...handlers}
				style={
					milestone ? { left: width / 2 - 7, top: (BAR - 14) / 2 } : undefined
				}
				className={cn(
					"absolute touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
					readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
					milestone
						? "size-3.5 rotate-45 rounded-[3px]"
						: cn(
								"inset-0",
								"overflow-hidden rounded-md ring-1 ring-inset",
								closed
									? "bg-muted text-muted-foreground ring-border"
									: WORK_BAR[color],
								g.kind === "due_only" &&
									"rounded-l-none border-l-[1.5px] border-dashed border-current/50",
								g.kind === "start_only" &&
									"rounded-r-none border-r-[1.5px] border-dashed border-current/50",
							),
					milestone && (closed ? "bg-muted-foreground/60" : WORK_DOT[color]),
				)}
			>
				{!milestone && progress !== null && (
					<span
						aria-hidden
						className={cn(
							"absolute inset-y-0 left-0",
							closed ? "bg-foreground/5" : WORK_FILL[color],
						)}
						style={{ width: `${Math.round(progress * 100)}%` }}
					/>
				)}
				{inside && (
					<span className="relative flex h-full items-center truncate px-2 text-xs font-medium">
						{t.title}
					</span>
				)}
			</button>
			{!readOnly && !milestone && (
				<>
					<span
						aria-hidden
						onPointerDown={(e) => onPointerDown(e, "start")}
						{...handlers}
						className={cn(
							"absolute inset-y-0 -left-1 w-2.5 cursor-ew-resize touch-none",
							!t.startDate && "hidden",
						)}
					/>
					<span
						aria-hidden
						onPointerDown={(e) => onPointerDown(e, "end")}
						{...handlers}
						className="absolute inset-y-0 -right-1 w-2.5 cursor-ew-resize touch-none"
					/>
				</>
			)}
			{!readOnly && (
				<span
					aria-hidden
					title="Drag to a task this one blocks"
					onPointerDown={onLinkDown}
					className="absolute top-1/2 grid size-4 -translate-y-1/2 cursor-crosshair touch-none place-items-center opacity-0 transition-opacity duration-(--duration-quick) group-focus-within/bar:opacity-100 group-hover/bar:opacity-100"
					style={{ left: milestone ? `calc(50% + 10px)` : "calc(100% + 1px)" }}
				>
					<span className="size-2 rounded-full bg-card ring-[1.5px] ring-foreground/50" />
				</span>
			)}
			<div
				className="pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap"
				style={{
					left: milestone
						? `calc(50% + 14px)`
						: `calc(100% + ${readOnly ? 6 : 18}px)`,
				}}
			>
				<AvatarStack
					ids={t.assigneeIds ?? []}
					people={meta.personById}
					size="xs"
					max={2}
				/>
				{!inside && (
					<span
						className={cn(
							"text-xs",
							closed ? "text-muted-foreground" : "text-foreground/85",
						)}
					>
						{t.title}
					</span>
				)}
			</div>
			{tip && (
				<div
					role="status"
					className="pointer-events-none absolute -top-7 left-0 z-10 rounded-md bg-primary px-1.5 py-0.5 text-2xs whitespace-nowrap text-primary-foreground shadow-float tabular"
				>
					{tip.startDate ? shortDate(tip.startDate) : "No start"} →{" "}
					{tip.dueDate ? shortDate(tip.dueDate) : "No due"}
				</div>
			)}
		</div>
	);
}

function UnscheduledTray({
	tasks,
	readOnly,
	gridRef,
	origin,
	pxPerDay,
	today,
	workingDays,
	onOpenTask,
	onSchedule,
}: {
	tasks: readonly WorkTaskListItem[];
	readOnly: boolean;
	gridRef: React.RefObject<HTMLDivElement | null>;
	origin: string;
	pxPerDay: number;
	today: string;
	workingDays: number;
	onOpenTask: (id: string) => void;
	onSchedule: (t: WorkTaskListItem, start: string) => void;
}) {
	const [open, setOpen] = useState(true);
	const [ghost, setGhost] = useState<{
		task: WorkTaskListItem;
		x: number;
		y: number;
		date: string | null;
	} | null>(null);
	if (!tasks.length) return null;
	const dateAt = (cx: number, cy: number) => {
		const r = gridRef.current?.getBoundingClientRect();
		const scroller = gridRef.current
			?.closest("[data-timeline-scroller]")
			?.getBoundingClientRect();
		if (!r || !scroller) return null;
		if (
			cx < scroller.left ||
			cx > scroller.right ||
			cy < scroller.top ||
			cy > scroller.bottom
		)
			return null;
		if (cx < r.left) return null;
		return addDays(origin, Math.floor((cx - r.left) / pxPerDay));
	};
	return (
		<section
			aria-label="Unscheduled tasks"
			className="rounded-xl bg-muted/50 px-3 py-2 dark:bg-muted/30"
		>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className="flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ChevronRight
					className={cn(
						"size-3.5 transition-transform duration-(--duration-quick)",
						open && "rotate-90",
					)}
					aria-hidden
				/>
				Unscheduled
				<span className="tabular">{tasks.length}</span>
				{!readOnly && open && (
					<span className="font-normal">
						· drag one onto the grid to give it dates
					</span>
				)}
			</button>
			{open && (
				<ul className="mt-2 flex gap-2 overflow-x-auto pb-1">
					{tasks.map((t) => (
						<li
							key={t.id}
							className="flex shrink-0 items-center rounded-lg bg-card ring-1 ring-border"
						>
							<button
								type="button"
								onClick={() => onOpenTask(t.id)}
								onPointerDown={(e) => {
									if (readOnly || e.button !== 0) return;
									const x0 = e.clientX;
									const y0 = e.clientY;
									let active = false;
									const move = (ev: PointerEvent) => {
										if (
											!active &&
											Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4
										)
											return;
										active = true;
										setGhost({
											task: t,
											x: ev.clientX,
											y: ev.clientY,
											date: dateAt(ev.clientX, ev.clientY),
										});
									};
									const up = (ev: PointerEvent) => {
										window.removeEventListener("pointermove", move);
										window.removeEventListener("pointerup", up);
										setGhost(null);
										if (!active) return;
										const d = dateAt(ev.clientX, ev.clientY);
										if (d)
											onSchedule(
												t,
												isWorkingDay(d, workingDays)
													? d
													: addWorkingDays(d, 1, workingDays),
											);
									};
									window.addEventListener("pointermove", move);
									window.addEventListener("pointerup", up);
								}}
								className="flex max-w-64 cursor-grab items-baseline gap-2 rounded-l-lg py-1.5 pr-2 pl-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span className="font-mono text-2xs text-muted-foreground tabular">
									{t.key}
								</span>
								<span className="truncate">{t.title}</span>
							</button>
							{!readOnly && (
								<Button
									variant="ghost"
									size="icon-xs"
									className="mr-1 text-muted-foreground"
									aria-label={`Schedule ${t.key} from today`}
									title="Schedule from today"
									onClick={() => onSchedule(t, today)}
								>
									<CalendarClock />
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			{ghost && (
				<div
					className="pointer-events-none fixed z-50 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground shadow-float"
					style={{ left: ghost.x + 12, top: ghost.y + 12 }}
				>
					{ghost.task.key}{" "}
					{ghost.date
						? `→ starts ${shortDate(ghost.date)}`
						: "· drop on the grid"}
				</div>
			)}
		</section>
	);
}
