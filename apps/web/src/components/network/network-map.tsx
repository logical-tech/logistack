import { Graph, layout } from "@dagrejs/dagre";
import type { MapEdge, MapNode, NetworkMap } from "@logistack/contracts";
import { Link } from "@tanstack/react-router";
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
	Box,
	Cloud,
	Database,
	Earth,
	Globe,
	HardDrive,
	Layers,
	type LucideIcon,
	Maximize,
	Minus,
	Plus,
	Server,
	Shuffle,
} from "lucide-react";
import { memo, type ReactNode, useMemo } from "react";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { DOMAIN_STATUS, SERVICE_STATUS, type StatusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

type Kind = MapNode["type"];
const SIZE: Record<Kind, { w: number; h: number }> = {
	internet: { w: 148, h: 48 },
	proxy: { w: 196, h: 52 },
	tunnel: { w: 212, h: 52 },
	domain: { w: 248, h: 52 },
	service: { w: 248, h: 64 },
	task: { w: 196, h: 40 },
};
/** dagre pads a cluster by about ¾ of `nodesep`, so the gap fits the environment's label above its cards. */
const NODESEP = 32;
const LABEL = 22;

type CardData = { node: MapNode };
type EnvData = { label: string; width: number; height: number };
type MapFlowNode = Node<CardData, "card"> | Node<EnvData, "env">;

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

/** dagre places it left to right; each environment is a cluster so its cards stay together. */
function lay(map: NetworkMap) {
	const g = new Graph({ compound: true });
	g.setGraph({
		rankdir: "LR",
		nodesep: NODESEP,
		ranksep: 72,
		marginx: 24,
		marginy: 24,
	});
	g.setDefaultEdgeLabel(() => ({}));
	const envs = new Map<string, string>();
	for (const n of map.nodes) {
		const s = SIZE[n.type];
		g.setNode(n.id, { width: s.w, height: s.h });
		if ("environmentId" in n) {
			const env = `env:${n.environmentId}`;
			if (!envs.has(env)) {
				envs.set(env, `${n.projectName} / ${n.environmentName}`);
				g.setNode(env, {});
			}
			g.setParent(n.id, env);
		}
	}
	for (const e of map.edges) g.setEdge(e.source, e.target);
	layout(g);

	const nodes: MapFlowNode[] = [];
	for (const [id, label] of envs) {
		const p = g.node(id);
		const { width, height } = p;
		nodes.push({
			id,
			type: "env",
			position: { x: p.x - width / 2, y: p.y - height / 2 },
			data: { label, width, height },
			width,
			height,
			selectable: false,
			draggable: false,
			focusable: false,
			zIndex: -1,
		});
	}
	for (const n of map.nodes) {
		const p = g.node(n.id);
		const { w, h } = SIZE[n.type];
		nodes.push({
			id: n.id,
			type: "card",
			position: { x: p.x - w / 2, y: p.y - h / 2 },
			width: w,
			height: h,
			data: { node: n },
			ariaLabel: label(n),
		});
	}
	return nodes;
}

function label(n: MapNode): string {
	switch (n.type) {
		case "internet":
			return "Internet";
		case "proxy":
			return "Caddy proxy";
		case "tunnel":
			return `Cloudflare Tunnel ${n.name}`;
		case "domain":
			return `Domain ${n.hostname}, ${n.tunnel ? "through a tunnel" : "public"}`;
		case "service":
			return `Service ${n.name}, ${SERVICE_STATUS[n.status].label}`;
		case "task":
			return `Task ${n.slot ?? ""} on ${n.hostname ?? "an unknown node"}, ${n.state}`;
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
	tunnel: { stroke: "var(--info)", dash: "5 4" },
	port: { stroke: "var(--warn)", dash: "2 4" },
	internal: { stroke: "var(--muted-foreground)" },
};

function Shell({
	children,
	selected,
	className,
	tone,
}: {
	children: ReactNode;
	selected: boolean;
	className?: string;
	tone?: "bad" | "warn";
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
				position={Position.Left}
				isConnectable={false}
				className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
			/>
			{children}
			<Handle
				type="source"
				position={Position.Right}
				isConnectable={false}
				className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
			/>
		</div>
	);
}

function Glyph({ icon: Icon }: { icon: LucideIcon }) {
	return (
		<span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
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

const Card = memo(function Card({ data, selected }: NodeProps<Node<CardData>>) {
	const n = data.node;
	switch (n.type) {
		case "internet":
			return (
				<Shell selected={selected}>
					<Glyph icon={Earth} />
					<Lines title="Internet" sub="Public traffic" />
				</Shell>
			);
		case "proxy":
			return (
				<Shell selected={selected}>
					<Glyph icon={Shuffle} />
					<Lines title="Caddy" sub="Ports 80, 443" />
					<Open title="All domains">
						<Link to="/domains" aria-label="Open domains">
							<ArrowUpRight />
						</Link>
					</Open>
				</Shell>
			);
		case "tunnel":
			return (
				<Shell selected={selected}>
					<Glyph icon={Cloud} />
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
					<Glyph icon={n.tunnel ? Cloud : Globe} />
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
								{n.tunnel ? "Tunnel" : "Public"} · {TLS[n.tls]}
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
				.map(
					(p) =>
						`${p.published}${p.protocol === "udp" ? "/udp" : ""}→${p.target}`,
				)
				.join(", ");
			return (
				<Shell
					selected={selected}
					tone={status.tone === "bad" ? "bad" : undefined}
				>
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
									{ports && <span className="text-warn-text"> · :{ports}</span>}
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
				</Shell>
			);
		}
		case "task": {
			const status = taskStatus(n.state);
			return (
				<Shell
					selected={selected}
					tone={status.tone === "bad" ? "bad" : undefined}
					className="gap-2 px-2.5 text-xs"
				>
					<Server
						className="size-3.5 shrink-0 text-muted-foreground"
						strokeWidth={1.75}
						aria-hidden
					/>
					<span
						className="min-w-0 flex-1 truncate"
						title={n.error ?? undefined}
					>
						{n.hostname ?? "Unknown node"}
						{n.slot !== null && (
							<span className="text-muted-foreground tabular"> #{n.slot}</span>
						)}
					</span>
					<span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
						<StatusDot meta={status} className="size-1.5 [&>span]:size-1.5" />
						{status.label}
					</span>
					{n.nodeId && (
						<Open title="Open node">
							<Link
								to="/monitoring/nodes/$nodeId"
								params={{ nodeId: n.nodeId }}
								aria-label={`Open node ${n.hostname}`}
							>
								<ArrowUpRight />
							</Link>
						</Open>
					)}
				</Shell>
			);
		}
	}
});

function Env({ data }: NodeProps<Node<EnvData>>) {
	return (
		<div
			className="rounded-xl bg-muted/35 ring-1 ring-border/70 ring-inset dark:bg-muted/20"
			style={{ width: data.width, height: data.height }}
		>
			<p
				className="truncate px-3.5 text-xs font-medium text-muted-foreground"
				style={{ lineHeight: `${LABEL}px` }}
			>
				{data.label}
			</p>
		</div>
	);
}

const nodeTypes = { card: Card, env: Env };

/** Internet to tasks, left to right, environments as quiet backdrops. */
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
	// Remount on a new layout (filter, search, refetch with new shape) so fitView runs again.
	const key = laid.map((n) => n.id).join("|");
	return <Flow key={key} laid={laid} edges={map.edges} />;
}

function Flow({ laid, edges }: { laid: MapFlowNode[]; edges: MapEdge[] }) {
	const [nodes, , onNodesChange] = useNodesState(laid);
	const active = nodes.find((n) => n.selected)?.id;
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
					type: "smoothstep",
					zIndex: on ? 1 : 0,
					style: {
						stroke:
							on && e.via !== "tunnel" && e.via !== "port"
								? "var(--brand)"
								: s.stroke,
						strokeDasharray: s.dash,
						strokeWidth: on ? 1.75 : 1.25,
						opacity: !lit ? 0.6 : on ? 1 : 0.15,
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
						n.type === "env" || lit.has(n.id)
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
		<div className="relative min-h-0 flex-1 bg-background">
			<ReactFlow<MapFlowNode>
				nodes={shown}
				edges={styled}
				nodeTypes={nodeTypes}
				onNodesChange={onNodesChange}
				nodesConnectable={false}
				nodesDraggable={false}
				edgesFocusable={false}
				fitView
				fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
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
		<ul className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-lg bg-card/90 px-3 py-2 text-xs text-muted-foreground shadow-card ring-1 ring-border backdrop-blur-sm">
			{item("proxy", "Through the proxy")}
			{item("tunnel", "Through a Cloudflare Tunnel")}
			{item("port", "Published port, bypasses the proxy")}
		</ul>
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
