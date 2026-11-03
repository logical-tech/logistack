import { Link } from "@tanstack/react-router";
import { Crown } from "lucide-react";
import { NodeStatusLabel } from "@/components/status";
import type { ClusterNode } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { formatBytes, formatPct, pct } from "@/lib/metrics";
import { cn } from "@/lib/utils";

/** A 0..100 reading as a thin bar; turns warn at 70 and bad at 85. */
export function UsageMeter({
	label,
	value,
	detail,
}: {
	label: string;
	value: number | null;
	detail?: string;
}) {
	const v = value ?? 0;
	const tone = v >= 85 ? "bg-bad" : v >= 70 ? "bg-warn" : "bg-foreground/70";
	return (
		<div className="grid min-w-0 gap-1" title={detail}>
			<div className="flex justify-between gap-2 text-2xs text-muted-foreground">
				<span>{label}</span>
				<span className="tabular text-foreground">{formatPct(value)}</span>
			</div>
			{detail && <span className="sr-only">{detail}</span>}
			<div
				aria-hidden
				className="h-1 overflow-hidden rounded-full bg-muted-foreground/12"
			>
				<div
					className={cn(
						"h-full rounded-full transition-[width] duration-(--duration-slow) ease-(--ease-smooth-out)",
						tone,
					)}
					style={{ width: `${Math.min(100, v)}%` }}
				/>
			</div>
		</div>
	);
}

/** CPU, memory and disk from the node's latest sample, or why there is none. */
export function LiveUsage({
	node,
	className,
}: {
	node: ClusterNode;
	className?: string;
}) {
	const s = node.live;
	if (!s)
		return (
			<p className={cn("text-xs text-muted-foreground", className)}>
				{node.lastSeenAt
					? `No samples since ${relativeTime(node.lastSeenAt)}.`
					: "No samples yet: the node's agent has not reported."}
			</p>
		);
	return (
		<div className={cn("grid grid-cols-3 gap-3", className)}>
			<UsageMeter
				label="CPU"
				value={s.cpu}
				detail={`load ${s.load1.toFixed(2)}`}
			/>
			<UsageMeter
				label="Memory"
				value={pct(s.memUsed, s.memTotal)}
				detail={`${formatBytes(s.memUsed)} of ${formatBytes(s.memTotal)}`}
			/>
			<UsageMeter
				label="Disk"
				value={pct(s.diskUsed, s.diskTotal)}
				detail={`${formatBytes(s.diskUsed)} of ${formatBytes(s.diskTotal)}`}
			/>
		</div>
	);
}

/** `ingress=true` reads as "ingress"; anything else as key=value. */
export function LabelChips({
	labels,
	className,
}: {
	labels: Record<string, string>;
	className?: string;
}) {
	const entries = Object.entries(labels);
	if (!entries.length) return null;
	return (
		<ul className={cn("flex flex-wrap gap-1", className)} aria-label="Labels">
			{entries.map(([k, v]) => (
				<li
					key={k}
					className="rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground"
				>
					{v === "true" ? (
						k
					) : (
						<>
							{k}
							<span className="text-muted-foreground/70">=</span>
							{v}
						</>
					)}
				</li>
			))}
		</ul>
	);
}

export function RoleLabel({ node }: { node: ClusterNode }) {
	return (
		<span className="inline-flex items-center gap-1 capitalize">
			{node.role}
			{node.leader && (
				<span className="inline-flex items-center gap-1 normal-case">
					<Crown className="size-3" strokeWidth={1.75} aria-hidden />
					leader
				</span>
			)}
		</span>
	);
}

/** Overview card: identity, state, labels, and live usage. The whole card opens the node. */
export function NodeCard({ node }: { node: ClusterNode }) {
	return (
		<Link
			to="/monitoring/nodes/$nodeId"
			params={{ nodeId: node.id }}
			className="group grid content-start gap-3 rounded-xl bg-card p-4 shadow-card ring-1 ring-border outline-none transition-[box-shadow] duration-(--duration-quick) hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<span className="block truncate text-sm font-medium">
						{node.hostname}
					</span>
					<span className="block truncate text-xs text-muted-foreground">
						<span className="font-mono">{node.address}</span> ·{" "}
						<RoleLabel node={node} />
					</span>
				</div>
				<NodeStatusLabel status={node.status} />
			</div>
			<LiveUsage node={node} />
			<div className="flex min-h-5 items-center justify-between gap-3 text-2xs text-muted-foreground">
				<LabelChips labels={node.labels} />
				<span className="ml-auto shrink-0 tabular">
					{node.agentVersion ? `agent ${node.agentVersion}` : "no agent"}
					{node.lastSeenAt && ` · ${relativeTime(node.lastSeenAt)}`}
				</span>
			</div>
		</Link>
	);
}
