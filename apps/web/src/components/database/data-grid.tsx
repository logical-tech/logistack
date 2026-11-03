import {
	type Cell,
	type DbColumn,
	type DbTable,
	type RowFilter,
	type RowSort,
	rowFilterOps,
} from "@logistack/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ArrowDown,
	ArrowUp,
	KeyRound,
	ListFilter,
	Loader2,
	Lock,
	Plus,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import {
	type CSSProperties,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { reasonOf, rowsQuery, useWriteRows } from "@/lib/api/database";
import { cn } from "@/lib/utils";
import { CellEditor } from "./cell-editor";
import {
	cellText,
	EMPTY_STAGED,
	isNumeric,
	keyOf,
	nextSort,
	rowKey,
	type Staged,
	shortType,
	stageEdit,
	toOps,
	type Values,
} from "./cells";
import { KIND } from "./schema-tree";

const ROW = 36;
const SELECT_W = 40;

const OPS: Record<RowFilter["op"], string> = {
	eq: "=",
	neq: "≠",
	lt: "<",
	gt: ">",
	lte: "≤",
	gte: "≥",
	contains: "contains",
	starts_with: "starts with",
	is_null: "is null",
	not_null: "is not null",
};
const unary = (op: RowFilter["op"]) => op === "is_null" || op === "not_null";

// Opaque tints, so sticky cells that inherit them still cover what scrolls beneath.
const mix = (token: string, pct: number) =>
	`color-mix(in oklab, var(--card), var(${token}) ${pct}%)`;
const TINT = {
	row: "bg-card hover:bg-[color-mix(in_oklab,var(--card),var(--foreground)_3%)]",
	selected: "bg-[color-mix(in_oklab,var(--card),var(--brand)_9%)]",
	new: "bg-[color-mix(in_oklab,var(--card),var(--ok)_9%)]",
	deleted:
		"bg-[color-mix(in_oklab,var(--card),var(--bad)_9%)] text-muted-foreground line-through decoration-bad-text/50",
};

export function widthOf(c: { name: string; type: string }) {
	const t = c.type;
	const w = /^bool/.test(t)
		? 100
		: /^(smallint|integer|bigint|real|double|numeric|oid|date|int[248]|float[48])/.test(
					t,
				)
			? 130
			: /^timestamp/.test(t)
				? 230
				: /^uuid/.test(t)
					? 310
					: /^jsonb?$/.test(t)
						? 300
						: 210;
	return Math.max(w, c.name.length * 8 + shortType(t).length * 6 + 56);
}

type GridRow =
	| { id: string; kind: "new"; values: Values }
	| { id: string; kind: "row"; cells: Cell[]; key: Values };

export function CellView({
	value,
	column,
}: {
	value: Cell | undefined;
	column: { type: string };
}) {
	if (value === undefined)
		return <span className="text-muted-foreground/70 italic">default</span>;
	if (value === null)
		return <span className="text-muted-foreground/70 italic">null</span>;
	const mono =
		(typeof value === "object" &&
			(value.type === "json" || value.type === "bytea")) ||
		column.type === "uuid";
	return (
		<span
			className={cn(
				"block truncate",
				mono && "font-mono text-[13px]",
				typeof value === "object" &&
					value.type === "bytea" &&
					"text-muted-foreground",
			)}
		>
			{cellText(value)}
		</span>
	);
}

function FilterAdd({
	columns,
	onAdd,
}: {
	columns: DbColumn[];
	onAdd: (f: RowFilter) => void;
}) {
	const [open, setOpen] = useState(false);
	const [column, setColumn] = useState(columns[0]?.name ?? "");
	const [op, setOp] = useState<RowFilter["op"]>("eq");
	const [value, setValue] = useState("");
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button size="sm" variant="outline">
					<ListFilter data-icon="inline-start" />
					Filter
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80">
				<form
					className="grid gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						onAdd(unary(op) ? { column, op } : { column, op, value });
						setValue("");
						setOpen(false);
					}}
				>
					<div className="grid grid-cols-[1fr_auto] gap-2">
						<Select value={column} onValueChange={setColumn}>
							<SelectTrigger className="w-full min-w-0" aria-label="Column">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{columns.map((c) => (
									<SelectItem key={c.name} value={c.name}>
										{c.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select
							value={op}
							onValueChange={(v) => setOp(v as RowFilter["op"])}
						>
							<SelectTrigger aria-label="Operator">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{rowFilterOps.map((o) => (
									<SelectItem key={o} value={o}>
										{OPS[o]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{!unary(op) && (
						<Input
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder="Value"
							aria-label="Value"
						/>
					)}
					<Button type="submit" size="sm" className="justify-self-end">
						Add filter
					</Button>
				</form>
			</PopoverContent>
		</Popover>
	);
}

/** One table's rows: virtualized, paged as you scroll, edited in place and saved as one batch. */
export function DataGrid({
	serviceId,
	schema,
	table,
	sort,
	filter,
	onSort,
	onFilter,
	staged,
	onStage,
	forbidden,
	onForbidden,
}: {
	serviceId: string;
	schema: string;
	table: DbTable;
	sort: RowSort[];
	filter: RowFilter[];
	onSort: (sort: RowSort[]) => void;
	onFilter: (filter: RowFilter[]) => void;
	staged: Staged;
	onStage: (next: Staged) => void;
	forbidden: boolean;
	onForbidden: () => void;
}) {
	const ref = { schema, table: table.name };
	const rows = useInfiniteQuery(rowsQuery(serviceId, ref, { sort, filter }));
	const write = useWriteRows(serviceId, ref);
	const scroller = useRef<HTMLDivElement>(null);
	const gridEl = useRef<HTMLTableElement>(null);
	const [active, setActive] = useState<{ r: number; c: number } | null>(null);
	const [editing, setEditing] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [confirming, setConfirming] = useState(false);
	const [saveError, setSaveError] = useState<{
		stale: boolean;
		text: string;
	} | null>(null);

	const first = rows.data?.pages[0];
	const pageColumns = first?.columns ?? table.columns;
	// Primary key first, so it can stay pinned while the rest scrolls.
	const columns = [
		...pageColumns.filter((c) => c.primaryKey),
		...pageColumns.filter((c) => !c.primaryKey),
	];
	const source = columns.map((c) => pageColumns.indexOf(c));
	const keyed = first?.editable ?? table.editable;
	const reason =
		table.kind !== "table"
			? `${KIND[table.kind].label}s are read-only. Edit the tables they read from.`
			: !keyed
				? "Read-only: without a primary key a row can't be addressed on its own."
				: forbidden
					? "Read-only: your role can view this database but not change it."
					: null;
	const writable = reason === null;

	const loaded = (rows.data?.pages ?? []).flatMap((p) => p.rows);
	const grid: GridRow[] = [
		...staged.inserts.map(
			(r): GridRow => ({ id: r.id, kind: "new", values: r.values }),
		),
		...loaded.map((cells, i): GridRow => {
			const key = keyed ? keyOf(pageColumns, cells) : {};
			return { id: keyed ? rowKey(key) : `#${i}`, kind: "row", cells, key };
		}),
	];
	const valueAt = (row: GridRow, c: number): Cell | undefined => {
		const column = columns[c] as DbColumn;
		if (row.kind === "new") return row.values[column.name];
		const edit = staged.edits[row.id]?.values;
		return edit && column.name in edit
			? edit[column.name]
			: (row.cells[source[c] as number] ?? null);
	};
	const ops = toOps(staged);

	const widths = columns.map(widthOf);
	const lead = writable ? SELECT_W : 0;
	const template = `${writable ? `${SELECT_W}px ` : ""}${widths.map((w) => `${w}px`).join(" ")}`;
	const total = lead + widths.reduce((a, b) => a + b, 0);
	const pinned = columns.filter((c) => c.primaryKey).length;
	const lefts = widths.map(
		(_, i) => lead + widths.slice(0, i).reduce((a, b) => a + b, 0),
	);
	const pinStyle = (c: number): CSSProperties | undefined =>
		c < pinned ? { position: "sticky", left: lefts[c] } : undefined;

	const virtual = useVirtualizer({
		count: grid.length,
		getScrollElement: () => scroller.current,
		estimateSize: () => ROW,
		overscan: 12,
	});
	const items = virtual.getVirtualItems();
	const last = items.at(-1)?.index ?? 0;
	useEffect(() => {
		if (
			last >= grid.length - 40 &&
			rows.hasNextPage &&
			!rows.isFetchingNextPage
		)
			rows.fetchNextPage();
	}, [last, grid.length, rows]);

	const view = JSON.stringify([sort, filter]);
	// A new sort or filter is a new list: start it from the top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on view change only
	useEffect(() => {
		scroller.current?.scrollTo({ top: 0 });
		setActive(null);
	}, [view]);

	const stage = (next: Staged) => {
		setSaveError(null);
		onStage(next);
	};
	const cellId = (r: number, c: number) => `dbgrid-${r}-${c}`;
	const go = (r: number, c: number) => {
		const to = {
			r: Math.max(0, Math.min(grid.length - 1, r)),
			c: Math.max(0, Math.min(columns.length - 1, c)),
		};
		setActive(to);
		virtual.scrollToIndex(to.r, { align: "auto" });
		requestAnimationFrame(() =>
			document
				.getElementById(cellId(to.r, to.c))
				?.scrollIntoView({ block: "nearest", inline: "nearest" }),
		);
	};
	const canEdit = (r: number) => {
		const row = grid[r];
		return writable && !!row && !(row.id in staged.deletes);
	};

	const commit = (r: number, c: number, value: Cell, next?: boolean) => {
		setEditing(false);
		gridEl.current?.focus({ preventScroll: true });
		const row = grid[r];
		const column = columns[c] as DbColumn;
		if (!row) return;
		if (row.kind === "new")
			stage({
				...staged,
				inserts: staged.inserts.map((x) =>
					x.id === row.id
						? { ...x, values: { ...x.values, [column.name]: value } }
						: x,
				),
			});
		else
			stage(
				stageEdit(
					staged,
					row.key,
					column.name,
					value,
					row.cells[source[c] as number] ?? null,
				),
			);
		if (next) go(r, c + 1);
	};

	const toggleRow = (id: string, on: boolean) =>
		setSelected((s) => {
			const n = new Set(s);
			if (on) n.add(id);
			else n.delete(id);
			return n;
		});
	const marked = [...selected];
	const restoring =
		marked.length > 0 &&
		marked.every(
			(id) => id in staged.deletes || !grid.some((g) => g.id === id),
		);
	const deleteSelected = () => {
		const deletes = { ...staged.deletes };
		for (const id of marked) {
			const row = grid.find((g) => g.id === id);
			if (row?.kind === "row") {
				if (restoring) delete deletes[id];
				else deletes[id] = row.key;
			}
		}
		stage({
			...staged,
			deletes,
			inserts: staged.inserts.filter((x) => !selected.has(x.id)),
		});
		setSelected(new Set());
	};

	const onKey = (e: KeyboardEvent) => {
		if (editing || !grid.length) return;
		const a = active ?? { r: 0, c: 0 };
		const page = Math.max(
			1,
			Math.floor((scroller.current?.clientHeight ?? 400) / ROW) - 2,
		);
		const mod = e.metaKey || e.ctrlKey;
		const id = grid[a.r]?.id;
		switch (e.key) {
			case "ArrowDown":
				go(a.r + 1, a.c);
				break;
			case "ArrowUp":
				go(a.r - 1, a.c);
				break;
			case "ArrowRight":
				go(a.r, a.c + 1);
				break;
			case "ArrowLeft":
				go(a.r, a.c - 1);
				break;
			case "PageDown":
				go(a.r + page, a.c);
				break;
			case "PageUp":
				go(a.r - page, a.c);
				break;
			case "Home":
				go(mod ? 0 : a.r, 0);
				break;
			case "End":
				go(mod ? grid.length - 1 : a.r, columns.length - 1);
				break;
			case "Enter":
			case "F2":
				if (active && canEdit(a.r)) setEditing(true);
				break;
			case " ":
				if (writable && id) toggleRow(id, !selected.has(id));
				break;
			case "Escape":
				if (selected.size) setSelected(new Set());
				else setActive(null);
				break;
			default:
				return;
		}
		e.preventDefault();
	};

	const save = () =>
		write.mutate(ops, {
			onSuccess: () => {
				toast.success(
					`Saved ${ops.length} ${ops.length === 1 ? "change" : "changes"}`,
				);
				stage(EMPTY_STAGED);
				setSelected(new Set());
				setConfirming(false);
			},
			onError: (e) => {
				setConfirming(false);
				if (e instanceof ApiError && e.status === 403) {
					onForbidden();
					setSaveError({
						stale: false,
						text: "Your role can view this database but not change it. Nothing was saved.",
					});
				} else if (reasonOf(e) === "stale")
					setSaveError({
						stale: true,
						text: "Someone changed or deleted one of these rows since you loaded them, so nothing was saved. Reload the rows to see what changed; your edits stay staged.",
					});
				else
					setSaveError({
						stale: false,
						text: `Nothing was saved: ${e.message}`,
					});
			},
		});
	const deletes = ops.filter((o) => o.op === "delete").length;

	const sortOf = (name: string) => {
		const i = sort.findIndex((s) => s.column === name);
		return i < 0
			? null
			: { desc: sort[i]?.desc, n: sort.length > 1 ? i + 1 : null };
	};
	const estimate = table.rows;
	const editingAt = editing && active ? active : null;

	return (
		<>
			<div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 sm:px-4">
				{selected.size > 0 ? (
					<div className="t-swap flex min-w-0 flex-1 items-center gap-2">
						<span className="text-sm font-medium tabular" aria-live="polite">
							{selected.size} selected
						</span>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setSelected(new Set())}
						>
							Clear
						</Button>
					</div>
				) : (
					<div className="flex min-w-0 flex-1 items-baseline gap-2">
						<h3 className="min-w-0 truncate font-mono text-[13px] font-medium">
							<span className="text-muted-foreground">{schema}.</span>
							{table.name}
						</h3>
						{reason ? (
							<span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
								<Lock className="size-3 shrink-0 self-center" aria-hidden />
								<span className="truncate" title={reason}>
									{reason}
								</span>
							</span>
						) : (
							estimate !== null && (
								<span className="shrink-0 text-xs text-muted-foreground tabular">
									~{estimate.toLocaleString("en")} rows
								</span>
							)
						)}
					</div>
				)}
				{selected.size > 0 ? (
					<Button
						size="sm"
						variant={restoring ? "outline" : "destructive"}
						onClick={deleteSelected}
					>
						{restoring ? (
							<RotateCcw data-icon="inline-start" />
						) : (
							<Trash2 data-icon="inline-start" />
						)}
						{restoring ? "Restore" : "Delete"} {selected.size}
					</Button>
				) : (
					<>
						<FilterAdd
							columns={pageColumns}
							onAdd={(f) => onFilter([...filter, f])}
						/>
						{writable && (
							<Button
								size="sm"
								onClick={() => {
									stage({
										...staged,
										inserts: [
											{ id: crypto.randomUUID(), values: {} },
											...staged.inserts,
										],
									});
									go(0, 0);
									gridEl.current?.focus({ preventScroll: true });
								}}
							>
								<Plus data-icon="inline-start" />
								Add row
							</Button>
						)}
					</>
				)}
			</div>

			{filter.length > 0 && (
				<ul
					aria-label="Filters"
					className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2 sm:px-4"
				>
					{filter.map((f, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: the same filter may repeat
							key={i}
							className="t-reveal flex h-7 items-center gap-1.5 rounded-md bg-muted pr-1 pl-2.5 text-xs"
						>
							<span className="font-medium">{f.column}</span>
							<span className="text-muted-foreground">{OPS[f.op]}</span>
							{!unary(f.op) && (
								<span className="max-w-40 truncate font-mono">
									{f.value || "''"}
								</span>
							)}
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={`Remove filter on ${f.column}`}
								onClick={() => onFilter(filter.filter((_, j) => j !== i))}
							>
								<X />
							</Button>
						</li>
					))}
					<li>
						<Button size="xs" variant="ghost" onClick={() => onFilter([])}>
							Clear filters
						</Button>
					</li>
				</ul>
			)}

			{rows.isPending ? (
				<SkeletonRows rows={8} />
			) : rows.isError ? (
				<p
					role="alert"
					className="px-4 py-10 text-center text-sm text-bad-text"
				>
					{rows.error.message}
				</p>
			) : (
				<div
					ref={scroller}
					// The table is the tab stop; Chrome would make the scroller one too.
					tabIndex={-1}
					className="relative min-h-0 flex-1 overflow-auto outline-none"
					style={{
						scrollPaddingTop: ROW,
						scrollPaddingLeft: lefts[pinned] ?? lead,
					}}
				>
					<table
						ref={gridEl}
						// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an editable table is the WAI-ARIA grid pattern
						role="grid"
						tabIndex={0}
						aria-label={`${schema}.${table.name}`}
						aria-rowcount={grid.length + 1}
						aria-colcount={columns.length}
						aria-readonly={!writable}
						aria-multiselectable={writable || undefined}
						aria-activedescendant={
							active ? cellId(active.r, active.c) : undefined
						}
						onKeyDown={onKey}
						aria-busy={rows.isPlaceholderData || undefined}
						className={cn(
							"group/grid grid text-sm outline-none transition-opacity duration-(--duration-quick)",
							rows.isPlaceholderData && "opacity-60",
						)}
						style={{ width: total, minWidth: "100%" }}
					>
						<thead className="sticky top-0 z-20 grid">
							<tr
								aria-rowindex={1}
								className="grid border-b bg-card"
								style={{
									gridTemplateColumns: template,
									width: total,
									minWidth: "100%",
								}}
							>
								{writable && (
									<th
										className="sticky left-0 z-10 grid place-items-center bg-card"
										scope="col"
									>
										<Checkbox
											checked={
												grid.length > 0 && grid.every((g) => selected.has(g.id))
													? true
													: selected.size
														? "indeterminate"
														: false
											}
											onCheckedChange={(c) =>
												setSelected(
													c === true
														? new Set(grid.map((g) => g.id))
														: new Set(),
												)
											}
											aria-label="Select all loaded rows"
										/>
									</th>
								)}
								{columns.map((column, c) => {
									const s = sortOf(column.name);
									return (
										<th
											key={column.name}
											scope="col"
											aria-sort={
												s && sort.length === 1
													? s.desc
														? "descending"
														: "ascending"
													: undefined
											}
											className={cn(
												"bg-card",
												c < pinned && "z-10",
												c === pinned - 1 && "border-r",
											)}
											style={pinStyle(c)}
										>
											<button
												type="button"
												tabIndex={-1}
												onClick={(e) =>
													onSort(nextSort(sort, column.name, e.shiftKey))
												}
												title={`${column.name} ${column.type}${column.nullable ? "" : " not null"}${column.default ? ` default ${column.default}` : ""}. Click to sort, Shift-click to add.`}
												className={cn(
													"flex h-9 w-full items-center gap-1.5 px-3 text-left text-xs outline-none hover:bg-muted/60",
													isNumeric(column.type) && "justify-end text-right",
												)}
											>
												{column.primaryKey && (
													<KeyRound
														className="size-3 shrink-0 text-muted-foreground"
														aria-label="Primary key"
													/>
												)}
												<span className="truncate font-medium">
													{column.name}
												</span>
												<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
													{shortType(column.type)}
												</span>
												{s && (
													<span className="flex shrink-0 items-center text-foreground">
														{s.desc ? (
															<ArrowDown
																className="size-3"
																aria-label="descending"
															/>
														) : (
															<ArrowUp
																className="size-3"
																aria-label="ascending"
															/>
														)}
														{s.n && (
															<span className="text-[10px] tabular">{s.n}</span>
														)}
													</span>
												)}
											</button>
										</th>
									);
								})}
							</tr>
						</thead>

						{grid.length === 0 ? (
							<tbody className="block">
								<tr className="block">
									<td className="block px-6 py-16 text-center">
										<p className="text-sm text-muted-foreground">
											{filter.length
												? "No rows match these filters."
												: `${table.name} has no rows yet.`}
										</p>
									</td>
								</tr>
							</tbody>
						) : (
							<tbody
								className="relative block"
								style={{
									height: virtual.getTotalSize(),
									width: total,
									minWidth: "100%",
								}}
							>
								{items.map((v) => {
									const row = grid[v.index] as GridRow;
									const deleted = row.id in staged.deletes;
									const isSel = selected.has(row.id);
									return (
										<tr
											key={row.id}
											aria-rowindex={v.index + 2}
											aria-selected={writable ? isSel : undefined}
											className={cn(
												"absolute top-0 left-0 grid border-b border-border/60",
												deleted
													? TINT.deleted
													: row.kind === "new"
														? TINT.new
														: isSel
															? TINT.selected
															: TINT.row,
											)}
											style={{
												gridTemplateColumns: template,
												width: "100%",
												minWidth: total,
												height: ROW,
												transform: `translateY(${v.start}px)`,
											}}
										>
											{writable && (
												<td className="sticky left-0 z-10 grid place-items-center bg-inherit">
													<Checkbox
														tabIndex={-1}
														checked={isSel}
														onCheckedChange={(on) =>
															toggleRow(row.id, on === true)
														}
														aria-label={
															row.kind === "new"
																? "Select new row"
																: `Select row ${v.index + 1}`
														}
													/>
												</td>
											)}
											{columns.map((column, c) => {
												const isActive =
													active?.r === v.index && active.c === c;
												const value = valueAt(row, c);
												const changed =
													row.kind === "row" &&
													column.name in (staged.edits[row.id]?.values ?? {});
												return (
													<td
														key={column.name}
														id={cellId(v.index, c)}
														onMouseDown={() => setActive({ r: v.index, c })}
														onDoubleClick={() => {
															setActive({ r: v.index, c });
															if (canEdit(v.index)) setEditing(true);
														}}
														className={cn(
															"relative flex min-w-0 items-center px-3",
															c < pinned ? "z-[5] bg-inherit" : "",
															c === pinned - 1 && "border-r",
															isNumeric(column.type) &&
																"justify-end text-right tabular",
															isActive &&
																"outline-2 -outline-offset-2 outline-ring/40 group-focus/grid:outline-ring",
														)}
														style={{
															...pinStyle(c),
															...(changed
																? { backgroundColor: mix("--warn", 18) }
																: null),
														}}
													>
														<CellView value={value} column={column} />
														{editingAt?.r === v.index && editingAt.c === c && (
															<CellEditor
																column={column}
																value={value ?? null}
																onCommit={(next, move) =>
																	commit(v.index, c, next, move)
																}
																onCancel={() => {
																	setEditing(false);
																	gridEl.current?.focus({
																		preventScroll: true,
																	});
																}}
															/>
														)}
													</td>
												);
											})}
										</tr>
									);
								})}
							</tbody>
						)}
					</table>
				</div>
			)}

			<div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
				{ops.length > 0 || saveError ? (
					<>
						<div
							className="t-swap flex min-w-60 flex-1 flex-col gap-0.5"
							role="status"
						>
							<span className="font-medium text-foreground tabular">
								{ops.length} unsaved {ops.length === 1 ? "change" : "changes"}
							</span>
							{saveError && (
								<span role="alert" className="text-bad-text">
									{saveError.text}
								</span>
							)}
						</div>
						{saveError?.stale && (
							<Button
								size="sm"
								variant="outline"
								onClick={() => rows.refetch()}
							>
								<RotateCcw data-icon="inline-start" />
								Reload rows
							</Button>
						)}
						<Button
							size="sm"
							variant="ghost"
							onClick={() => stage(EMPTY_STAGED)}
						>
							Discard
						</Button>
						<Button
							size="sm"
							disabled={!writable || !ops.length || write.isPending}
							onClick={() => (deletes ? setConfirming(true) : save())}
						>
							{write.isPending && <Loader2 className="animate-spin" />}
							Save changes
						</Button>
					</>
				) : (
					<span className="tabular" aria-live="polite">
						{loaded.length.toLocaleString("en")}{" "}
						{rows.hasNextPage ? "loaded" : loaded.length === 1 ? "row" : "rows"}
						{rows.isFetchingNextPage && (
							<Loader2
								className="ml-1.5 inline size-3 animate-spin"
								aria-label="Loading more"
							/>
						)}
						{writable && (
							<span className="ml-3 hidden sm:inline">
								Double-click or press Enter to edit a cell.
							</span>
						)}
					</span>
				)}
			</div>

			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`Delete ${deletes} ${deletes === 1 ? "row" : "rows"} from ${table.name}?`}
				description={`Saving applies all ${ops.length} changes in one transaction. Deleted rows can't be recovered.`}
				confirmLabel="Save and delete"
				pending={write.isPending}
				onConfirm={save}
			/>
		</>
	);
}
