import type { DatabaseSchema, DbTable } from "@logistack/contracts";
import {
	Braces,
	ChevronRight,
	Copy,
	Ellipsis,
	Eye,
	FolderPlus,
	Globe,
	Hash,
	Layers,
	ListOrdered,
	type LucideIcon,
	Plus,
	Search,
	SquareFunction,
	Table2,
	Trash,
	Workflow,
} from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type DbObject, type Dialect, objectNoun, type Template } from "./ddl";

type Schemas = DatabaseSchema["schemas"];
type Ref = { schema: string; table: string };

export const KIND: Record<
	DbTable["kind"],
	{ icon: LucideIcon; label: string }
> = {
	table: { icon: Table2, label: "Table" },
	view: { icon: Eye, label: "View" },
	materialized_view: { icon: Layers, label: "Materialized view" },
	foreign_table: { icon: Globe, label: "Foreign table" },
	collection: { icon: Braces, label: "Collection" },
};

const compact = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

type Group = "enums" | "sequences" | "routines";
const GROUP_LABEL: Record<Group, string> = {
	enums: "Enums",
	sequences: "Sequences",
	routines: "Functions",
};

type Item =
	| { id: string; kind: "schema"; name: string; open: boolean }
	| { id: string; kind: "table"; schema: string; table: DbTable }
	| {
			id: string;
			kind: "group";
			schema: string;
			group: Group;
			count: number;
			open: boolean;
	  }
	| { id: string; kind: "object"; object: DbObject; group: Group };

const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);
const schemaId = (name: string) => `s:${name}`;
const tableId = (schema: string, table: string) => `t:${schema}.${table}`;
const groupId = (schema: string, g: Group) => `g:${schema}.${g}`;
const domId = (id: string) => `dbtree-${id}`;
const parentOf = (item: Item) =>
	item.kind === "table"
		? schemaId(item.schema)
		: item.kind === "group"
			? schemaId(item.schema)
			: item.kind === "object"
				? groupId(item.object.schema, item.group)
				: undefined;

const OBJECT_ICON: Record<Exclude<DbObject["kind"], "table">, LucideIcon> = {
	enum: ListOrdered,
	sequence: Hash,
	routine: SquareFunction,
};

/** What the tree can create and drop; absent for engines without SQL (MongoDB). */
export type TreeActions = {
	dialect: Dialect;
	/** Postgres: the instance's databases, for the picker. */
	databases?: string[];
	/** The database the service logs into; it is never offered for dropping. */
	defaultDatabase?: string;
	onDatabase?: (name: string) => void;
	onNewDatabase: () => void;
	onDropDatabase: (name: string) => void;
	onNew: (schema: string, what: "table" | Template) => void;
	onDrop: (o: DbObject) => void;
};

type Menu = { id: string; which: "add" | "more" } | null;

const NEW_DATABASE = "\u0000new";

/** Schemas and their tables as an ARIA tree: arrows move, Right and Left open and close, Enter opens a table. "+" opens a schema's new menu, Shift+F10 a row's actions, Delete drops. */
export function SchemaTree({
	database,
	schemas,
	selected,
	pending,
	onSelect,
	noun = "tables",
	actions,
}: {
	/** What the leaves are, lowercase plural: tables, or collections for MongoDB. */
	noun?: string;
	database: string;
	schemas: Schemas;
	/** Undefined while the database has no table. */
	selected: Ref | undefined;
	pending: (tableKey: string) => number;
	onSelect: (schema: string, table: string) => void;
	actions?: TreeActions;
}) {
	const [query, setQuery] = useState("");
	const [closed, setClosed] = useState<Set<string>>(new Set());
	const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
	const [focus, setFocus] = useState(
		selected ? tableId(selected.schema, selected.table) : "",
	);
	const [menu, setMenu] = useState<Menu>(null);
	const q = query.trim().toLowerCase();
	const hit = (name: string) => !q || name.toLowerCase().includes(q);
	const pg = actions?.dialect === "postgres";

	const items: Item[] = schemas.flatMap((s) => {
		const tables = s.tables.filter((t) => hit(t.name));
		const objects: Record<Group, DbObject[]> = {
			enums: (s.enums ?? [])
				.filter((e) => hit(e.name))
				.map((e) => ({ kind: "enum", schema: s.name, name: e.name })),
			sequences: (s.sequences ?? [])
				.filter((e) => hit(e.name))
				.map((e) => ({ kind: "sequence", schema: s.name, name: e.name })),
			routines: (s.routines ?? [])
				.filter((e) => hit(e.name))
				.map((r) => ({
					kind: "routine",
					schema: s.name,
					name: r.name,
					routine: r,
				})),
		};
		const groups = (Object.keys(objects) as Group[]).filter(
			(g) => objects[g].length,
		);
		if (q && !tables.length && !groups.length) return [];
		const open = !!q || !closed.has(s.name);
		const out: Item[] = [
			{ id: schemaId(s.name), kind: "schema", name: s.name, open },
		];
		if (!open) return out;
		for (const table of tables)
			out.push({
				id: tableId(s.name, table.name),
				kind: "table",
				schema: s.name,
				table,
			});
		for (const g of groups) {
			const id = groupId(s.name, g);
			const groupOpen = !!q || openGroups.has(id);
			out.push({
				id,
				kind: "group",
				schema: s.name,
				group: g,
				count: objects[g].length,
				open: groupOpen,
			});
			if (groupOpen)
				for (const o of objects[g])
					out.push({
						id: `o:${s.name}.${o.kind}.${o.name}.${o.kind === "routine" ? o.routine.arguments : ""}`,
						kind: "object",
						object: o,
						group: g,
					});
		}
		return out;
	});
	// The focused item can vanish under the filter; the first one takes the tab stop.
	const tabStop = items.some((i) => i.id === focus) ? focus : items[0]?.id;

	const move = (id: string | undefined) => {
		if (!id) return;
		setFocus(id);
		document.getElementById(domId(id))?.focus();
	};
	const toggle = (name: string, open: boolean) =>
		setClosed((c) => {
			const n = new Set(c);
			if (open) n.delete(name);
			else n.add(name);
			return n;
		});
	const toggleGroup = (id: string, open: boolean) =>
		setOpenGroups((c) => {
			const n = new Set(c);
			if (open) n.add(id);
			else n.delete(id);
			return n;
		});
	const objectOf = (item: Item): DbObject | undefined =>
		item.kind === "object"
			? item.object
			: item.kind === "table"
				? {
						kind: "table",
						schema: item.schema,
						name: item.table.name,
						table: item.table.kind,
					}
				: undefined;
	// MySQL's schemas are its databases, so each one can be dropped from its row.
	const schemaMore = !!actions && !pg;
	const menusOf = (item: Item) => ({
		add: !!actions && item.kind === "schema",
		more:
			!!actions &&
			(item.kind === "table" ||
				item.kind === "object" ||
				(item.kind === "schema" &&
					schemaMore &&
					item.name !== actions.defaultDatabase)),
	});

	const onKey = (e: KeyboardEvent, item: Item, i: number) => {
		const at = (j: number) => items[j]?.id;
		const menus = menusOf(item);
		if (
			(e.key === "F10" && e.shiftKey) ||
			e.key === "ContextMenu" ||
			(e.key === "+" && menus.add)
		) {
			if (menus.add || menus.more)
				setMenu({
					id: item.id,
					which: e.key === "+" || !menus.more ? "add" : "more",
				});
			e.preventDefault();
			return;
		}
		if (e.key === "Delete" && actions) {
			const o = objectOf(item);
			if (o) {
				actions.onDrop(o);
				e.preventDefault();
			}
			return;
		}
		switch (e.key) {
			case "ArrowDown":
				move(at(i + 1));
				break;
			case "ArrowUp":
				if (i === 0) document.getElementById("dbtree-filter")?.focus();
				else move(at(i - 1));
				break;
			case "Home":
				move(at(0));
				break;
			case "End":
				move(at(items.length - 1));
				break;
			case "ArrowRight":
				if (item.kind === "schema") {
					if (item.open) move(at(i + 1));
					else toggle(item.name, true);
				} else if (item.kind === "group") {
					if (item.open) move(at(i + 1));
					else toggleGroup(item.id, true);
				}
				break;
			case "ArrowLeft":
				if (item.kind === "schema" && item.open && !q) toggle(item.name, false);
				else if (item.kind === "group" && item.open && !q)
					toggleGroup(item.id, false);
				else move(parentOf(item));
				break;
			case "Enter":
			case " ":
				if (item.kind === "table") onSelect(item.schema, item.table.name);
				else if (item.kind === "schema") !q && toggle(item.name, !item.open);
				else if (item.kind === "group") !q && toggleGroup(item.id, !item.open);
				else if (menus.more) setMenu({ id: item.id, which: "more" });
				break;
			default:
				return;
		}
		e.preventDefault();
	};

	/** The row's "+" and "…" buttons; off the tab order, reached by the keys above. */
	const rowMenus = (item: Item) => {
		if (!actions) return null;
		const menus = menusOf(item);
		const label =
			item.kind === "schema"
				? item.name
				: item.kind === "table"
					? item.table.name
					: item.kind === "object"
						? item.object.name
						: "";
		const refocus = (e: Event) => {
			e.preventDefault();
			document.getElementById(domId(item.id))?.focus();
		};
		const trigger = (which: "add" | "more", Icon: LucideIcon, aria: string) => (
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					tabIndex={-1}
					aria-label={aria}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
					className={cn(
						"relative grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-(--duration-quick) outline-none group-hover/row:opacity-100 group-focus-visible/row:opacity-100 after:absolute after:-inset-1 hover:bg-foreground/8 hover:text-foreground data-[state=open]:opacity-100 data-[state=open]:bg-foreground/8 pointer-coarse:opacity-100",
						menu?.id === item.id && menu.which === which && "opacity-100",
					)}
				>
					<Icon className="size-3.5" aria-hidden />
				</button>
			</DropdownMenuTrigger>
		);
		const o = objectOf(item);
		return (
			<>
				{menus.add && item.kind === "schema" && (
					<DropdownMenu
						open={menu?.id === item.id && menu.which === "add"}
						onOpenChange={(open) =>
							setMenu(open ? { id: item.id, which: "add" } : null)
						}
					>
						{trigger("add", Plus, `New in ${label}`)}
						<DropdownMenuContent
							align="start"
							className="w-auto min-w-44"
							onCloseAutoFocus={refocus}
						>
							<DropdownMenuLabel className="text-xs text-muted-foreground">
								New in {label}
							</DropdownMenuLabel>
							<DropdownMenuItem
								onSelect={() => actions.onNew(item.name, "table")}
							>
								<Table2 />
								Table…
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() => actions.onNew(item.name, "view")}
							>
								<Eye />
								View
							</DropdownMenuItem>
							{pg && (
								<DropdownMenuItem
									onSelect={() => actions.onNew(item.name, "enum")}
								>
									<ListOrdered />
									Enum
								</DropdownMenuItem>
							)}
							<DropdownMenuItem
								onSelect={() => actions.onNew(item.name, "function")}
							>
								<SquareFunction />
								Function
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				{menus.more && (
					<DropdownMenu
						open={menu?.id === item.id && menu.which === "more"}
						onOpenChange={(open) =>
							setMenu(open ? { id: item.id, which: "more" } : null)
						}
					>
						{trigger("more", Ellipsis, `Actions for ${label}`)}
						<DropdownMenuContent
							align="start"
							className="w-auto min-w-40"
							onCloseAutoFocus={refocus}
						>
							<DropdownMenuItem
								onSelect={() => {
									navigator.clipboard?.writeText(label).then(
										() => toast.success(`Copied ${label}`),
										() => toast.error("Couldn't copy"),
									);
								}}
							>
								<Copy />
								Copy name
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onSelect={() =>
									o
										? actions.onDrop(o)
										: item.kind === "schema" &&
											actions.onDropDatabase(item.name)
								}
							>
								<Trash />
								{o ? `Drop ${objectNoun(o)}…` : "Drop database…"}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</>
		);
	};

	const shortcuts = (item: Item) => {
		if (!actions) return undefined;
		const m = menusOf(item);
		return [
			m.add && "+",
			(m.add || m.more) && "Shift+F10",
			objectOf(item) && "Delete",
		]
			.filter(Boolean)
			.join(" ");
	};

	return (
		<nav
			aria-label={cap(noun)}
			className="hidden w-64 shrink-0 flex-col border-r md:flex"
		>
			<div className="grid gap-2 border-b p-2">
				<TreeHeader database={database} actions={actions} />
				<div className="relative">
					<Search
						className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
						aria-hidden
					/>
					<Input
						id="dbtree-filter"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								move(items.find((i) => i.kind === "table")?.id ?? items[0]?.id);
							}
							if (e.key === "Escape" && query) {
								e.preventDefault();
								setQuery("");
							}
						}}
						placeholder={`Filter ${noun}`}
						aria-label={`Filter ${noun}`}
						aria-controls="dbtree"
						className="h-8 pl-8"
					/>
				</div>
			</div>
			{items.length ? (
				<div
					id="dbtree"
					role="tree"
					aria-label={`${cap(noun)} in ${database}`}
					className="min-h-0 flex-1 overflow-y-auto p-1.5"
				>
					{items.map((item, i) => {
						const common = {
							id: domId(item.id),
							onFocus: () => setFocus(item.id),
							onContextMenu: (e: MouseEvent) => {
								const m = menusOf(item);
								if (!m.add && !m.more) return;
								e.preventDefault();
								setFocus(item.id);
								setMenu({ id: item.id, which: m.more ? "more" : "add" });
							},
							"aria-keyshortcuts": shortcuts(item),
						} as const;
						if (item.kind === "schema")
							return (
								<div
									key={item.id}
									role="treeitem"
									tabIndex={tabStop === item.id ? 0 : -1}
									onKeyDown={(e) => onKey(e, item, i)}
									{...common}
									aria-level={1}
									aria-label={`Schema ${item.name}`}
									aria-expanded={item.open}
									aria-selected={false}
									onClick={() => !q && toggle(item.name, !item.open)}
									className="group/row mt-1 flex h-7 cursor-default items-center gap-1 rounded-md pr-1 pl-1.5 text-xs font-medium text-muted-foreground outline-none select-none first:mt-0 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								>
									<ChevronRight
										className={cn(
											"size-3.5 shrink-0 transition-transform duration-(--duration-quick) ease-(--ease-smooth-out)",
											item.open && "rotate-90",
										)}
										aria-hidden
									/>
									<span className="min-w-0 flex-1 truncate">{item.name}</span>
									{rowMenus(item)}
								</div>
							);
						if (item.kind === "group")
							return (
								<div
									key={item.id}
									role="treeitem"
									tabIndex={tabStop === item.id ? 0 : -1}
									onKeyDown={(e) => onKey(e, item, i)}
									{...common}
									aria-level={2}
									aria-label={`${GROUP_LABEL[item.group]} in ${item.schema}, ${item.count}`}
									aria-expanded={item.open}
									aria-selected={false}
									onClick={() => !q && toggleGroup(item.id, !item.open)}
									className="group/row flex h-7 cursor-default items-center gap-1.5 rounded-md pr-2 pl-5 text-xs text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								>
									<ChevronRight
										className={cn(
											"size-3 shrink-0 transition-transform duration-(--duration-quick) ease-(--ease-smooth-out)",
											item.open && "rotate-90",
										)}
										aria-hidden
									/>
									<span className="min-w-0 flex-1 truncate">
										{GROUP_LABEL[item.group]}
									</span>
									<span className="tabular">{item.count}</span>
								</div>
							);
						if (item.kind === "object") {
							const o = item.object;
							const Icon =
								o.kind === "routine" && o.routine.kind === "procedure"
									? Workflow
									: OBJECT_ICON[o.kind as Exclude<DbObject["kind"], "table">];
							const s = schemas.find((x) => x.name === o.schema);
							const values =
								o.kind === "enum"
									? (s?.enums?.find((e) => e.name === o.name)?.values ?? [])
									: [];
							const detail =
								o.kind === "routine"
									? `(${o.routine.arguments})`
									: values.join(", ");
							const title =
								o.kind === "routine"
									? `${cap(o.routine.kind)} ${o.schema}.${o.name}(${o.routine.arguments})${o.routine.returns ? ` returns ${o.routine.returns}` : ""}`
									: o.kind === "enum"
										? `Enum ${o.schema}.${o.name}: ${values.join(", ")}`
										: `Sequence ${o.schema}.${o.name}`;
							return (
								<div
									key={item.id}
									role="treeitem"
									tabIndex={tabStop === item.id ? 0 : -1}
									onKeyDown={(e) => onKey(e, item, i)}
									{...common}
									aria-level={3}
									aria-selected={false}
									title={title}
									className="group/row flex h-8 cursor-default items-center gap-2 rounded-md pr-1 pl-9 text-sm text-foreground/85 outline-none select-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
								>
									<Icon
										className="size-3.5 shrink-0 text-muted-foreground"
										strokeWidth={1.75}
										aria-hidden
									/>
									<span className="min-w-0 flex-1 truncate">
										{o.name}
										{detail && (
											<span className="ml-1.5 text-xs text-muted-foreground">
												{detail}
											</span>
										)}
									</span>
									{rowMenus(item)}
								</div>
							);
						}
						const { schema, table } = item;
						const active =
							schema === selected?.schema && table.name === selected?.table;
						const Icon = KIND[table.kind].icon;
						const staged = pending(`${schema}.${table.name}`);
						return (
							<div
								key={item.id}
								role="treeitem"
								tabIndex={tabStop === item.id ? 0 : -1}
								onKeyDown={(e) => onKey(e, item, i)}
								{...common}
								aria-level={2}
								aria-selected={active}
								aria-current={active ? "true" : undefined}
								onClick={() => onSelect(schema, table.name)}
								title={`${KIND[table.kind].label} ${schema}.${table.name}`}
								className={cn(
									"group/row flex h-8 cursor-default items-center gap-2 rounded-md pr-1 pl-6 text-sm outline-none transition-colors duration-(--duration-quick) select-none focus-visible:ring-2 focus-visible:ring-ring",
									active
										? "bg-muted font-medium"
										: "text-foreground/85 hover:bg-muted/60",
								)}
							>
								<Icon
									className="size-3.5 shrink-0 text-muted-foreground"
									strokeWidth={1.75}
									aria-label={KIND[table.kind].label}
								/>
								<span className="min-w-0 flex-1 truncate">{table.name}</span>
								{staged > 0 && (
									<span
										className="size-1.5 shrink-0 rounded-full bg-warn"
										title={`${staged} unsaved changes`}
									>
										<span className="sr-only">, {staged} unsaved changes</span>
									</span>
								)}
								<span
									className={cn(
										"shrink-0 pr-1 text-xs font-normal text-muted-foreground tabular",
										actions &&
											"group-hover/row:hidden group-focus-visible/row:hidden",
									)}
									title={
										table.rows === null
											? "Not analyzed yet"
											: `About ${table.rows.toLocaleString("en")} rows`
									}
								>
									{table.rows === null ? "–" : compact.format(table.rows)}
								</span>
								{actions && (
									<span
										className={cn(
											"hidden group-hover/row:flex group-focus-visible/row:flex",
											menu?.id === item.id && "flex",
										)}
									>
										{rowMenus(item)}
									</span>
								)}
							</div>
						);
					})}
				</div>
			) : q ? (
				<p className="px-4 py-8 text-center text-sm text-muted-foreground">
					No table matches “{query}”.
				</p>
			) : (
				<p className="px-4 py-8 text-center text-sm text-muted-foreground">
					No schemas yet.
				</p>
			)}
		</nav>
	);
}

/** The database name; on Postgres a picker over the instance's databases with a "…" menu. */
function TreeHeader({
	database,
	actions,
}: {
	database: string;
	actions?: TreeActions;
}) {
	const [open, setOpen] = useState(false);
	if (!actions)
		return (
			<h2 className="truncate px-1.5 pt-1 text-sm font-semibold [font-stretch:100%]">
				{database}
			</h2>
		);
	if (actions.dialect === "mysql")
		return (
			<div className="flex items-center gap-1 pt-0.5 pl-1.5">
				<h2 className="min-w-0 flex-1 truncate text-sm font-semibold [font-stretch:100%]">
					{database}
				</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					className="text-muted-foreground"
					aria-label="New database"
					title="New database"
					onClick={actions.onNewDatabase}
				>
					<Plus />
				</Button>
			</div>
		);
	const databases = actions.databases?.length ? actions.databases : [database];
	return (
		<div className="flex items-center gap-1">
			<Select
				value={database}
				onValueChange={(v) =>
					v === NEW_DATABASE ? actions.onNewDatabase() : actions.onDatabase?.(v)
				}
			>
				<SelectTrigger
					size="sm"
					aria-label="Database"
					className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1.5 font-semibold shadow-none hover:bg-muted/60 dark:bg-transparent"
				>
					{/* The items carry a "default" note the trigger leaves out. */}
					<SelectValue>{database}</SelectValue>
				</SelectTrigger>
				<SelectContent position="popper" align="start">
					<SelectGroup>
						<SelectLabel>Databases</SelectLabel>
						{databases.map((d) => (
							<SelectItem key={d} value={d}>
								{d}
								{d === actions.defaultDatabase && (
									<span className="text-xs text-muted-foreground">default</span>
								)}
							</SelectItem>
						))}
					</SelectGroup>
					<SelectSeparator />
					<SelectItem value={NEW_DATABASE}>
						<Plus className="text-muted-foreground" />
						New database…
					</SelectItem>
				</SelectContent>
			</Select>
			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						className="text-muted-foreground"
						aria-label={`Actions for ${database}`}
					>
						<Ellipsis />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-44">
					<DropdownMenuItem onSelect={() => actions.onNew("", "schema")}>
						<FolderPlus />
						New schema
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={actions.onNewDatabase}>
						<Plus />
						New database…
					</DropdownMenuItem>
					{database !== actions.defaultDatabase && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onSelect={() => actions.onDropDatabase(database)}
							>
								<Trash />
								Drop {database}…
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** The tree's narrow-screen stand-in: one select, grouped by schema. */
export function TablePicker({
	schemas,
	selected,
	onSelect,
	label = "Table",
}: {
	schemas: Schemas;
	selected: Ref;
	onSelect: (schema: string, table: string) => void;
	label?: string;
}) {
	return (
		<Select
			value={JSON.stringify([selected.schema, selected.table])}
			onValueChange={(v) => {
				const [s, t] = JSON.parse(v) as [string, string];
				onSelect(s, t);
			}}
		>
			<SelectTrigger className="w-full" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{schemas.map((s) => (
					<SelectGroup key={s.name}>
						<SelectLabel>{s.name}</SelectLabel>
						{s.tables.map((t) => (
							<SelectItem key={t.name} value={JSON.stringify([s.name, t.name])}>
								{t.name}
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}
