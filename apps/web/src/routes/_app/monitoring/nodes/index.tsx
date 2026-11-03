import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Server } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { MonitoringPage } from "@/components/monitoring/monitoring-page";
import {
	LabelChips,
	LiveUsage,
	RoleLabel,
} from "@/components/monitoring/node-parts";
import { SkeletonRows } from "@/components/panel";
import { NodeStatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { nodesQuery } from "@/lib/api/monitoring";
import { relativeTime } from "@/lib/format";

export const Route = createFileRoute("/_app/monitoring/nodes/")({
	staticData: { crumb: "Nodes" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(nodesQuery);
	},
	component: NodesList,
});

function NodesList() {
	const { data: nodes } = useQuery(nodesQuery);
	const sorted =
		nodes && [...nodes].sort((a, b) => a.hostname.localeCompare(b.hostname));

	return (
		<MonitoringPage section="nodes">
			{!sorted ? (
				<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
					<SkeletonRows rows={4} />
				</div>
			) : sorted.length === 0 ? (
				<EmptyState
					icon={Server}
					title="No servers yet"
					description="Add a server over SSH: LogiStack checks it, installs Docker, joins it to the swarm and starts the agent."
				>
					<Button asChild>
						<Link to="/monitoring/nodes/new">
							<Plus data-icon="inline-start" />
							Add server
						</Link>
					</Button>
				</EmptyState>
			) : (
				<ul className="t-reveal divide-y overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					{sorted.map((n) => (
						<li key={n.id}>
							<Link
								to="/monitoring/nodes/$nodeId"
								params={{ nodeId: n.id }}
								className="grid items-center gap-x-6 gap-y-3 px-4 py-3.5 transition-colors duration-(--duration-quick) outline-none hover:bg-muted/40 focus-visible:bg-muted/60 md:grid-cols-[minmax(0,1.2fr)_7rem_minmax(0,1.4fr)_9rem]"
							>
								<div className="flex min-w-0 items-start justify-between gap-3">
									<div className="min-w-0">
										<p className="truncate text-sm font-medium">{n.hostname}</p>
										<p className="truncate text-xs text-muted-foreground">
											<span className="font-mono">{n.address}</span> ·{" "}
											<RoleLabel node={n} />
										</p>
										<LabelChips labels={n.labels} className="mt-1.5" />
									</div>
									<NodeStatusLabel status={n.status} className="md:hidden" />
								</div>
								<NodeStatusLabel status={n.status} className="max-md:hidden" />
								<LiveUsage node={n} />
								<p className="text-xs text-muted-foreground tabular md:text-right">
									{n.agentVersion ? `Agent ${n.agentVersion}` : "No agent yet"}
									<br className="max-md:hidden" />
									<span className="md:hidden"> · </span>
									{n.lastSeenAt
										? `seen ${relativeTime(n.lastSeenAt)}`
										: "never seen"}
								</p>
							</Link>
						</li>
					))}
				</ul>
			)}
		</MonitoringPage>
	);
}
