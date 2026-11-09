import type { MapEdge, MapNode, NetworkMap } from "@logistack/contracts";
import { Link } from "@tanstack/react-router";
import {
	Background,
	BackgroundVariant,
	type Edge,
	getNodesBounds,
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
	Box,
	Cable,
	Cloud,
	Database,
	Folder,
	Globe,
	HardDrive,
	Layers,
	Lock,
	type LucideIcon,
	Maximize,
	Minus,
	Network,
	Plug,
	Plus,
	Server,
	Shuffle,
} from "lucide-react";
import { memo, type ReactNode, useMemo, useRef, useState } from "react";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { DOMAIN_STATUS, SERVICE_STATUS, type StatusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

type Drawn = Exclude<MapNode, { type: "task" }>;
type Task = Extract<MapNode, { type: "task" }>;
type Exposure = "proxy" | "tunnel" | "port";

const SIZE: Record<Drawn["type"], { w: number; h: number }> = {
	internet: { w: 168, h: 52 },
	proxy: { w: 256, h: 56 },
	mesh: { w: 256, h: 56 },
	tunnel: { w: 256, h: 56 },
	domain: { w: 248, h: 52 },
	service: { w: 248, h: 84 },
};
/** Header height inside a group box. */
const LABEL = 28;

type CardData = {
	node: Drawn;
	/** Replicas, folded into their service card instead of drawn as nodes. */
	tasks: Task[];
	exposure: Exposure[];
};
type GroupData = {
	kind: "folder" | "env";
	label: string;
	sub?: string;
	width: number;
	height: number;
};
type MapFlowNode = Node<CardData, "card"> | Node<GroupData, "group">;

const KIND_ICON: Record<string, LucideIcon> = {
	application: Box,
	database: Database,
	compose: Layers,
	storage: HardDrive,
};

/** Swarm task states, read as the service statuses read. */
export function taskStatus(state: string): StatusMeta {
	if (state === "running") return { label: "Running", tone: "ok" };
	if (["failed", "rejected", "orphaned", "remove"].includes(state))
		return { label: state[0]?.toUpperCase() + state.slice(1), tone: "bad" };
	if (["shutdown", "complete"].includes(state))
		return {
			label: state === "complete" ? "Complete" : "Shut down",
			tone: "idle",
		};
	return {
		label: state[0]?.toUpperCase() + state.slice(1),
		tone: "busy",
		live: true,
	};
}

const TLS: Record<string, string> = {
	"http-01": "HTTPS · HTTP-01",
	"dns-01": "HTTPS · DNS-01",
	custom: "HTTPS · custom cert",
	none: "HTTP only",
};

type Slot = { w: number; h: number; place: (x: number, y: number) => void };

/** Shelf packing: boxes left to right, wrapping at a width that keeps the result about `ratio`:1. */
function pack(items: Slot[], gap: number, ratio = 3, min = 0): Slot {
	const area = items.reduce((a, b) => a + (b.w + gap) * (b.h + gap), 0);
	const target = Math.max(
		min,
		...items.map((b) => b.w),
		Math.sqrt(area * ratio),
	);
	const shelves: { items: Slot[]; w: number; h: number }[] = [];
	for (const b of items) {
		const last = shelves.at(-1);
		if (last && last.w + gap + b.w <= target) {
			last.items.push(b);
			last.w += gap + b.w;
			last.h = Math.max(last.h, b.h);
		} else shelves.push({ items: [b], w: b.w, h: b.h });
	}
	return {
		w: Math.max(0, ...shelves.map((s) => s.w)),
		h: shelves.reduce((a, s) => a + s.h, 0) + gap * (shelves.length - 1),
		place: (x, y) => {
			for (const s of shelves) {
				let cx = x;
				for (const b of s.items) {
					b.place(cx, y);
					cx += b.w + gap;
				}
				y += s.h + gap;
			}
		},
	};
}

const PAD = 16;
const GAP = 24;
/** Vertical room between a domain and its service, and between rows of the tree. */
const DROP = 40;
const ROW = 72;

type Tree = {
	id: string;
	data: Omit<GroupData, "width" | "height">;
	children: Map<string, Tree>;
	services: Extract<Drawn, { type: "service" }>[];
};

/**
 * A tree from the Internet down: the Internet, the entry points, then folder, subfolder and
 * environment boxes. Inside an environment each service is a column with its domains above it.
 */
function lay(map: NetworkMap) {
	const tasks = new Map<string, Task[]>();
	const domains = new Map<string, Extract<Drawn, { type: "domain" }>[]>();
	const exposure = new Map<string, Set<Exposure>>();
	const entries: Drawn[] = [];
	const root: Tree = {
		id: "",
		data: { kind: "folder", label: "" },
		children: new Map(),
		services: [],
	};
	const groupOf = (n: Extract<Drawn, { folders: unknown }>) => {
		let at = root;
		for (const f of n.folders) {
			const id = `folder:${f.id}`;
			let next = at.children.get(id);
			if (!next) {
				next = {
					id,
					data: { kind: "folder", label: f.name },
					children: new Map(),
					services: [],
				};
				at.children.set(id, next);
			}
			at = next;
		}
		const id = `env:${n.environmentId}`;
		let env = at.children.get(id);
		if (!env) {
			env = {
				id,
				data: { kind: "env", label: n.projectName, sub: n.environmentName },
				children: new Map(),
				services: [],
			};
			at.children.set(id, env);
		}
		return env;
	};
	for (const n of map.nodes) {
		if (n.type === "task")
			tasks.set(n.serviceId, [...(tasks.get(n.serviceId) ?? []), n]);
		else if (n.type === "domain")
			domains.set(n.serviceId, [...(domains.get(n.serviceId) ?? []), n]);
		else if (n.type === "service") groupOf(n).services.push(n);
		else entries.push(n);
	}
	for (const e of map.edges)
		if (e.target.startsWith("service:") && e.via !== "internal") {
			const set = exposure.get(e.target) ?? new Set();
			set.add(e.via as Exposure);
			exposure.set(e.target, set);
		}

	const nodes: MapFlowNode[] = [];
	const card = (n: Drawn, x: number, y: number) => {
		const { w, h } = SIZE[n.type];
		const exp = [...(exposure.get(n.id) ?? [])];
		nodes.push({
			id: n.id,
			type: "card",
			position: { x, y },
			width: w,
			height: h,
			data: {
				node: n,
				tasks: n.type === "service" ? (tasks.get(n.serviceId) ?? []) : [],
				exposure: exp,
			},
			ariaLabel: label(n, exp),
			// Above every edge, so lines pass behind cards rather than across them.
			zIndex: 2,
		});
	};

	const measure = (t: Tree, depth: number): Slot => {
		let inner: Slot;
		if (t.data.kind === "env") {
			const dw = SIZE.domain.w;
			const top = t.services.some((s) => domains.get(s.serviceId)?.length)
				? SIZE.domain.h + DROP
				: 0;
			inner = pack(
				t.services.map((s) => {
					const ds = domains.get(s.serviceId) ?? [];
					const w = Math.max(SIZE.service.w, ds.length * (dw + GAP) - GAP);
					return {
						w,
						h: top + SIZE.service.h,
						place: (x, y) => {
							const dx = x + (w - (ds.length * (dw + GAP) - GAP)) / 2;
							for (const [i, d] of ds.entries())
								card(d, dx + i * (dw + GAP), y);
							card(s, x + (w - SIZE.service.w) / 2, y + top);
						},
					};
				}),
				GAP,
				3,
				// Up to four services side by side before an environment wraps.
				4 * (SIZE.service.w + GAP),
			);
		} else {
			const kids = [...t.children.values()].sort(
				(a, b) =>
					Number(a.data.kind === "env") - Number(b.data.kind === "env") ||
					a.data.label.localeCompare(b.data.label) ||
					(a.data.sub ?? "").localeCompare(b.data.sub ?? ""),
			);
			inner = pack(
				kids.map((k) => measure(k, depth + 1)),
				t === root ? GAP * 2 : GAP,
			);
		}
		if (t === root) return inner;
		const w = inner.w + PAD * 2;
		const h = inner.h + LABEL + PAD * 2;
		return {
			w,
			h,
			place: (x, y) => {
				nodes.push({
					id: t.id,
					type: "group",
					position: { x, y },
					data: { ...t.data, width: w, height: h },
					width: w,
					height: h,
					selectable: false,
					draggable: false,
					focusable: false,
					// Outer boxes first so inner ones paint over them.
					zIndex: -10 + depth,
				});
				inner.place(x + PAD, y + LABEL + PAD);
			},
		};
	};

	const body = measure(root, -1);
	const order: Drawn["type"][] = ["proxy", "tunnel", "mesh"];
	const row = entries
		.filter((n) => n.type !== "internet")
		.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
	const rowW = row.reduce((a, n) => a + SIZE[n.type].w + GAP * 2, -GAP * 2);
	const width = Math.max(body.w, rowW, SIZE.internet.w);
	const internet = entries.find((n) => n.type === "internet");
	let y = 0;
	if (internet) {
		card(internet, (width - SIZE.internet.w) / 2, y);
		y += SIZE.internet.h + ROW;
	}
	if (row.length) {
		let x = (width - rowW) / 2;
		for (const n of row) {
			card(n, x, y);
			x += SIZE[n.type].w + GAP * 2;
		}
		y += Math.max(...row.map((n) => SIZE[n.type].h)) + ROW;
	}
	body.place((width - body.w) / 2, y);
	return nodes;
}

const EXPOSURE: Record<
	Exposure | "private",
	{ label: string; icon: LucideIcon; className: string }
> = {
	proxy: {
		label: "Public",
		icon: Globe,
		className: "bg-ok/10 text-ok-text ring-ok/25",
	},
	tunnel: {
		label: "Tunnel",
		icon: Cable,
		className: "bg-info/10 text-info-text ring-info/25",
	},
	port: {
		label: "Port",
		icon: Plug,
		className: "bg-warn/10 text-warn-text ring-warn/25",
	},
	private: {
		label: "Private",
		icon: Lock,
		className: "bg-muted text-muted-foreground ring-border",
	},
};

function label(n: Drawn, exposure: Exposure[]): string {
	switch (n.type) {
		case "internet":
			return "Internet";
		case "proxy":
			return "Caddy ingress proxy";
		case "mesh":
			return "Swarm routing mesh";
		case "tunnel":
			return `Cloudflare Tunnel ${n.name}`;
		case "domain":
			return `Domain ${n.hostname}, ${n.tunnel ? "through a tunnel" : "public"}`;
		case "service":
			return `Service ${n.name}, ${SERVICE_STATUS[n.status].label}, ${
				exposure.length
					? exposure.map((e) => EXPOSURE[e].label).join(", ")
					: "private"
			}`;
	}
}

/** Everything upstream and downstream of `id`: the paths traffic takes to and from it. */
function path(edges: MapEdge[], id: string) {
	const seen = new Set([id]);
	for (const [from, to] of [
		["source", "target"],
		["target", "source"],
	] as const) {
		const queue = [id];
		while (queue.length) {
			const at = queue.pop();
			for (const e of edges)
				if (e[from] === at && !seen.has(e[to])) {
					seen.add(e[to]);
					queue.push(e[to]);
				}
		}
	}
	return seen;
}

const EDGE_STYLE: Record<MapEdge["via"], { stroke: string; dash?: string }> = {
	proxy: { stroke: "var(--muted-foreground)" },
	tunnel: { stroke: "var(--info)", dash: "6 4" },
	port: { stroke: "var(--warn)", dash: "2 4" },
	internal: { stroke: "var(--muted-foreground)" },
};

const HANDLE = "!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent";

function Shell({
	children,
	selected,
	className,
	tone,
}: {
	children: ReactNode;
	selected: boolean;
	className?: string;
	tone?: "bad";
}) {
	return (
		<div
			className={cn(
				"group/card relative flex h-full items-center gap-2.5 rounded-lg bg-card px-3 text-sm shadow-card ring-1 transition-[box-shadow] duration-(--duration-quick)",
				selected
					? "ring-2 ring-brand"
					: tone === "bad"
						? "ring-bad/60"
						: "ring-border",
				className,
			)}
		>
			<Handle
				type="target"
				position={Position.Top}
				isConnectable={false}
				className={HANDLE}
			/>
			{children}
			<Handle
				type="source"
				position={Position.Bottom}
				isConnectable={false}
				className={HANDLE}
			/>
		</div>
	);
}

function Glyph({
	icon: Icon,
	className,
}: {
	icon: LucideIcon;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground",
				className,
			)}
		>
			<Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
		</span>
	);
}

/** The arrow that leaves the map for the node's own page. */
function Open({ children, title }: { children: ReactNode; title: string }) {
	return (
		<Button
			variant="ghost"
			size="icon-xs"
			asChild
			title={title}
			className="nodrag -mr-1.5 shrink-0 text-muted-foreground opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 [.selected_&]:opacity-100"
		>
			{children}
		</Button>
	);
}

function Lines({ title, sub }: { title: ReactNode; sub: ReactNode }) {
	return (
		<div className="min-w-0 flex-1 leading-tight">
			<p className="truncate font-medium">{title}</p>
			<p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>
		</div>
	);
}

function Badge({
	kind,
	extra,
}: {
	kind: Exposure | "private";
	extra?: string;
}) {
	const e = EXPOSURE[kind];
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium ring-1 ring-inset",
				e.className,
			)}
		>
			<e.icon className="size-3" strokeWidth={2} aria-hidden />
			{e.label}
			{extra && <span className="tabular opacity-80">{extra}</span>}
		</span>
	);
}

/** One dot per replica, titled with the node it runs on. */
function Replicas({ tasks }: { tasks: Task[] }) {
	if (!tasks.length) return null;
	const hosts = [...new Set(tasks.map((t) => t.hostname ?? "unknown"))];
	return (
		<span
			className="ml-auto inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
			title={tasks
				.map(
					(t) =>
						`#${t.slot ?? "?"} on ${t.hostname ?? "an unknown node"}: ${taskStatus(t.state).label}${t.error ? ` (${t.error})` : ""}`,
				)
				.join("\n")}
		>
			<span className="inline-flex gap-0.5">
				{tasks.slice(0, 6).map((t) => (
					<StatusDot
						key={t.id}
						meta={taskStatus(t.state)}
						className="size-1.5 [&>span]:size-1.5"
					/>
				))}
			</span>
			<Server className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
			<span className="truncate">
				{hosts.length > 2 ? `${hosts.length} nodes` : hosts.join(", ")}
			</span>
		</span>
	);
}

const Card = memo(function Card({ data, selected }: NodeProps<Node<CardData>>) {
	const n = data.node;
	switch (n.type) {
		case "internet":
			return (
				<Shell
					selected={selected}
					className="justify-center rounded-full bg-gradient-to-b from-card to-muted/60 px-4"
				>
					<Cloud
						className="size-5 shrink-0 text-foreground"
						strokeWidth={1.5}
						aria-hidden
					/>
					<span className="font-semibold">Internet</span>
				</Shell>
			);
		case "proxy":
			return (
				<Shell selected={selected}>
					<Glyph icon={Shuffle} className="bg-ok/10 text-ok-text" />
					<Lines title="Caddy ingress" sub="Load balancer · 80, 443 · TLS" />
					<Open title="All domains">
						<Link to="/domains" aria-label="Open domains">
							<ArrowUpRight />
						</Link>
					</Open>
				</Shell>
			);
		case "mesh":
			return (
				<Shell selected={selected}>
					<Glyph icon={Network} className="bg-warn/10 text-warn-text" />
					<Lines
						title="Swarm routing mesh"
						sub="Published ports, bypass Caddy"
					/>
				</Shell>
			);
		case "tunnel":
			return (
				<Shell selected={selected}>
					<Glyph icon={Cable} className="bg-info/10 text-info-text" />
					<Lines title="Cloudflare Tunnel" sub={n.name} />
					<Open title="Cloudflare Tunnels">
						<Link
							to="/integrations/tunnels"
							aria-label="Open Cloudflare Tunnels"
						>
							<ArrowUpRight />
						</Link>
					</Open>
				</Shell>
			);
		case "domain": {
			const status = DOMAIN_STATUS[n.status];
			return (
				<Shell
					selected={selected}
					tone={n.status === "error" ? "bad" : undefined}
				>
					<Glyph
						icon={n.tunnel ? Cable : Globe}
						className={
							n.tunnel ? "bg-info/10 text-info-text" : "bg-ok/10 text-ok-text"
						}
					/>
					<Lines
						title={
							<span title={n.hostname + (n.pathPrefix ?? "")}>
								{n.hostname}
								{n.pathPrefix && (
									<span className="text-muted-foreground">{n.pathPrefix}</span>
								)}
							</span>
						}
						sub={
							<span className="inline-flex items-center gap-1.5">
								<StatusDot
									meta={status}
									className="size-1.5 [&>span]:size-1.5"
								/>
								{TLS[n.tls]}
							</span>
						}
					/>
					<Open title="Domains of this service">
						<Link
							to="/projects/$projectId/services/$serviceId/domains"
							params={{ projectId: n.projectId, serviceId: n.serviceId }}
							aria-label={`Open domains of ${n.hostname}'s service`}
						>
							<ArrowUpRight />
						</Link>
					</Open>
				</Shell>
			);
		}
		case "service": {
			const status = SERVICE_STATUS[n.status];
			const ports = n.ports
				.map((p) => `${p.published}${p.protocol === "udp" ? "/udp" : ""}`)
				.join(" ");
			return (
				<Shell
					selected={selected}
					tone={status.tone === "bad" ? "bad" : undefined}
					className="flex-col items-stretch justify-center gap-2 py-2.5"
				>
					<div className="flex items-center gap-2.5">
						<Glyph icon={KIND_ICON[n.kind] ?? Box} />
						<Lines
							title={n.name}
							sub={
								<span className="inline-flex items-center gap-1.5">
									<StatusDot
										meta={status}
										className="size-1.5 [&>span]:size-1.5"
									/>
									<span>
										{status.label}
										<span className="tabular">
											{" "}
											{n.replicasRunning}/{n.replicasDesired}
										</span>
										{n.mounts > 0 &&
											` · ${n.mounts} mount${n.mounts === 1 ? "" : "s"}`}
									</span>
								</span>
							}
						/>
						<Open title="Open service">
							<Link
								to="/projects/$projectId/services/$serviceId"
								params={{ projectId: n.projectId, serviceId: n.serviceId }}
								aria-label={`Open ${n.name}`}
							>
								<ArrowUpRight />
							</Link>
						</Open>
					</div>
					<div className="flex min-w-0 items-center gap-1">
						{data.exposure.length ? (
							data.exposure.map((e) => (
								<Badge
									key={e}
									kind={e}
									extra={e === "port" ? `:${ports}` : undefined}
								/>
							))
						) : (
							<Badge kind="private" />
						)}
						<Replicas tasks={data.tasks} />
					</div>
				</Shell>
			);
		}
	}
});

function Group({ data }: NodeProps<Node<GroupData>>) {
	const env = data.kind === "env";
	const Icon = env ? Layers : Folder;
	return (
		<div
			className={cn(
				env
					? "rounded-xl bg-muted/40 ring-1 ring-border/80 ring-inset dark:bg-muted/25"
					: "rounded-2xl border border-border border-dashed bg-muted/15 dark:bg-muted/10",
			)}
			style={{ width: data.width, height: data.height }}
		>
			<p
				className="flex items-center gap-1.5 truncate px-3.5 text-xs text-muted-foreground"
				style={{ height: LABEL }}
			>
				<Icon className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
				<span className="truncate font-medium text-foreground/80">
					{data.label}
				</span>
				{data.sub && (
					<span className="truncate rounded-full bg-card px-1.5 py-px ring-1 ring-border">
						{data.sub}
					</span>
				)}
			</p>
		</div>
	);
}

const nodeTypes = { card: Card, group: Group };

/** The Internet at the top, entry points below it, then folders, environments, domains and services. */
export function NetworkMapCanvas({
	map,
	toolbar,
}: {
	map: NetworkMap;
	/** Filters and counts, laid out in the bar above the canvas next to the zoom controls. */
	toolbar: ReactNode;
}) {
	return (
		<ReactFlowProvider>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
					{toolbar}
					<ZoomControls />
				</div>
				<Canvas map={map} />
			</div>
		</ReactFlowProvider>
	);
}

function Canvas({ map }: { map: NetworkMap }) {
	const laid = useMemo(() => lay(map), [map]);
	// Remount on a new layout (filter, search, refetch with new shape) so the first view is set again.
	const key = laid.map((n) => n.id).join("|");
	return <Flow key={key} laid={laid} edges={map.edges} />;
}

function Flow({ laid, edges }: { laid: MapFlowNode[]; edges: MapEdge[] }) {
	const [nodes, , onNodesChange] = useNodesState(laid);
	const [hovered, setHovered] = useState<string>();
	const ref = useRef<HTMLDivElement>(null);
	const active = nodes.find((n) => n.selected)?.id ?? hovered;
	const lit = useMemo(
		() => (active ? path(edges, active) : undefined),
		[edges, active],
	);
	const styled = useMemo<Edge[]>(
		() =>
			edges.map((e) => {
				const on = lit?.has(e.source) && lit.has(e.target);
				const s = EDGE_STYLE[e.via];
				return {
					id: e.id,
					source: e.source,
					target: e.target,
					type: "default",
					zIndex: on ? 1 : 0,
					style: {
						stroke:
							on && e.via !== "tunnel" && e.via !== "port"
								? "var(--brand)"
								: s.stroke,
						strokeDasharray: s.dash,
						strokeWidth: on ? 1.75 : 1.25,
						opacity: !lit ? 0.35 : on ? 1 : 0.08,
						transition:
							"opacity var(--duration-quick), stroke var(--duration-quick)",
					},
				};
			}),
		[edges, lit],
	);
	const shown = useMemo(
		() =>
			lit
				? nodes.map((n) =>
						n.type === "group" || lit.has(n.id)
							? n
							: {
									...n,
									style: {
										opacity: 0.4,
										transition: "opacity var(--duration-quick)",
									},
								},
					)
				: nodes,
		[nodes, lit],
	);
	return (
		<div ref={ref} className="relative min-h-0 flex-1 bg-background">
			<ReactFlow<MapFlowNode>
				nodes={shown}
				edges={styled}
				nodeTypes={nodeTypes}
				onNodesChange={onNodesChange}
				onNodeMouseEnter={(_, n) => n.type === "card" && setHovered(n.id)}
				onNodeMouseLeave={() => setHovered(undefined)}
				nodesConnectable={false}
				nodesDraggable={false}
				edgesFocusable={false}
				onInit={(flow) => {
					// Start readable from the top of the tree; the fit button shows all of it.
					const box = ref.current?.getBoundingClientRect();
					const b = getNodesBounds(laid);
					if (!box) return;
					const zoom = Math.min(1, Math.max(0.6, (box.width - 48) / b.width));
					flow.setViewport({
						x: (box.width - b.width * zoom) / 2 - b.x * zoom,
						y: 24 - b.y * zoom,
						zoom,
					});
				}}
				minZoom={0.1}
				maxZoom={1.75}
				proOptions={{ hideAttribution: true }}
				aria-label="Network map"
			>
				<Background
					variant={BackgroundVariant.Dots}
					gap={20}
					size={1}
					color="var(--border)"
				/>
			</ReactFlow>
			<Legend />
		</div>
	);
}

function Legend() {
	const item = (via: MapEdge["via"], text: string) => (
		<li className="flex items-center gap-2">
			<svg width="20" height="2" aria-hidden className="shrink-0">
				<line
					x1="0"
					y1="1"
					x2="20"
					y2="1"
					stroke={EDGE_STYLE[via].stroke}
					strokeDasharray={EDGE_STYLE[via].dash}
					strokeWidth="1.5"
				/>
			</svg>
			{text}
		</li>
	);
	return (
		<div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-2 rounded-lg bg-card/90 px-3 py-2.5 text-xs text-muted-foreground shadow-card ring-1 ring-border backdrop-blur-sm">
			<ul className="flex flex-col gap-1">
				{item("proxy", "Through Caddy")}
				{item("tunnel", "Through a Cloudflare Tunnel")}
				{item("port", "Published port, bypasses Caddy")}
			</ul>
			<ul className="flex flex-wrap gap-1">
				<li>
					<Badge kind="proxy" />
				</li>
				<li>
					<Badge kind="tunnel" />
				</li>
				<li>
					<Badge kind="port" />
				</li>
				<li>
					<Badge kind="private" />
				</li>
			</ul>
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
					flow.fitView({ padding: 0.08, maxZoom: 1, duration: 250 })
				}
			>
				<Maximize />
			</Button>
		</div>
	);
}
