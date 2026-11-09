// biome-ignore-all lint/a11y/useSemanticElements: an ARIA grid over CSS grid; spans are absolutely placed across cells, which a <table> can't hold
// biome-ignore-all lint/a11y/useFocusableInteractive: rows and column headers of the grid aren't stops; the day cells carry the roving tab stop
/*
 * Calendar: a six-week month grid with multi-day spans stacked into lanes, or a
 * week with an all-day row over an hour grid for tasks with a due time. Drags
 * reschedule (keeping duration), edge drags resize, and every drag has a key.
 */
import type { WorkTaskListItem } from "@logistack/contracts";
import {
	addDays,
	addWorkingDays,
	daysBetween,
	isWorkingDay,
	localDate,
	startOfWeek,
} from "@logistack/core/work";
import { useQueryClient } from "@tanstack/react-query";
import {
	CalendarDays,
	CalendarPlus,
	ChevronLeft,
	ChevronRight,
	PanelRight,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
	patchCachedTask,
	useCreateWorkTask,
	usePatchWorkTask,
	useSetWorkTaskField,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import {
	type CalItem,
	hiddenPerDay,
	itemsOn,
	layoutWeek,
	monthGrid,
	type Segment,
} from "./calendar/layout";
import { WORK_BAR, WORK_DOT } from "./common/colors";
import {
	isClosedTask,
	type ProjectMeta,
	shortDate,
	useAllTasks,
	useProjectMeta,
	viewTaskQuery,
} from "./common/data";
import type { ViewProps } from "./types";

type Item = CalItem & { task: WorkTaskListItem; time: string | null };
type DragMode = "move" | "start" | "end";
type Range = { start: string; end: string; time: string | null };

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const SKELETON_DAYS = Array.from({ length: 21 }, (_, i) => `d${i}`);
const LANE = 22;
const DAY_HEAD = 28;
const MONTH_LANES = 3;
const HOUR = 44;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_TITLE = new Intl.DateTimeFormat("en", {
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});
const DAY_TITLE = new Intl.DateTimeFormat("en", {
	weekday: "long",
	month: "long",
	day: "numeric",
	timeZone: "UTC",
});
const utc = (d: string) => new Date(`${d}T00:00:00Z`);
const toMinutes = (t: string) =>
	Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toTime = (m: number) =>
	`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The calendar dates of a task for the chosen date field, or null when it has none. */
function rangeOf(t: WorkTaskListItem, dateField: string): Range | null {
	if (dateField === "due")
		return t.dueDate
			? { start: t.dueDate, end: t.dueDate, time: t.dueTime }
			: null;
	if (dateField === "span") {
		const start = t.startDate ?? t.dueDate;
		const end = t.dueDate ?? t.startDate;
		if (!start || !end) return null;
		return start <= end
			? { start, end, time: t.startDate ? null : t.dueTime }
			: { start: end, end: start, time: null };
	}
	const v = t.fields?.[dateField.slice(6)];
	if (typeof v !== "string" || v.length < 10) return null;
	const d = v.slice(0, 10);
	return { start: d, end: d, time: v.length > 10 ? v.slice(11, 16) : null };
}

function shifted(r: Range, mode: DragMode, days: number): Range {
	if (mode === "move")
		return { ...r, start: addDays(r.start, days), end: addDays(r.end, days) };
	if (mode === "start") {
		const s = addDays(r.start, days);
		// biome-ignore lint/complexity/useMathMinMax: ISO date strings, not numbers
		return { ...r, start: s > r.end ? r.end : s };
	}
	const e = addDays(r.end, days);
	// biome-ignore lint/complexity/useMathMinMax: ISO date strings, not numbers
	return { ...r, end: e < r.start ? r.start : e };
}

export function CalendarView({
	project,
	config,
	onConfigChange,
	onOpenTask,
	listId,
}: ViewProps) {
	const meta = useProjectMeta(project.id);
	const cal = config.calendar;
	const setCal = (next: Partial<typeof cal>) =>
		onConfigChange({ calendar: { ...cal, ...next } });
	const { tasks, pending } = useAllTasks(
		useMemo(
			() => viewTaskQuery(project.id, config, listId),
			[project.id, config, listId],
		),
	);
	const today = useMemo(() => localDate(new Date()), []);
	const [cursor, setCursor] = useState(today);
	const [focused, setFocused] = useState(today);
	const [sidebar, setSidebar] = useState(true);
	const [overrides, setOverrides] = useState<Map<string, Range>>(new Map());
	const [dayPop, setDayPop] = useState<{
		date: string;
		mode: "list" | "new";
	} | null>(null);

	const dateFields = meta.fields.filter((f) => f.config.kind === "date");
	const items = useMemo(() => {
		const out: Item[] = [];
		for (const t of tasks) {
			const r = overrides.get(t.id) ?? rangeOf(t, cal.dateField);
			if (r) out.push({ id: t.id, task: t, ...r });
		}
		return out;
	}, [tasks, cal.dateField, overrides]);
	const unscheduled = useMemo(
		() =>
			tasks.filter((t) => !rangeOf(t, cal.dateField) && !isClosedTask(meta, t)),
		[tasks, cal.dateField, meta],
	);

	// --- writes ------------------------------------------------------------------
	const qc = useQueryClient();
	const patch = usePatchWorkTask();
	const setField = useSetWorkTaskField();
	const create = useCreateWorkTask();
	const commit = (t: WorkTaskListItem, from: Range | null, to: Range) => {
		setOverrides((m) => {
			const n = new Map(m);
			n.delete(t.id);
			return n;
		});
		const fail = (e: Error) =>
			toast.error(`Couldn't reschedule ${t.key}`, { description: e.message });
		if (cal.dateField.startsWith("field:")) {
			const fieldId = cal.dateField.slice(6);
			const value = to.time ? `${to.start}T${to.time}` : to.start;
			const rollback = patchCachedTask(qc, t.id, (x) => ({
				...x,
				fields: { ...x.fields, [fieldId]: value },
			}));
			setField.mutate(
				{ id: t.id, fieldId, value },
				{
					onError: (e) => {
						rollback();
						fail(e);
					},
				},
			);
			return;
		}
		let next: Parameters<typeof patch.mutate>[0]["patch"];
		if (cal.dateField === "due") {
			// The due date moves; a start moves with it so the task keeps its length.
			const delta = from ? daysBetween(from.end, to.end) : 0;
			next = {
				dueDate: to.end,
				...(t.startDate && from
					? { startDate: addDays(t.startDate, delta) }
					: {}),
				...(to.time !== (from?.time ?? null) ? { dueTime: to.time } : {}),
			};
		} else if (!from) {
			next = { startDate: to.start, dueDate: to.end };
		} else {
			// A move shifts the dates the task has; dragging an edge may add the missing one.
			const resizedStart = to.start !== from.start && to.end === from.end;
			const resizedEnd = to.end !== from.end && to.start === from.start;
			next = {
				...(t.startDate || resizedStart ? { startDate: to.start } : {}),
				...(t.dueDate || resizedEnd ? { dueDate: to.end } : {}),
				...(to.time !== from.time ? { dueTime: to.time } : {}),
			};
		}
		patch.mutate({ id: t.id, patch: next }, { onError: fail });
	};
	const scheduleOn = (t: WorkTaskListItem, day: string) => {
		const len = Math.max(1, Math.ceil((t.estimateMinutes ?? 0) / 480));
		const end =
			cal.dateField === "span"
				? addWorkingDays(day, len - 1, meta.workingDays)
				: day;
		commit(t, null, { start: day, end, time: null });
	};
	const createOn = (day: string, title: string) => {
		const list = listId ?? meta.defaultListId;
		if (!list) return;
		create.mutate(
			{
				listId: list,
				title,
				...(cal.dateField.startsWith("field:")
					? { fields: { [cal.dateField.slice(6)]: day } }
					: { dueDate: day }),
			},
			{
				onSuccess: (t) =>
					toast.success(`Created ${t.key}, due ${shortDate(day)}`),
				onError: (e) =>
					toast.error("Couldn't create the task", { description: e.message }),
			},
		);
	};

	// --- pointer drags: the day (and time) under the pointer decides -------------------
	const drag = useRef<{
		item: Item;
		mode: DragMode;
		grab: { date: string; minutes: number | null };
		moved: boolean;
		next: Range | null;
	} | null>(null);
	const hit = (x: number, y: number) => {
		for (const el of document.elementsFromPoint(x, y)) {
			const cell = (el as HTMLElement).closest?.(
				"[data-cal-date]",
			) as HTMLElement | null;
			if (!cell) continue;
			const date = cell.dataset.calDate ?? "";
			if (cell.dataset.calHours === undefined) return { date, minutes: null };
			const r = cell.getBoundingClientRect();
			const m = Math.round(((y - r.top) / HOUR) * 4) * 15;
			return { date, minutes: Math.max(0, Math.min(23 * 60 + 45, m)) };
		}
		return null;
	};
	const onItemDown = (e: React.PointerEvent, item: Item, mode: DragMode) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		const h = hit(e.clientX, e.clientY);
		if (!h) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag.current = { item, mode, grab: h, moved: false, next: null };
	};
	const onItemMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const h = hit(e.clientX, e.clientY);
		if (!h) return;
		const days = daysBetween(d.grab.date, h.date);
		const base = rangeOf(d.item.task, cal.dateField) ?? d.item;
		let next = shifted(base, d.mode, days);
		if (
			d.mode === "move" &&
			base.time &&
			h.minutes !== null &&
			d.grab.minutes !== null
		)
			next = {
				...next,
				time: toTime(
					Math.max(
						0,
						Math.min(
							23 * 60 + 45,
							toMinutes(base.time) + h.minutes - d.grab.minutes,
						),
					),
				),
			};
		const cur = d.next ?? base;
		if (
			cur.start === next.start &&
			cur.end === next.end &&
			cur.time === next.time
		)
			return;
		d.moved = true;
		d.next = next;
		setOverrides((m) => new Map(m).set(d.item.id, next));
	};
	const onItemUp = (item: Item) => {
		const d = drag.current;
		drag.current = null;
		if (!d?.moved) {
			onOpenTask(item.task.id);
			return;
		}
		const next = d.next;
		const from = rangeOf(item.task, cal.dateField);
		if (
			next &&
			from &&
			(next.start !== from.start ||
				next.end !== from.end ||
				next.time !== from.time)
		)
			commit(item.task, from, next);
		else
			setOverrides((m) => {
				const n = new Map(m);
				n.delete(item.id);
				return n;
			});
	};
	const onItemKey = (e: React.KeyboardEvent, item: Item) => {
		if (!e.altKey || !e.key.startsWith("Arrow")) return;
		e.preventDefault();
		e.stopPropagation();
		const step =
			{ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key] ?? 0;
		const from = rangeOf(item.task, cal.dateField);
		if (!from) return;
		commit(item.task, from, shifted(from, e.shiftKey ? "end" : "move", step));
	};
	const itemProps = (item: Item) => ({
		onPointerDown: (e: React.PointerEvent) => onItemDown(e, item, "move"),
		onPointerMove: onItemMove,
		onPointerUp: () => onItemUp(item),
		onKeyDown: (e: React.KeyboardEvent) => onItemKey(e, item),
		onEdgeDown: (e: React.PointerEvent, mode: DragMode) =>
			onItemDown(e, item, mode),
	});

	// --- navigation and the keyboard grid -------------------------------------------
	const days =
		cal.mode === "month"
			? monthGrid(cursor)
			: Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i));
	const step = (dir: -1 | 1) => {
		const next =
			cal.mode === "month"
				? (() => {
						const d = utc(`${cursor.slice(0, 7)}-01`);
						d.setUTCMonth(d.getUTCMonth() + dir);
						return d.toISOString().slice(0, 10);
					})()
				: addDays(cursor, 7 * dir);
		setCursor(next);
		setFocused(next);
	};
	const gridRef = useRef<HTMLDivElement>(null);
	const focusDay = (d: string) => {
		setFocused(d);
		if (!days.includes(d)) setCursor(d);
	};
	useEffect(() => {
		const el = gridRef.current?.querySelector<HTMLElement>(
			`[data-cal-cell="${focused}"]`,
		);
		if (el && gridRef.current?.contains(document.activeElement)) el.focus();
	}, [focused]);
	const onGridKey = (e: React.KeyboardEvent) => {
		if ((e.target as HTMLElement).dataset.calCell === undefined) return;
		const moves: Record<string, number> = {
			ArrowLeft: -1,
			ArrowRight: 1,
			ArrowUp: cal.mode === "month" ? -7 : 0,
			ArrowDown: cal.mode === "month" ? 7 : 0,
		};
		if (e.key in moves && moves[e.key]) {
			e.preventDefault();
			focusDay(addDays(focused, moves[e.key] ?? 0));
		} else if (e.key === "PageUp" || e.key === "PageDown") {
			e.preventDefault();
			step(e.key === "PageUp" ? -1 : 1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			setDayPop({ date: focused, mode: "list" });
		} else if (e.key === "n" && !e.metaKey && !e.ctrlKey) {
			e.preventDefault();
			setDayPop({ date: focused, mode: "new" });
		}
	};

	const title =
		cal.mode === "month"
			? MONTH_TITLE.format(utc(`${cursor.slice(0, 7)}-15`))
			: `${shortDate(days[0] ?? cursor)} – ${shortDate(days[6] ?? cursor)}, ${(days[6] ?? cursor).slice(0, 4)}`;
	const ctx: CalCtx = {
		meta,
		today,
		focused,
		cursorMonth: cursor.slice(0, 7),
		items,
		dayPop,
		setDayPop,
		onFocusDay: setFocused,
		itemProps,
		createOn,
		onOpenTask,
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex items-center">
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => step(-1)}
						aria-label={
							cal.mode === "month" ? "Previous month" : "Previous week"
						}
					>
						<ChevronLeft />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => step(1)}
						aria-label={cal.mode === "month" ? "Next month" : "Next week"}
					>
						<ChevronRight />
					</Button>
				</div>
				<h2
					className="min-w-40 text-md font-semibold tabular"
					aria-live="polite"
				>
					{title}
				</h2>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						setCursor(today);
						setFocused(today);
					}}
				>
					Today
				</Button>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<Select
						value={cal.dateField}
						onValueChange={(v) =>
							setCal({ dateField: v as typeof cal.dateField })
						}
					>
						<SelectTrigger size="sm" className="w-44" aria-label="Dates shown">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="due">Due date</SelectItem>
							<SelectItem value="span">Start to due</SelectItem>
							{dateFields.map((f) => (
								<SelectItem key={f.id} value={`field:${f.id}`}>
									{f.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Segmented
						label="Calendar range"
						value={cal.mode}
						onChange={(mode) => setCal({ mode })}
						options={[
							{ value: "month", label: "Month" },
							{ value: "week", label: "Week" },
						]}
					/>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={
							sidebar ? "Hide unscheduled tasks" : "Show unscheduled tasks"
						}
						aria-pressed={sidebar}
						onClick={() => setSidebar(!sidebar)}
						className={cn(sidebar && "bg-muted text-foreground")}
					>
						<PanelRight />
					</Button>
				</div>
			</div>

			<div className="flex min-h-0 flex-1 gap-3">
				<div
					ref={gridRef}
					role="grid"
					aria-label={`${title}. Arrow keys move between days, Enter lists a day's tasks, N adds one. On a task, Alt with an arrow moves it.`}
					onKeyDown={onGridKey}
					className="relative min-h-0 min-w-0 flex-1 overflow-auto rounded-xl bg-card ring-1 ring-border"
				>
					{pending ? (
						<div className="grid grid-cols-7 gap-px p-2">
							{SKELETON_DAYS.map((k) => (
								<Skeleton key={k} className="h-24 rounded-md" />
							))}
						</div>
					) : cal.mode === "month" ? (
						<MonthGrid days={days} ctx={ctx} />
					) : (
						<WeekGrid days={days} ctx={ctx} />
					)}
				</div>

				{sidebar && (
					<aside
						aria-label="Unscheduled tasks"
						className="hidden w-60 shrink-0 flex-col gap-2 overflow-auto rounded-xl bg-muted/50 p-3 md:flex dark:bg-muted/30"
					>
						<h3 className="flex items-baseline gap-1.5 text-xs font-medium text-muted-foreground">
							Unscheduled <span className="tabular">{unscheduled.length}</span>
						</h3>
						{unscheduled.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								Every open task has a date.
							</p>
						) : (
							<>
								<p className="text-2xs text-muted-foreground">
									Drag onto a day, or press the calendar button to put it on{" "}
									{shortDate(focused)}.
								</p>
								<ul className="flex flex-col gap-1.5">
									{unscheduled.map((t) => (
										<UnscheduledChip
											key={t.id}
											task={t}
											focused={focused}
											onOpenTask={onOpenTask}
											onSchedule={(day) => scheduleOn(t, day)}
											hitDate={(x, y) => hit(x, y)?.date ?? null}
										/>
									))}
								</ul>
							</>
						)}
					</aside>
				)}
			</div>
		</div>
	);
}

type CalCtx = {
	meta: ProjectMeta;
	today: string;
	focused: string;
	cursorMonth: string;
	items: Item[];
	dayPop: { date: string; mode: "list" | "new" } | null;
	setDayPop: (p: { date: string; mode: "list" | "new" } | null) => void;
	onFocusDay: (d: string) => void;
	itemProps: (item: Item) => {
		onPointerDown: (e: React.PointerEvent) => void;
		onPointerMove: (e: React.PointerEvent) => void;
		onPointerUp: () => void;
		onKeyDown: (e: React.KeyboardEvent) => void;
		onEdgeDown: (e: React.PointerEvent, mode: DragMode) => void;
	};
	createOn: (day: string, title: string) => void;
	onOpenTask: (id: string) => void;
};

function MonthGrid({ days, ctx }: { days: string[]; ctx: CalCtx }) {
	const weeks = Array.from({ length: 6 }, (_, i) =>
		days.slice(i * 7, i * 7 + 7),
	);
	return (
		<div className="flex min-w-[42rem] flex-col">
			<div
				role="row"
				className="sticky top-0 z-20 grid grid-cols-7 border-b border-border bg-card"
			>
				{WEEKDAYS.map((d, i) => (
					<div
						key={d}
						role="columnheader"
						className={cn(
							"px-2 py-1.5 text-2xs font-medium text-muted-foreground",
							!isWorkingDay(days[i] ?? "", ctx.meta.workingDays) &&
								"text-muted-foreground/70",
						)}
					>
						{d}
					</div>
				))}
			</div>
			{weeks.map((week) => (
				<WeekRow key={week[0]} week={week} ctx={ctx} />
			))}
		</div>
	);
}

function WeekRow({ week, ctx }: { week: string[]; ctx: CalCtx }) {
	const start = week[0] ?? "";
	const segments = layoutWeek(ctx.items, start);
	const hidden = hiddenPerDay(segments, MONTH_LANES);
	return (
		<div
			role="row"
			className="relative grid flex-1 grid-cols-7 border-b border-border last:border-b-0"
			style={{ minHeight: DAY_HEAD + MONTH_LANES * LANE + 30 }}
		>
			{week.map((d, i) => (
				<DayCell key={d} date={d} col={i} ctx={ctx} hidden={hidden[i] ?? 0} />
			))}
			<div
				className="pointer-events-none absolute inset-x-0 top-0"
				style={{ paddingTop: DAY_HEAD }}
			>
				{segments
					.filter((s) => s.lane < MONTH_LANES)
					.map((s) => (
						<SpanChip key={s.item.id} segment={s} ctx={ctx} />
					))}
			</div>
		</div>
	);
}

function DayCell({
	date: d,
	col,
	ctx,
	hidden,
}: {
	date: string;
	col: number;
	ctx: CalCtx;
	hidden: number;
}) {
	const outside = d.slice(0, 7) !== ctx.cursorMonth;
	const off = !isWorkingDay(d, ctx.meta.workingDays);
	const isToday = d === ctx.today;
	const pop = ctx.dayPop?.date === d ? ctx.dayPop : null;
	const count = itemsOn(ctx.items, d).length;
	return (
		<div
			role="gridcell"
			data-cal-date={d}
			data-cal-cell={d}
			tabIndex={d === ctx.focused ? 0 : -1}
			aria-selected={d === ctx.focused}
			aria-label={`${DAY_TITLE.format(utc(d))}, ${count ? `${count} task${count === 1 ? "" : "s"}` : "no tasks"}`}
			onFocus={() => ctx.onFocusDay(d)}
			onDoubleClick={() => ctx.setDayPop({ date: d, mode: "new" })}
			className={cn(
				"group/day relative border-border outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				col > 0 && "border-l",
				off && "bg-muted/40 dark:bg-muted/20",
			)}
		>
			<div className="flex h-7 items-center justify-between px-1.5">
				<span
					className={cn(
						"grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs tabular",
						outside ? "text-muted-foreground/60" : "text-muted-foreground",
						isToday && "bg-brand font-semibold text-brand-foreground",
					)}
				>
					{Number(d.slice(8, 10)) === 1 && !isToday
						? shortDate(d)
						: Number(d.slice(8, 10))}
				</span>
				<button
					type="button"
					tabIndex={-1}
					aria-hidden
					onClick={() => ctx.setDayPop({ date: d, mode: "new" })}
					className="grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity duration-(--duration-quick) group-hover/day:opacity-100 hover:bg-muted hover:text-foreground"
				>
					<CalendarPlus className="size-3.5" strokeWidth={1.75} />
				</button>
			</div>
			{hidden > 0 && (
				<button
					type="button"
					onClick={() => ctx.setDayPop({ date: d, mode: "list" })}
					className="absolute right-1 left-1 rounded px-1 text-left text-2xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					style={{ top: DAY_HEAD + MONTH_LANES * LANE + 2 }}
				>
					+{hidden} more
				</button>
			)}
			{pop && <DayPopover date={d} mode={pop.mode} ctx={ctx} />}
		</div>
	);
}

/** "+N more" list (Enter) or a quick new-task box (N), anchored to the day. */
function DayPopover({
	date,
	mode,
	ctx,
}: {
	date: string;
	mode: "list" | "new";
	ctx: CalCtx;
}) {
	const [title, setTitle] = useState("");
	const list = itemsOn(ctx.items, date);
	return (
		<Popover open onOpenChange={(o) => !o && ctx.setDayPop(null)}>
			<PopoverAnchor className="pointer-events-none absolute inset-0" />
			<PopoverContent
				align="start"
				className="w-72 p-2"
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				<p className="px-1 pb-1.5 text-xs font-medium">
					{DAY_TITLE.format(utc(date))}
				</p>
				{mode === "new" ? (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							if (!title.trim()) return;
							ctx.createOn(date, title.trim());
							ctx.setDayPop(null);
						}}
						className="flex gap-1.5"
					>
						<Input
							autoFocus
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="New task due this day"
							aria-label="Task title"
							maxLength={500}
						/>
						<Button type="submit" size="sm" disabled={!title.trim()}>
							Add
						</Button>
					</form>
				) : list.length === 0 ? (
					<p className="px-1 pb-1 text-xs text-muted-foreground">
						Nothing on this day. Press N to add a task.
					</p>
				) : (
					<ul className="flex max-h-72 flex-col gap-0.5 overflow-auto">
						{list.map((i) => (
							<li key={i.id}>
								<button
									type="button"
									onClick={() => {
										ctx.setDayPop(null);
										ctx.onOpenTask(i.task.id);
									}}
									className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted"
								>
									<span
										className={cn(
											"size-2 shrink-0 rounded-full",
											WORK_DOT[
												ctx.meta.statusById.get(i.task.statusId)?.color ??
													"gray"
											],
										)}
									/>
									<span className="font-mono text-2xs text-muted-foreground tabular">
										{i.task.key}
									</span>
									<span className="truncate">{i.task.title}</span>
									{i.time && (
										<span className="ml-auto text-2xs text-muted-foreground tabular">
											{i.time}
										</span>
									)}
								</button>
							</li>
						))}
					</ul>
				)}
			</PopoverContent>
		</Popover>
	);
}

function chipClass(ctx: CalCtx, t: WorkTaskListItem) {
	const closed = isClosedTask(ctx.meta, t);
	const color = ctx.meta.statusById.get(t.statusId)?.color ?? "gray";
	return cn(
		"ring-1 ring-inset",
		closed
			? "bg-muted text-muted-foreground ring-border line-through decoration-1"
			: WORK_BAR[color],
	);
}

function SpanChip({
	segment: s,
	ctx,
	offset = DAY_HEAD,
}: {
	segment: Segment<Item>;
	ctx: CalCtx;
	/** Space above the first lane (the day number in the month grid). */
	offset?: number;
}) {
	const t = s.item.task;
	const p = ctx.itemProps(s.item);
	const multi = s.item.start !== s.item.end;
	return (
		<div
			className="group/chip pointer-events-auto absolute px-1"
			style={{
				left: `${(s.col / 7) * 100}%`,
				width: `${(s.span / 7) * 100}%`,
				top: offset + s.lane * LANE,
				height: LANE - 3,
			}}
		>
			<button
				type="button"
				data-cal-item={t.id}
				aria-label={`${t.key} ${t.title}${multi ? `, ${shortDate(s.item.start)} to ${shortDate(s.item.end)}` : ""}`}
				aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
				onPointerDown={p.onPointerDown}
				onPointerMove={p.onPointerMove}
				onPointerUp={p.onPointerUp}
				onPointerCancel={p.onPointerUp}
				onKeyDown={p.onKeyDown}
				// Pointer clicks open on pointer-up; this is Enter and Space.
				onClick={(e) => e.detail === 0 && ctx.onOpenTask(t.id)}
				className={cn(
					"flex h-full w-full touch-none items-center gap-1 rounded-md px-1.5 text-left text-xs font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
					"cursor-grab active:cursor-grabbing",
					chipClass(ctx, t),
					s.clippedStart && "rounded-l-none",
					s.clippedEnd && "rounded-r-none",
				)}
			>
				{s.item.time && (
					<span className="shrink-0 tabular opacity-75">{s.item.time}</span>
				)}
				<span className="truncate">{t.title}</span>
			</button>
			{multi && !s.clippedStart && (
				<span
					aria-hidden
					onPointerDown={(e) => p.onEdgeDown(e, "start")}
					onPointerMove={p.onPointerMove}
					onPointerUp={p.onPointerUp}
					className="absolute inset-y-0 left-0 w-2 cursor-ew-resize touch-none"
				/>
			)}
			{!s.clippedEnd && (
				<span
					aria-hidden
					onPointerDown={(e) => p.onEdgeDown(e, "end")}
					onPointerMove={p.onPointerMove}
					onPointerUp={p.onPointerUp}
					className="absolute inset-y-0 right-0 w-2 cursor-ew-resize touch-none"
				/>
			)}
		</div>
	);
}

function WeekGrid({ days, ctx }: { days: string[]; ctx: CalCtx }) {
	const start = days[0] ?? "";
	const allDay = ctx.items.filter((i) => !i.time || i.start !== i.end);
	const timed = ctx.items.filter((i) => i.time && i.start === i.end);
	const segments = layoutWeek(allDay, start);
	const lanes = Math.max(1, ...segments.map((s) => s.lane + 1));
	const scroller = useRef<HTMLDivElement>(null);
	useEffect(() => {
		scroller.current?.scrollTo({ top: HOUR * 8 - 8 });
	}, []);
	return (
		<div className="flex h-full min-w-[42rem] flex-col">
			<div
				role="row"
				className="grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-border"
			>
				<div aria-hidden />
				{days.map((d) => (
					<div
						key={d}
						role="gridcell"
						data-cal-date={d}
						data-cal-cell={d}
						tabIndex={d === ctx.focused ? 0 : -1}
						aria-selected={d === ctx.focused}
						aria-label={DAY_TITLE.format(utc(d))}
						onFocus={() => ctx.onFocusDay(d)}
						className="relative border-l border-border px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					>
						<span className="text-2xs font-medium text-muted-foreground">
							{WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]}
						</span>{" "}
						<span
							className={cn(
								"inline-grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs tabular",
								d === ctx.today &&
									"bg-brand font-semibold text-brand-foreground",
							)}
						>
							{Number(d.slice(8, 10))}
						</span>
						{ctx.dayPop?.date === d && (
							<DayPopover date={d} mode={ctx.dayPop.mode} ctx={ctx} />
						)}
					</div>
				))}
			</div>
			<div
				className="relative grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-border"
				style={{ minHeight: lanes * LANE + 8 }}
			>
				<div className="px-2 pt-1.5 text-2xs text-muted-foreground">
					All day
				</div>
				{days.map((d) => (
					<div
						key={d}
						data-cal-date={d}
						className={cn(
							"border-l border-border",
							!isWorkingDay(d, ctx.meta.workingDays) &&
								"bg-muted/40 dark:bg-muted/20",
						)}
					/>
				))}
				<div className="pointer-events-none absolute top-1 right-0 left-14">
					{segments.map((s) => (
						<SpanChip key={s.item.id} segment={s} ctx={ctx} offset={0} />
					))}
				</div>
			</div>
			<div ref={scroller} className="relative min-h-0 flex-1 overflow-auto">
				<div
					className="relative grid grid-cols-[3.5rem_repeat(7,1fr)]"
					style={{ height: HOUR * 24 }}
				>
					<div className="relative">
						{HOURS.map((h) => (
							<span
								key={h}
								className="absolute right-2 -translate-y-1/2 text-2xs text-muted-foreground tabular"
								style={{ top: h * HOUR }}
							>
								{h ? `${String(h).padStart(2, "0")}:00` : ""}
							</span>
						))}
					</div>
					{days.map((d) => (
						<div
							key={d}
							data-cal-date={d}
							data-cal-hours=""
							className={cn(
								"relative border-l border-border",
								!isWorkingDay(d, ctx.meta.workingDays) &&
									"bg-muted/40 dark:bg-muted/20",
							)}
							style={{
								backgroundImage:
									"linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
								backgroundSize: `100% ${HOUR}px`,
							}}
						>
							{d === ctx.today && <NowLine />}
							{timed
								.filter((i) => i.start === d)
								.map((i) => (
									<TimedChip key={i.id} item={i} ctx={ctx} />
								))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function NowLine() {
	const [m, setM] = useState(() => {
		const n = new Date();
		return n.getHours() * 60 + n.getMinutes();
	});
	useEffect(() => {
		const id = window.setInterval(() => {
			const n = new Date();
			setM(n.getHours() * 60 + n.getMinutes());
		}, 60_000);
		return () => window.clearInterval(id);
	}, []);
	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-x-0 z-10 h-px bg-brand"
			style={{ top: (m / 60) * HOUR }}
		/>
	);
}

function TimedChip({ item, ctx }: { item: Item; ctx: CalCtx }) {
	const t = item.task;
	const p = ctx.itemProps(item);
	const minutes = toMinutes(item.time ?? "00:00");
	const length = Math.max(30, Math.min(240, t.estimateMinutes ?? 60));
	return (
		<button
			type="button"
			data-cal-item={t.id}
			aria-label={`${t.key} ${t.title}, due ${item.time}`}
			aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
			onPointerDown={p.onPointerDown}
			onPointerMove={p.onPointerMove}
			onPointerUp={p.onPointerUp}
			onPointerCancel={p.onPointerUp}
			onKeyDown={p.onKeyDown}
			onClick={(e) => e.detail === 0 && ctx.onOpenTask(t.id)}
			className={cn(
				"absolute inset-x-1 flex cursor-grab touch-none overflow-hidden rounded-md px-1.5 text-left text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
				length < 45 ? "items-center gap-1.5" : "flex-col py-1",
				chipClass(ctx, t),
			)}
			style={{
				top: (minutes / 60) * HOUR + 1,
				height: (length / 60) * HOUR - 2,
			}}
		>
			<span className="tabular opacity-75">{item.time}</span>
			<span className="truncate font-medium">{t.title}</span>
		</button>
	);
}

function UnscheduledChip({
	task: t,
	focused,
	onOpenTask,
	onSchedule,
	hitDate,
}: {
	task: WorkTaskListItem;
	focused: string;
	onOpenTask: (id: string) => void;
	onSchedule: (day: string) => void;
	hitDate: (x: number, y: number) => string | null;
}) {
	const [ghost, setGhost] = useState<{
		x: number;
		y: number;
		date: string | null;
	} | null>(null);
	return (
		<li className="flex items-center rounded-lg bg-card ring-1 ring-border">
			<button
				type="button"
				onClick={() => onOpenTask(t.id)}
				onPointerDown={(e) => {
					if (e.button !== 0) return;
					const x0 = e.clientX;
					const y0 = e.clientY;
					let active = false;
					const move = (ev: PointerEvent) => {
						if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4)
							return;
						active = true;
						setGhost({
							x: ev.clientX,
							y: ev.clientY,
							date: hitDate(ev.clientX, ev.clientY),
						});
					};
					const up = (ev: PointerEvent) => {
						window.removeEventListener("pointermove", move);
						window.removeEventListener("pointerup", up);
						setGhost(null);
						if (!active) return;
						const d = hitDate(ev.clientX, ev.clientY);
						if (d) onSchedule(d);
					};
					window.addEventListener("pointermove", move);
					window.addEventListener("pointerup", up);
				}}
				className="flex min-w-0 flex-1 cursor-grab flex-col rounded-l-lg px-2.5 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="font-mono text-2xs text-muted-foreground tabular">
					{t.key}
				</span>
				<span className="truncate text-sm">{t.title}</span>
			</button>
			<Button
				variant="ghost"
				size="icon-xs"
				className="mr-1 text-muted-foreground"
				aria-label={`Put ${t.key} on ${shortDate(focused)}`}
				title={`Put on ${shortDate(focused)}`}
				onClick={() => onSchedule(focused)}
			>
				<CalendarDays />
			</Button>
			{ghost && (
				<div
					className="pointer-events-none fixed z-50 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground shadow-float"
					style={{ left: ghost.x + 12, top: ghost.y + 12 }}
				>
					{t.key}{" "}
					{ghost.date ? `→ ${shortDate(ghost.date)}` : "· drop on a day"}
				</div>
			)}
		</li>
	);
}
