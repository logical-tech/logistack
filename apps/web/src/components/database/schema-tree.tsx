import type { DatabaseSchema, DbTable } from "@logistack/contracts";
import {
	Braces,
	ChevronRight,
	Eye,
	Globe,
	Layers,
	type LucideIcon,
	Search,
	Table2,
} from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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

type Item =
	| { id: string; kind: "schema"; name: string; open: boolean }
	| { id: string; kind: "table"; schema: string; table: DbTable };

const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);
const schemaId = (name: string) => `s:${name}`;
const tableId = (schema: string, table: string) => `t:${schema}.${table}`;
const domId = (id: string) => `dbtree-${id}`;

/** Schemas and their tables as an ARIA tree: arrows move, Right and Left open and close, Enter opens a table. */
export function SchemaTree({
	database,
	schemas,
	selected,
	pending,
	onSelect,
	noun = "tables",
}: {
	/** What the leaves are, lowercase plural: tables, or collections for MongoDB. */
	noun?: string;
	database: string;
	schemas: Schemas;
	selected: Ref;
	pending: (tableKey: string) => number;
	onSelect: (schema: string, table: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [closed, setClosed] = useState<Set<string>>(new Set());
	const [focus, setFocus] = useState(tableId(selected.schema, selected.table));
	const q = query.trim().toLowerCase();

	const items: Item[] = schemas.flatMap((s) => {
		const tables = q
			? s.tables.filter((t) => t.name.toLowerCase().includes(q))
			: s.tables;
		if (q && !tables.length) return [];
		const open = !!q || !closed.has(s.name);
		return [
			{ id: schemaId(s.name), kind: "schema", name: s.name, open },
			...(open
				? tables.map(
						(table): Item => ({
							id: tableId(s.name, table.name),
							kind: "table",
							schema: s.name,
							table,
						}),
					)
				: []),
		];
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

	const onKey = (e: KeyboardEvent, item: Item, i: number) => {
		const at = (j: number) => items[j]?.id;
		const parent = item.kind === "table" ? schemaId(item.schema) : undefined;
		const open = () =>
			item.kind === "table"
				? onSelect(item.schema, item.table.name)
				: !q && toggle(item.name, !item.open);
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
				if (item.kind !== "schema") break;
				if (item.open) move(at(i + 1));
				else toggle(item.name, true);
				break;
			case "ArrowLeft":
				if (item.kind === "schema" && item.open && !q) toggle(item.name, false);
				else move(parent);
				break;
			case "Enter":
			case " ":
				open();
				break;
			default:
				return;
		}
		e.preventDefault();
	};

	return (
		<nav
			aria-label={cap(noun)}
			className="hidden w-64 shrink-0 flex-col border-r md:flex"
		>
			<div className="grid gap-2 border-b p-2">
				<h2 className="truncate px-1.5 pt-1 text-sm font-semibold [font-stretch:100%]">
					{database}
				</h2>
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
						if (item.kind === "schema")
							return (
								<div
									key={item.id}
									id={domId(item.id)}
									role="treeitem"
									aria-level={1}
									aria-expanded={item.open}
									aria-selected={false}
									tabIndex={tabStop === item.id ? 0 : -1}
									onKeyDown={(e) => onKey(e, item, i)}
									onFocus={() => setFocus(item.id)}
									onClick={() => !q && toggle(item.name, !item.open)}
									className="mt-1 flex h-7 cursor-default items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground outline-none select-none first:mt-0 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								>
									<ChevronRight
										className={cn(
											"size-3.5 shrink-0 transition-transform duration-(--duration-quick) ease-(--ease-smooth-out)",
											item.open && "rotate-90",
										)}
										aria-hidden
									/>
									{item.name}
								</div>
							);
						const { schema, table } = item;
						const active =
							schema === selected.schema && table.name === selected.table;
						const Icon = KIND[table.kind].icon;
						const staged = pending(`${schema}.${table.name}`);
						return (
							<div
								key={item.id}
								id={domId(item.id)}
								role="treeitem"
								aria-level={2}
								aria-selected={active}
								aria-current={active ? "true" : undefined}
								tabIndex={tabStop === item.id ? 0 : -1}
								onKeyDown={(e) => onKey(e, item, i)}
								onFocus={() => setFocus(item.id)}
								onClick={() => onSelect(schema, table.name)}
								title={`${KIND[table.kind].label} ${schema}.${table.name}`}
								className={cn(
									"flex h-8 cursor-default items-center gap-2 rounded-md pr-2 pl-6 text-sm outline-none transition-colors duration-(--duration-quick) select-none focus-visible:ring-2 focus-visible:ring-ring",
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
									className="shrink-0 text-xs font-normal text-muted-foreground tabular"
									title={
										table.rows === null
											? "Not analyzed yet"
											: `About ${table.rows.toLocaleString("en")} rows`
									}
								>
									{table.rows === null ? "–" : compact.format(table.rows)}
								</span>
							</div>
						);
					})}
				</div>
			) : (
				<p className="px-4 py-8 text-center text-sm text-muted-foreground">
					No table matches “{query}”.
				</p>
			)}
		</nav>
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
