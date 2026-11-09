/*
 * TableView (section 13.2): a virtualised grid with group sections, inline editing per column,
 * multi-select with a bulk bar, subtasks under their parent, resizable and reorderable columns,
 * and a full keyboard model (arrows / j k, Enter opens, e edits, x selects, ⌘↑/⌘↓ moves).
 * The grid is hand-built on @tanstack/react-virtual: rows are a mix of group headers, tasks and
 * quick-add rows, which a column-model table would only get in the way of.
 */
import type { WorkTaskListItem } from "@logistack/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	ChevronRight,
	EyeOff,
	MoreHorizontal,
	Plus,
	SearchX,
} from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useMe } from "@/lib/api/access";
import { workTasksQuery } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { BulkBar } from "../bulk-bar";
import { type Column, effectiveColumns, toConfigColumns } from "../columns";
import { groupTasks, type TaskGroup } from "../grouping";
import { ColorDot, PersonAvatar, StatusIcon } from "../parts";
import { useTaskEdits } from "../task-edits";
import { isEditable, TableCell } from "./table-cells";
import type { ViewProps } from "./types";

const ROW = 36;
const SELECT_W = 36;

type Row =
	| { kind: "group"; group: TaskGroup; collapsed: boolean }
	| {
			kind: "task";
			task: WorkTaskListItem;
			depth: number;
			group: TaskGroup;
			expandable: boolean;
			expanded: boolean;
	  }
	| { kind: "add"; group: TaskGroup };

/** Hidden cells are skipped; the select column is index 0. */
type Focus = { row: number; col: number };

export function TableView({
	project,
	config,
	tasks,
	onOpenTask,
	onConfigChange,
	onCreateTask,
}: ViewProps) {
	const { data: me } = useMe();
	const edits = useTaskEdits();
	const allColumns = useMemo(
		() => effectiveColumns(config, project.fields),
		[config, project.fields],
	);
	const [widths, setWidths] = useState<Record<string, number>>({});
	const columns = allColumns
		.filter((c) => !c.hidden)
		.map((c) => ({ ...c, width: widths[c.key] ?? c.width }));

	// --- subtasks ------------------------------------------------------------
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const nested = config.showSubtasks === "nested";
	const subQuery = useInfiniteQuery({
		...workTasksQuery({
			...tasks.query,
			topLevel: undefined,
			filter: JSON.stringify({ key: "parent", op: "not_empty" }),
			limit: 200,
		}),
		enabled: nested && expanded.size > 0,
	});
	const children = useMemo(() => {
		const map = new Map<string, WorkTaskListItem[]>();
		if (!nested || expanded.size === 0) return map;
		for (const t of subQuery.data?.pages.flatMap((p) => p.items) ?? [])
			if (t.parentId) map.set(t.parentId, [...(map.get(t.parentId) ?? []), t]);
		return map;
	}, [nested, expanded.size, subQuery.data]);

	// --- rows --------------------------------------------------------------
	const groups = useMemo(
		() => groupTasks(tasks.items, config.groupBy, project),
		[tasks.items, config.groupBy, project],
	);
	const collapsed = new Set(config.collapsedGroups);
	const grouped = config.groupBy !== null;
	const rows: Row[] = useMemo(() => {
		const out: Row[] = [];
		for (const group of groups) {
			const isCollapsed = grouped && config.collapsedGroups.includes(group.key);
			if (grouped) out.push({ kind: "group", group, collapsed: isCollapsed });
			if (isCollapsed) continue;
			for (const task of group.tasks) {
				const subs = (task.counts?.subtasks ?? 0) > 0 && nested;
				const open = subs && expanded.has(task.id);
				out.push({
					kind: "task",
					task,
					depth: 0,
					group,
					expandable: subs,
					expanded: open,
				});
				if (open)
					for (const sub of children.get(task.id) ?? [])
						out.push({
							kind: "task",
							task: sub,
							depth: 1,
							group,
							expandable: false,
							expanded: false,
						});
			}
			if (project.canEdit) out.push({ kind: "add", group });
		}
		return out;
	}, [
		groups,
		grouped,
		config.collapsedGroups,
		nested,
		expanded,
		children,
		project.canEdit,
	]);

	// --- focus, editing, selection --------------------------------------------
	const [focus, setFocus] = useState<Focus>({ row: 0, col: 2 });
	const [editing, setEditing] = useState<{
		taskId: string;
		col: string;
	} | null>(null);
	const [adding, setAdding] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const lastClicked = useRef<number | null>(null);
	const gridRef = useRef<HTMLTableElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const colCount = columns.length + 1;

	const virtual = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW,
		overscan: 12,
	});

	const clampFocus = useCallback(
		(f: Focus): Focus => ({
			row: Math.max(0, Math.min(rows.length - 1, f.row)),
			col: Math.max(0, Math.min(colCount - 1, f.col)),
		}),
		[rows.length, colCount],
	);

	const focusCell = useCallback(
		(f: Focus) => {
			const next = clampFocus(f);
			setFocus(next);
			virtual.scrollToIndex(next.row, { align: "auto" });
			requestAnimationFrame(() =>
				gridRef.current
					?.querySelector<HTMLElement>(
						`[data-cell="${next.row}:${rows[next.row]?.kind === "task" ? next.col : 0}"]`,
					)
					?.focus(),
			);
		},
		[clampFocus, virtual, rows],
	);

	// Infinite scroll.
	const items = virtual.getVirtualItems();
	const lastIndex = items[items.length - 1]?.index ?? 0;
	useEffect(() => {
		if (
			lastIndex >= rows.length - 10 &&
			tasks.hasNextPage &&
			!tasks.isFetchingNextPage
		)
			tasks.fetchNextPage();
	}, [lastIndex, rows.length, tasks]);

	// "c" (ViewHost) and the toolbar's "+ Task": quick add in the focused row's group.
	useEffect(() => {
		const onAdd = () => {
			const r = rows[focus.row];
			const group =
				r && r.kind !== "group"
					? r.group
					: (groups[0] as TaskGroup | undefined);
			if (!group) return;
			if (collapsed.has(group.key))
				onConfigChange({
					collapsedGroups: config.collapsedGroups.filter(
						(k) => k !== group.key,
					),
				});
			setAdding(group.key);
			const at = rows.findIndex(
				(x) => x.kind === "add" && x.group.key === group.key,
			);
			if (at >= 0) virtual.scrollToIndex(at, { align: "auto" });
		};
		window.addEventListener("work:quick-add", onAdd);
		return () => window.removeEventListener("work:quick-add", onAdd);
	});

	const toggleSelect = (
		task: WorkTaskListItem,
		rowIndex: number,
		range: boolean,
	) => {
		setSelected((sel) => {
			if (range && lastClicked.current !== null) {
				const [a, b] = [lastClicked.current, rowIndex].sort(
					(x, y) => x - y,
				) as [number, number];
				const ids = rows
					.slice(a, b + 1)
					.flatMap((r) => (r.kind === "task" ? [r.task.id] : []));
				return [...new Set([...sel, ...ids])];
			}
			return sel.includes(task.id)
				? sel.filter((i) => i !== task.id)
				: [...sel, task.id];
		});
		lastClicked.current = rowIndex;
	};

	const startEdit = (task: WorkTaskListItem, col: Column) => {
		if (!project.canEdit || !isEditable(col)) return;
		if (col.field?.kind === "checkbox") {
			void edits.setField(
				task,
				col.field.id,
				task.fields?.[col.field.id] === true ? null : true,
			);
			return;
		}
		setEditing({ taskId: task.id, col: col.key });
	};

	const stopEdit = (next?: boolean) => {
		setEditing(null);
		focusCell(next ? { row: focus.row, col: focus.col + 1 } : focus);
	};

	/** ⌘↑/⌘↓: manual order only, next to the neighbour in the same group and level. */
	const moveTask = (dir: -1 | 1) => {
		const r = rows[focus.row];
		if (r?.kind !== "task" || !project.canEdit) return;
		if (config.sort.length) {
			toast("Clear the sort to reorder by hand", {
				description: "Moving a task only changes the manual order.",
			});
			return;
		}
		let i = focus.row + dir;
		while (
			rows[i] &&
			!(
				rows[i]?.kind === "task" &&
				(rows[i] as { depth: number }).depth === r.depth
			)
		)
			i += dir;
		const other = rows[i];
		if (other?.kind !== "task" || other.group.key !== r.group.key) return;
		void edits.move(
			r.task,
			dir < 0 ? { before: other.task.id } : { after: other.task.id },
		);
		setFocus({ row: i, col: focus.col });
	};

	const quickEdit = (colKey: string) => {
		const r = rows[focus.row];
		const ci = columns.findIndex((c) => c.key === colKey);
		const col = columns[ci];
		if (r?.kind !== "task" || !col) return;
		setFocus({ row: focus.row, col: ci + 1 });
		startEdit(r.task, col);
	};

	const onGridKey = (e: KeyboardEvent) => {
		if (editing || adding) return;
		const target = e.target as HTMLElement;
		if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
		const r = rows[focus.row];
		const mod = e.metaKey || e.ctrlKey;
		const key = e.key;
		const handled = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		if ((key === "ArrowUp" || key === "ArrowDown") && mod) {
			handled();
			moveTask(key === "ArrowUp" ? -1 : 1);
			return;
		}
		switch (key) {
			case "ArrowDown":
			case "j":
				handled();
				focusCell({ ...focus, row: focus.row + 1 });
				return;
			case "ArrowUp":
			case "k":
				handled();
				focusCell({ ...focus, row: focus.row - 1 });
				return;
			case "ArrowRight":
				handled();
				focusCell({ ...focus, col: focus.col + 1 });
				return;
			case "ArrowLeft":
				handled();
				focusCell({ ...focus, col: focus.col - 1 });
				return;
			case "Home":
				handled();
				focusCell({ row: mod ? 0 : focus.row, col: 0 });
				return;
			case "End":
				handled();
				focusCell({
					row: mod ? rows.length - 1 : focus.row,
					col: colCount - 1,
				});
				return;
			case "PageDown":
			case "PageUp":
				handled();
				focusCell({
					...focus,
					row: focus.row + (key === "PageDown" ? 15 : -15),
				});
				return;
			case "Escape":
				if (selected.length) {
					handled();
					setSelected([]);
				}
				return;
		}
		if (!r) return;
		if (r.kind === "group") {
			if (key === "Enter" || key === " ") {
				handled();
				toggleGroup(r.group.key);
			}
			return;
		}
		if (r.kind === "add") {
			if (key === "Enter") {
				handled();
				setAdding(r.group.key);
			}
			return;
		}
		const col = focus.col === 0 ? undefined : columns[focus.col - 1];
		if (key === "Enter") {
			handled();
			if (!col || col.key === "title" || col.key === "key" || !isEditable(col))
				onOpenTask(r.task.id);
			else startEdit(r.task, col);
		} else if (key === "e" || key === "F2") {
			if (col) {
				handled();
				startEdit(r.task, col);
			}
		} else if (key === "x" || (key === " " && focus.col === 0)) {
			handled();
			toggleSelect(r.task, focus.row, e.shiftKey);
		} else if (!mod && !e.altKey) {
			const quick: Record<string, string> = {
				s: "status",
				a: "assignees",
				d: "dueDate",
				p: "priority",
				l: "tags",
			};
			const target = quick[key];
			if (target && columns.some((c) => c.key === target)) {
				handled();
				quickEdit(target);
			}
		}
	};

	const toggleGroup = (key: string) =>
		onConfigChange({
			collapsedGroups: collapsed.has(key)
				? config.collapsedGroups.filter((k) => k !== key)
				: [...config.collapsedGroups, key],
		});

	// --- columns: resize and reorder -----------------------------------------
	const setColumns = (cols: Column[]) =>
		onConfigChange({ columns: toConfigColumns(cols) });
	const moveColumn = (key: string, to: number) => {
		const from = allColumns.findIndex((c) => c.key === key);
		if (from < 0 || to < 0 || to >= allColumns.length) return;
		const next = [...allColumns];
		const [c] = next.splice(from, 1);
		if (c) next.splice(to, 0, c);
		setColumns(next);
	};
	const startResize = (col: Column, e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startW = col.width;
		let w = startW;
		const onMove = (ev: PointerEvent) => {
			w = Math.max(60, Math.min(800, startW + ev.clientX - startX));
			setWidths((x) => ({ ...x, [col.key]: w }));
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setColumns(
				allColumns.map((c) =>
					c.key === col.key ? { ...c, width: Math.round(w) } : c,
				),
			);
			setWidths((x) => {
				const { [col.key]: _, ...rest } = x;
				return rest;
			});
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};
	const [dragCol, setDragCol] = useState<string | null>(null);

	// Leading columns up to the title stay put while scrolling sideways.
	const titleAt = columns.findIndex((c) => c.key === "title");
	const stickyLeft = (i: number) =>
		i <= titleAt
			? SELECT_W + columns.slice(0, i).reduce((s, c) => s + c.width, 0)
			: undefined;
	const template = `${SELECT_W}px ${columns.map((c) => `${c.width}px`).join(" ")} minmax(0,1fr)`;
	const totalWidth = SELECT_W + columns.reduce((s, c) => s + c.width, 0);

	// --- render ----------------------------------------------------------------
	if (!tasks.isLoading && tasks.items.length === 0 && !project.canEdit)
		return (
			<EmptyState
				icon={SearchX}
				title="No tasks match these filters"
				description="Try fewer filters, or show closed tasks from the view options."
			/>
		);
	if (tasks.isLoading)
		return (
			<div className="grid h-64 place-items-center">
				<Spinner />
			</div>
		);

	const selectedTasks = selected;
	const allTaskIds = rows.flatMap((r) =>
		r.kind === "task" ? [r.task.id] : [],
	);
	const allSelected =
		allTaskIds.length > 0 && allTaskIds.every((id) => selected.includes(id));

	return (
		<>
			{tasks.items.length === 0 && (
				<EmptyState
					className="mb-4 py-10"
					icon={SearchX}
					title="No tasks match these filters"
					description="Clear the filters or the search, or add the first task below."
				/>
			)}
			<div
				ref={scrollRef}
				className="relative max-h-[calc(100dvh-15rem)] min-h-48 overflow-auto rounded-xl bg-card shadow-card ring-1 ring-border"
			>
				<table
					ref={gridRef}
					// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an editable table is the WAI-ARIA grid pattern.
					role="grid"
					aria-label="Tasks"
					aria-rowcount={rows.length + 1}
					aria-colcount={colCount}
					aria-multiselectable
					onKeyDown={onGridKey}
					className="block text-sm"
					style={{ minWidth: totalWidth }}
				>
					{/* Header */}
					<thead className="sticky top-0 z-20 block">
						<tr
							aria-rowindex={1}
							className="grid h-9 border-b bg-card/95 backdrop-blur-sm supports-[backdrop-filter]:bg-card/85"
							style={{ gridTemplateColumns: template }}
						>
							<th className="sticky left-0 z-10 grid place-items-center bg-inherit">
								<Checkbox
									aria-label={allSelected ? "Deselect all" : "Select all"}
									checked={
										allSelected
											? true
											: selected.length
												? "indeterminate"
												: false
									}
									onCheckedChange={() =>
										setSelected(allSelected ? [] : allTaskIds)
									}
								/>
							</th>
							{columns.map((col, i) => (
								<th
									key={col.key}
									draggable
									onDragStart={(e) => {
										setDragCol(col.key);
										e.dataTransfer.effectAllowed = "move";
									}}
									onDragOver={(e) =>
										dragCol && dragCol !== col.key && e.preventDefault()
									}
									onDrop={() => {
										if (dragCol)
											moveColumn(
												dragCol,
												allColumns.findIndex((c) => c.key === col.key),
											);
										setDragCol(null);
									}}
									onDragEnd={() => setDragCol(null)}
									className={cn(
										"group/th relative flex min-w-0 items-center gap-1 bg-inherit px-2.5 text-xs font-medium text-muted-foreground select-none",
										stickyLeft(i) !== undefined && "sticky z-10",
										i === titleAt && "shadow-[1px_0_0_var(--border)]",
										dragCol === col.key && "opacity-50",
									)}
									style={{ left: stickyLeft(i) }}
								>
									<span className="truncate">{col.label}</span>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<button
												type="button"
												aria-label={`${col.label} column options`}
												className="ml-auto grid size-5 shrink-0 place-items-center rounded-sm opacity-0 hover:bg-muted focus-visible:opacity-100 group-hover/th:opacity-100 data-[state=open]:opacity-100"
											>
												<MoreHorizontal className="size-3.5" />
											</button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="start" className="w-44">
											<DropdownMenuItem
												onSelect={() =>
													onConfigChange({
														sort: [{ by: sortKeyOf(col), dir: "asc" }],
													})
												}
											>
												<ArrowUp /> Sort ascending
											</DropdownMenuItem>
											<DropdownMenuItem
												onSelect={() =>
													onConfigChange({
														sort: [{ by: sortKeyOf(col), dir: "desc" }],
													})
												}
											>
												<ArrowDown /> Sort descending
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												disabled={allColumns[0]?.key === col.key}
												onSelect={() =>
													moveColumn(
														col.key,
														allColumns.findIndex((c) => c.key === col.key) - 1,
													)
												}
											>
												<ArrowLeft /> Move left
											</DropdownMenuItem>
											<DropdownMenuItem
												onSelect={() =>
													moveColumn(
														col.key,
														allColumns.findIndex((c) => c.key === col.key) + 1,
													)
												}
											>
												<ArrowRight /> Move right
											</DropdownMenuItem>
											{col.key !== "title" && col.key !== "key" && (
												<DropdownMenuItem
													onSelect={() =>
														setColumns(
															allColumns.map((c) =>
																c.key === col.key ? { ...c, hidden: true } : c,
															),
														)
													}
												>
													<EyeOff /> Hide column
												</DropdownMenuItem>
											)}
										</DropdownMenuContent>
									</DropdownMenu>
									<span
										aria-hidden
										onPointerDown={(e) => startResize(col, e)}
										className="absolute top-1.5 -right-px bottom-1.5 w-1 cursor-col-resize rounded-full transition-colors hover:bg-brand/60 active:bg-brand"
									/>
								</th>
							))}
							<th aria-hidden />
						</tr>
					</thead>

					{/* Body */}
					<tbody
						className="relative block"
						style={{ height: virtual.getTotalSize() }}
					>
						{items.map((vi) => {
							const r = rows[vi.index];
							if (!r) return null;
							const rowIndex = vi.index;
							const base = {
								role: "row",
								"aria-rowindex": rowIndex + 2,
								className: "absolute inset-x-0 grid",
								style: {
									top: 0,
									height: ROW,
									transform: `translateY(${vi.start}px)`,
									gridTemplateColumns: template,
								},
							} as const;

							if (r.kind === "group")
								return (
									<tr
										key={`g-${r.group.key}`}
										{...base}
										className={cn(base.className, "border-b bg-muted/40")}
									>
										<td
											// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: grid pattern, cells take focus.
											role="gridcell"
											aria-colspan={colCount}
											data-cell={`${rowIndex}:0`}
											tabIndex={focus.row === rowIndex ? 0 : -1}
											onFocus={() => setFocus({ row: rowIndex, col: 0 })}
											onClick={() => toggleGroup(r.group.key)}
											onKeyDown={() => {}}
											aria-expanded={!r.collapsed}
											className="sticky left-0 col-span-full flex w-max cursor-pointer items-center gap-2 px-2 text-xs font-medium outline-none focus-visible:bg-muted"
										>
											<ChevronRight
												aria-hidden
												className={cn(
													"size-3.5 text-muted-foreground transition-transform duration-(--duration-quick)",
													!r.collapsed && "rotate-90",
												)}
											/>
											<GroupIcon group={r.group} project={project} />
											<span>{r.group.label}</span>
											<span className="text-muted-foreground tabular">
												{r.group.tasks.length}
											</span>
										</td>
									</tr>
								);

							if (r.kind === "add")
								return (
									<tr
										key={`a-${r.group.key}`}
										{...base}
										className={cn(base.className, "border-b")}
									>
										<td
											// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: grid pattern, cells take focus.
											role="gridcell"
											aria-colspan={colCount}
											data-cell={`${rowIndex}:0`}
											tabIndex={focus.row === rowIndex ? 0 : -1}
											onFocus={() => setFocus({ row: rowIndex, col: 0 })}
											className="sticky left-0 col-span-full flex items-center outline-none focus-visible:bg-muted/60"
											style={{ width: Math.min(totalWidth, 720) }}
										>
											{adding === r.group.key ? (
												<QuickAdd
													onCancel={() => {
														setAdding(null);
														focusCell({ row: rowIndex, col: 0 });
													}}
													onCreate={async (title) => {
														try {
															await onCreateTask({
																title,
																...r.group.defaults,
															});
														} catch (e) {
															toast.error("The task wasn't created", {
																description:
																	e instanceof Error ? e.message : undefined,
															});
															throw e;
														}
													}}
												/>
											) : (
												<button
													type="button"
													tabIndex={-1}
													onClick={() => setAdding(r.group.key)}
													className="flex h-full items-center gap-2 pl-[2.6rem] text-muted-foreground hover:text-foreground"
												>
													<Plus className="size-3.5" aria-hidden />
													Add task
												</button>
											)}
										</td>
									</tr>
								);

							const { task } = r;
							const isSelected = selected.includes(task.id);
							return (
								<tr
									key={task.id}
									{...base}
									aria-selected={isSelected}
									className={cn(
										base.className,
										"group/row border-b transition-colors duration-(--duration-quick)",
										isSelected ? "bg-brand/6" : "bg-card hover:bg-muted/40",
									)}
								>
									<td
										// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: grid pattern, cells take focus.
										role="gridcell"
										data-cell={`${rowIndex}:0`}
										tabIndex={
											focus.row === rowIndex && focus.col === 0 ? 0 : -1
										}
										onFocus={() => setFocus({ row: rowIndex, col: 0 })}
										className="sticky left-0 z-10 grid place-items-center bg-inherit outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
									>
										<Checkbox
											tabIndex={-1}
											aria-label={`Select ${task.key}`}
											checked={isSelected}
											onClick={(e) => {
												e.preventDefault();
												toggleSelect(task, rowIndex, e.shiftKey);
											}}
											className={cn(
												!isSelected &&
													!selected.length &&
													"opacity-0 group-hover/row:opacity-100",
											)}
										/>
									</td>
									{columns.map((col, i) => {
										const ci = i + 1;
										const isFocused =
											focus.row === rowIndex && focus.col === ci;
										const isEditing =
											editing?.taskId === task.id && editing.col === col.key;
										return (
											// biome-ignore lint/a11y/useKeyWithClickEvents: the grid's onKeyDown handles Enter and the edit keys for every cell.
											<td
												key={col.key}
												// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: grid pattern, cells take focus.
												role="gridcell"
												data-cell={`${rowIndex}:${ci}`}
												tabIndex={isFocused ? 0 : -1}
												aria-readonly={!isEditable(col) || undefined}
												onFocus={() => setFocus({ row: rowIndex, col: ci })}
												onClick={() => {
													setFocus({ row: rowIndex, col: ci });
													if (
														col.key === "title" ||
														col.key === "key" ||
														!isEditable(col) ||
														!project.canEdit
													)
														onOpenTask(task.id);
													else startEdit(task, col);
												}}
												onDoubleClick={() =>
													col.key === "title" && startEdit(task, col)
												}
												className={cn(
													"flex min-w-0 cursor-default items-center bg-inherit px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
													stickyLeft(i) !== undefined && "sticky z-10",
													i === titleAt &&
														"cursor-pointer shadow-[1px_0_0_var(--border)]",
													isEditing && "ring-2 ring-ring ring-inset",
												)}
												style={{
													left: stickyLeft(i),
													paddingLeft:
														col.key === "title" && r.depth ? 20 : undefined,
												}}
											>
												<TableCell
													col={col}
													task={task}
													project={project}
													edits={edits}
													editing={isEditing}
													onStopEdit={stopEdit}
													me={me?.userId}
													nested={
														col.key === "title"
															? {
																	depth: r.depth,
																	expandable: r.expandable,
																	expanded: r.expanded,
																	onToggle: () =>
																		setExpanded((s) => {
																			const n = new Set(s);
																			if (n.has(task.id)) n.delete(task.id);
																			else n.add(task.id);
																			return n;
																		}),
																}
															: undefined
													}
												/>
											</td>
										);
									})}
									<td aria-hidden />
								</tr>
							);
						})}
					</tbody>
				</table>
				{tasks.isFetchingNextPage && (
					<div className="flex justify-center py-3">
						<Spinner />
					</div>
				)}
			</div>
			<p className="mt-2 text-xs text-muted-foreground tabular">
				{tasks.total ?? tasks.items.length}{" "}
				{(tasks.total ?? tasks.items.length) === 1 ? "task" : "tasks"}
				{selectedTasks.length > 0 && ` · ${selectedTasks.length} selected`}
			</p>
			<BulkBar
				project={project}
				selected={selected}
				onClear={() => setSelected([])}
			/>
		</>
	);
}

/** The sort key a column sorts by. */
function sortKeyOf(col: Column) {
	const map: Record<string, string> = {
		key: "number",
		assignees: "title",
		tags: "title",
		list: "title",
		tracked: "estimate",
	};
	return (map[col.key] ?? col.key) as "number";
}

function GroupIcon({
	group,
	project,
}: {
	group: TaskGroup;
	project: ViewProps["project"];
}) {
	if (group.statusId)
		return (
			<StatusIcon
				status={project.statuses.find((s) => s.id === group.statusId)}
			/>
		);
	if (group.personId)
		return (
			<PersonAvatar
				person={project.people.find((p) => p.userId === group.personId)}
				className="size-4"
			/>
		);
	if (group.color) return <ColorDot color={group.color} />;
	return null;
}

function QuickAdd({
	onCreate,
	onCancel,
}: {
	onCreate: (title: string) => Promise<void>;
	onCancel: () => void;
}) {
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<form
			className="flex w-full items-center gap-2 pr-2 pl-9"
			onSubmit={async (e) => {
				e.preventDefault();
				const t = title.trim();
				if (!t) return;
				setBusy(true);
				try {
					await onCreate(t);
					setTitle("");
				} finally {
					setBusy(false);
				}
			}}
		>
			<Input
				autoFocus
				value={title}
				disabled={busy}
				aria-label="New task title"
				placeholder="Task title, then Enter. Esc to stop."
				onChange={(e) => setTitle(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Escape") onCancel();
				}}
				onBlur={() => !title.trim() && onCancel()}
				className="h-7 rounded-sm text-sm"
			/>
		</form>
	);
}
