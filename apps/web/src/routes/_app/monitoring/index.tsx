import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Activity, Plus } from "lucide-react";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { HostCharts, RangePicker } from "@/components/monitoring/host-charts";
import { MonitoringPage } from "@/components/monitoring/monitoring-page";
import { NodeCard } from "@/components/monitoring/node-parts";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { hostMetricsQuery, nodesQuery } from "@/lib/api/monitoring";
import type { ClusterNode } from "@/lib/api/types";
import { rangeParam } from "@/lib/search";
import { NODE_STATUS, TONE_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/monitoring/")({
	validateSearch: z.object({
		range: rangeParam,
		view: z.enum(["cluster", "nodes"]).optional().catch(undefined),
	}),
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(nodesQuery);
	},
	component: Overview,
});

const byHostname = (a: ClusterNode, b: ClusterNode) =>
	a.hostname.localeCompare(b.hostname);

/** "5 nodes · 3 ready · 1 draining · 1 down", worst states last so the eye lands on them. */
function ClusterSummary({ nodes }: { nodes: ClusterNode[] }) {
	const counts = (["ready", "pending", "draining", "down"] as const)
		.map((s) => ({ s, n: nodes.filter((x) => x.status === s).length }))
		.filter((c) => c.n > 0);
	return (
		<p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
			<span className="text-foreground tabular">
				{nodes.length} {nodes.length === 1 ? "node" : "nodes"}
			</span>
			{counts.map(({ s, n }) => (
				<span key={s} className="inline-flex items-center gap-1.5 tabular">
					<span
						aria-hidden
						className={cn(
							"size-1.5 rounded-full",
							TONE_DOT[NODE_STATUS[s].tone],
						)}
					/>
					{n} {NODE_STATUS[s].label.toLowerCase()}
				</span>
			))}
		</p>
	);
}

function Overview() {
	const { range = "24h", view = "cluster" } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: nodes } = useQuery(nodesQuery);
	const perNode = view === "nodes";
	const { data: metrics } = useQuery(hostMetricsQuery({ range, perNode }));
	const sorted = nodes && [...nodes].sort(byHostname);

	if (nodes && nodes.length === 0) {
		return (
			<MonitoringPage section="overview">
				<EmptyState
					icon={Activity}
					title="Metrics start with the first agent report"
					description="Each server runs the LogiStack agent. Add one and its CPU, memory, disk and network appear here within a minute."
				>
					<Button asChild>
						<Link to="/monitoring/nodes/new">
							<Plus data-icon="inline-start" />
							Add server
						</Link>
					</Button>
				</EmptyState>
			</MonitoringPage>
		);
	}

	return (
		<MonitoringPage section="overview">
			<section aria-labelledby="cluster-heading" className="grid gap-4">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div className="grid gap-1">
						<h2 id="cluster-heading" className="text-md font-semibold">
							Cluster
						</h2>
						{sorted ? (
							<ClusterSummary nodes={sorted} />
						) : (
							<span className="t-skel h-4 w-56 rounded bg-muted-foreground/15" />
						)}
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Segmented
							label="Series"
							value={view}
							onChange={(v) =>
								navigate({
									search: (s) => ({
										...s,
										view: v === "cluster" ? undefined : v,
									}),
									replace: true,
								})
							}
							options={[
								{ value: "cluster", label: "Cluster" },
								{ value: "nodes", label: "Per node" },
							]}
						/>
						<RangePicker
							value={range}
							onChange={(r) =>
								navigate({
									search: (s) => ({ ...s, range: r === "24h" ? undefined : r }),
									replace: true,
								})
							}
						/>
					</div>
				</div>
				<HostCharts
					data={metrics}
					nodes={sorted}
					range={range}
					empty="No samples in this range: no node's agent has reported yet."
				/>
				{perNode && sorted && sorted.length > 4 && (
					<p className="text-xs text-muted-foreground">
						The first four nodes by name get a colour; the rest share grey. Open
						a node for its own charts.
					</p>
				)}
			</section>

			<section aria-labelledby="nodes-heading" className="mt-10 grid gap-3">
				<div className="flex items-center justify-between gap-3">
					<h2 id="nodes-heading" className="text-md font-semibold">
						Nodes
					</h2>
					<Button
						asChild
						variant="ghost"
						size="sm"
						className="text-muted-foreground"
					>
						<Link to="/monitoring/nodes">Manage nodes</Link>
					</Button>
				</div>
				{sorted ? (
					<ul className="t-reveal grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						{sorted.map((n) => (
							<li key={n.id} className="grid">
								<NodeCard node={n} />
							</li>
						))}
					</ul>
				) : (
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
						{[0, 1, 2].map((i) => (
							<div
								key={i}
								className="t-skel h-36 rounded-xl bg-muted-foreground/8"
							/>
						))}
					</div>
				)}
			</section>
		</MonitoringPage>
	);
}
