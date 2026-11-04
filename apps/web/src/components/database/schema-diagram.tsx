import { Graph, layout } from "@dagrejs/dagre";
import type { DatabaseSchema, DbTable } from "@logistack/contracts";
import {
	Background,
	BackgroundVariant,
	type Edge,
	Handle,
	type Node,
	type NodeProps,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import {
	ArrowUpRight,
	KeyRound,
	Link2,
	Maximize,
	Minus,
	Network,
	Plus,
} from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { KIND } from "./schema-tree";

const WIDTH = 256;
const HEADER = 37;
const ROW = 26;
/** Columns past this fold into "+N more", except keys and the columns keys point at. */
const SHOWN = 12;
const ALL = "\u0000all";

type TableData = {
	schema: string;
	table: DbTable;
	columns: DbTable["columns"];
	hidden: number;
	/** Column names that are part of a foreign key, with what they point at. */
	refs: Map<string, string>;
	showSchema: boolean;
	onOpen: (schema: string, table: string) => void;
};
type TableNode = Node<TableData, "table">;

const nodeId = (schema: string, table: string) => `${schema}.${table}`;
const handle = (column: string, side: "in" | "out") => `${side}:${column}`;

/** Nodes placed by dagre, parents left of the tables that reference them, and one edge per key. */
function diagram(
	schemas: DatabaseSchema["schemas"],
	showSchema: boolean,
	onOpen: TableData["onOpen"],
) {
	const tables = schemas.flatMap((s) =>
		s.tables.map((t) => ({ schema: s.name, table: t })),
	);
	const present = new Set(tables.map((t) => nodeId(t.schema, t.table.name)));
	// Referenced columns stay visible, so every edge lands on a row.
	const referenced = new Set<string>();
	for (const { table } of tables)
		for (const fk of table.foreignKeys ?? [])
			for (const c of fk.refColumns)
				referenced.add(`${nodeId(fk.refSchema, fk.refTable)}:${c}`);

	const g = new Graph();
	g.setGraph({
		rankdir: "LR",
		nodesep: 32,
		ranksep: 96,
		marginx: 24,
		marginy: 24,
	});
	g.setDefaultEdgeLabel(() => ({}));
	const nodes: TableNode[] = [];
	const edges: Edge[] = [];
	for (const { schema, table } of tables) {
		const id = nodeId(schema, table.name);
		const refs = new Map<string, string>();
		for (const fk of table.foreignKeys ?? [])
			for (const [i, c] of fk.columns.entries())
				refs.set(
					c,
					`${fk.refSchema === schema ? "" : `${fk.refSchema}.`}${fk.refTable}.${fk.refColumns[i] ?? ""}`,
				);
		const keep = (c: DbTable["columns"][number]) =>
			c.primaryKey || refs.has(c.name) || referenced.has(`${id}:${c.name}`);
		const rest = table.columns.filter((c) => !keep(c));
		const room = Math.max(0, SHOWN - (table.columns.length - rest.length));
		const shownRest = new Set(rest.slice(0, room).map((c) => c.name));
		const columns = table.columns.filter(
			(c) => keep(c) || shownRest.has(c.name),
		);
		const hidden = table.columns.length - columns.length;
		const height =
			HEADER + Math.max(1, columns.length + (hidden ? 1 : 0)) * ROW;
		g.setNode(id, { width: WIDTH, height });
		nodes.push({
			id,
			type: "table",
			position: { x: 0, y: 0 },
			width: WIDTH,
			height,
			data: { schema, table, columns, hidden, refs, showSchema, onOpen },
		});
		for (const fk of table.foreignKeys ?? []) {
			const parent = nodeId(fk.refSchema, fk.refTable);
			if (!present.has(parent)) continue;
			if (parent !== id) g.setEdge(parent, id);
			edges.push({
				id: `${id}:${fk.name}`,
				source: parent,
				sourceHandle: handle(fk.refColumns[0] ?? "", "out"),
				target: id,
				targetHandle: handle(fk.columns[0] ?? "", "in"),
				type: "smoothstep",
				ariaLabel: `${id} (${fk.columns.join(", ")}) references ${parent} (${fk.refColumns.join(", ")})`,
			});
		}
	}
	layout(g);
	for (const n of nodes) {
		const p = g.node(n.id);
		n.position = { x: p.x - WIDTH / 2, y: p.y - (n.height ?? 0) / 2 };
	}
	return { nodes, edges };
}

const TableCard = memo(function TableCard({
	data,
	selected,
}: NodeProps<TableNode>) {
	const { schema, table, columns, hidden, refs, showSchema, onOpen } = data;
	const Icon = KIND[table.kind].icon;
	return (
		<div
			className={cn(
				"overflow-hidden rounded-lg bg-card text-sm shadow-card ring-1 transition-[box-shadow] duration-(--duration-quick)",
				selected ? "ring-2 ring-brand" : "ring-border",
			)}
			style={{ width: WIDTH }}
		>
			<div
				className="group/head flex items-center gap-2 border-b bg-muted/40 px-3"
				style={{ height: HEADER }}
			>
				<Icon
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={1.75}
					aria-label={KIND[table.kind].label}
				/>
				<span className="min-w-0 flex-1 truncate font-medium">
					{showSchema && (
						<span className="font-normal text-muted-foreground">{schema}.</span>
					)}
					{table.name}
				</span>
				<Button
					variant="ghost"
					size="icon-xs"
					className="nodrag -mr-1.5 text-muted-foreground opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100 data-[selected=true]:opacity-100"
					data-selected={selected}
					aria-label={`Open ${schema}.${table.name}`}
					title="Open rows"
					onClick={() => onOpen(schema, table.name)}
				>
					<ArrowUpRight />
				</Button>
			</div>
			<ul>
				{columns.map((c) => {
					const ref = refs.get(c.name);
					return (
						<li
							key={c.name}
							className="relative flex items-center gap-2 px-3 text-xs"
							style={{ height: ROW }}
							title={ref ? `${c.name} → ${ref}` : undefined}
						>
							<Handle
								type="target"
								id={handle(c.name, "in")}
								position={Position.Left}
								isConnectable={false}
								className="!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent"
							/>
							<span className="flex w-3.5 shrink-0 justify-center text-muted-foreground">
								{c.primaryKey ? (
									<KeyRound
										className="size-3 text-warn-text"
										strokeWidth={2}
										aria-label="Primary key"
									/>
								) : ref ? (
									<Link2
										className="size-3"
										strokeWidth={2}
										aria-label="Foreign key"
									/>
								) : null}
							</span>
							<span
								className={cn(
									"min-w-0 flex-1 truncate",
									c.primaryKey && "font-medium",
								)}
							>
								{c.name}
							</span>
							<span className="max-w-[45%] shrink-0 truncate font-mono text-[0.6875rem] text-muted-foreground">
								{c.type}
								{c.nullable ? "?" : ""}
							</span>
							<Handle
								type="source"
								id={handle(c.name, "out")}
								position={Position.Right}
								isConnectable={false}
								className="!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent"
							/>
						</li>
					);
				})}
				{columns.length === 0 && (
					<li
						className="flex items-center px-3 text-xs text-muted-foreground"
						style={{ height: ROW }}
					>
						No columns
					</li>
				)}
				{hidden > 0 && (
					<li
						className="flex items-center px-3 pl-8.5 text-xs text-muted-foreground"
						style={{ height: ROW }}
					>
						+{hidden} more
					</li>
				)}
			</ul>
		</div>
	);
});

const nodeTypes = { table: TableCard };

/** Tables of the browsed database as cards, foreign keys as the lines between them. */
export function SchemaDiagram(props: {
	schema: DatabaseSchema;
	focus: string | undefined;
	onOpen: (schema: string, table: string) => void;
}) {
	return (
		<ReactFlowProvider>
			<Diagram {...props} />
		</ReactFlowProvider>
	);
}

function Diagram({
	schema,
	focus,
	onOpen,
}: {
	schema: DatabaseSchema;
	focus: string | undefined;
	onOpen: (schema: string, table: string) => void;
}) {
	const named = schema.schemas.filter((s) => s.tables.length > 0);
	const [only, setOnly] = useState<string>(() =>
		focus && named.some((s) => s.name === focus)
			? focus
			: named.length > 1
				? ALL
				: (named[0]?.name ?? ALL),
	);
	// Nodes hold a stable callback, so a new `onOpen` each render does not lay the graph out again.
	const open = useRef(onOpen);
	open.current = onOpen;
	const graph = useMemo(() => {
		const named = schema.schemas.filter((s) => s.tables.length > 0);
		return diagram(
			only === ALL ? named : named.filter((s) => s.name === only),
			only === ALL && named.length > 1,
			(s, t) => open.current(s, t),
		);
	}, [schema, only]);
	const tables = graph.nodes.length;
	const relations = graph.edges.length;

	if (named.length === 0)
		return (
			<div className="grid flex-1 place-items-center p-6">
				<EmptyState
					icon={Network}
					title={`${schema.database} has no tables yet`}
					description="Tables and the foreign keys between them show up here as a diagram."
					className="w-full max-w-xl bg-transparent dark:bg-transparent"
				/>
			</div>
		);
	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="flex h-11 shrink-0 items-center gap-3 border-b px-3">
				{named.length > 1 && (
					<Select value={only} onValueChange={setOnly}>
						<SelectTrigger
							size="sm"
							className="w-44"
							aria-label="Schema shown in the diagram"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All schemas</SelectItem>
							{named.map((s) => (
								<SelectItem key={s.name} value={s.name}>
									{s.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				<p className="text-xs text-muted-foreground tabular">
					{tables} {tables === 1 ? "table" : "tables"} · {relations}{" "}
					{relations === 1 ? "relation" : "relations"}
				</p>
				<ZoomControls />
			</div>
			<Canvas key={only} nodes={graph.nodes} edges={graph.edges} />
		</div>
	);
}

function Canvas({ nodes: laid, edges }: { nodes: TableNode[]; edges: Edge[] }) {
	const [nodes, , onNodesChange] = useNodesState(laid);
	const active = nodes.find((n) => n.selected)?.id;
	const styled = useMemo(
		() =>
			edges.map((e) => {
				const on =
					active !== undefined && (e.source === active || e.target === active);
				return {
					...e,
					zIndex: on ? 1 : 0,
					style: {
						stroke: on ? "var(--brand)" : "var(--muted-foreground)",
						strokeWidth: on ? 1.75 : 1.25,
						opacity: active === undefined || on ? (on ? 1 : 0.55) : 0.18,
						transition:
							"opacity var(--duration-quick), stroke var(--duration-quick)",
					},
				};
			}),
		[edges, active],
	);
	return (
		<div className="relative min-h-0 flex-1 bg-background">
			<ReactFlow<TableNode>
				nodes={nodes}
				edges={styled}
				nodeTypes={nodeTypes}
				onNodesChange={onNodesChange}
				onNodeDoubleClick={(_, n) =>
					n.data.onOpen(n.data.schema, n.data.table.name)
				}
				nodesConnectable={false}
				edgesFocusable={false}
				onlyRenderVisibleElements
				fitView
				fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
				minZoom={0.1}
				maxZoom={1.75}
				proOptions={{ hideAttribution: true }}
				aria-label="Schema diagram"
			>
				<Background
					variant={BackgroundVariant.Dots}
					gap={20}
					size={1}
					color="var(--border)"
				/>
			</ReactFlow>
		</div>
	);
}

function ZoomControls() {
	const flow = useReactFlow();
	return (
		<div className="ml-auto flex items-center gap-0.5">
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Zoom out"
				onClick={() => flow.zoomOut({ duration: 150 })}
			>
				<Minus />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Zoom in"
				onClick={() => flow.zoomIn({ duration: 150 })}
			>
				<Plus />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Fit to view"
				onClick={() =>
					flow.fitView({ padding: 0.12, maxZoom: 1, duration: 250 })
				}
			>
				<Maximize />
			</Button>
		</div>
	);
}
