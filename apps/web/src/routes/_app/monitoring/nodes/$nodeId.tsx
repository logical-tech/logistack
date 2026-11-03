import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";
import { HostCharts, RangePicker } from "@/components/monitoring/host-charts";
import { NodeActions } from "@/components/monitoring/node-actions";
import {
	LabelChips,
	LiveUsage,
	RoleLabel,
} from "@/components/monitoring/node-parts";
import { Page, PageHeader } from "@/components/page-header";
import { NodeStatusLabel } from "@/components/status";
import { ApiError } from "@/lib/api";
import { hostMetricsQuery, nodeQuery } from "@/lib/api/monitoring";
import type { ClusterNode } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";
import { rangeParam } from "@/lib/search";

export const Route = createFileRoute("/_app/monitoring/nodes/$nodeId")({
	validateSearch: z.object({ range: rangeParam }),
	loader: async ({ context, params }) => {
		try {
			const node = await context.queryClient.ensureQueryData(
				nodeQuery(params.nodeId),
			);
			return { crumb: node.hostname };
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
	component: NodeDetail,
});

function Facts({ node }: { node: ClusterNode }) {
	const rows: [string, ReactNode][] = [
		[
			"Address",
			<span key="a" className="font-mono">
				{node.address}
			</span>,
		],
		["Role", <RoleLabel key="r" node={node} />],
		[
			"Availability",
			node.desired === "active"
				? "Active"
				: node.desired === "drain"
					? "Drained"
					: "Removing",
		],
		[
			"Resources",
			node.cpus || node.memoryBytes
				? [
						node.cpus && `${node.cpus} cores`,
						node.memoryBytes && formatBytes(node.memoryBytes),
					]
						.filter(Boolean)
						.join(" · ")
				: "Unknown until Swarm reports",
		],
		["Docker", node.engineVersion ?? "–"],
		["Agent", node.agentVersion ?? "Not installed"],
		["Last seen", node.lastSeenAt ? relativeTime(node.lastSeenAt) : "Never"],
		[
			"Labels",
			Object.keys(node.labels).length ? (
				<LabelChips key="l" labels={node.labels} />
			) : (
				<span key="l" className="text-muted-foreground">
					None
				</span>
			),
		],
	];
	return (
		<dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
			{rows.map(([k, v]) => (
				<div key={k} className="contents">
					<dt className="text-muted-foreground">{k}</dt>
					<dd className="min-w-0 tabular">{v}</dd>
				</div>
			))}
		</dl>
	);
}

function NodeDetail() {
	const { nodeId } = Route.useParams();
	const { range = "24h" } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: node } = useQuery(nodeQuery(nodeId));
	const { data: metrics } = useQuery(hostMetricsQuery({ range, nodeId }));
	if (!node) return null;

	return (
		<Page className="max-w-7xl">
			<PageHeader
				title={
					<span className="flex flex-wrap items-center gap-x-3 gap-y-1">
						{node.hostname}
						<NodeStatusLabel
							status={node.status}
							className="text-sm font-normal [font-stretch:100%]"
						/>
					</span>
				}
				description={
					<>
						<span className="font-mono">{node.address}</span> ·{" "}
						<RoleLabel node={node} />
						{node.agentVersion && ` · agent ${node.agentVersion}`}
					</>
				}
				actions={<NodeActions node={node} />}
			/>

			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
				<section
					aria-labelledby="node-charts"
					className="grid min-w-0 content-start gap-4"
				>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<h2 id="node-charts" className="text-md font-semibold">
							Usage
						</h2>
						<RangePicker
							value={range}
							onChange={(r) =>
								navigate({
									search: { range: r === "24h" ? undefined : r },
									replace: true,
								})
							}
						/>
					</div>
					<HostCharts
						data={metrics}
						nodes={[node]}
						range={range}
						empty={
							node.lastSeenAt
								? "No samples in this range."
								: "No samples yet: the node's agent has not reported."
						}
					/>
				</section>
				<aside className="grid content-start gap-4">
					<section
						aria-labelledby="node-now"
						className="grid gap-3 rounded-xl bg-card p-4 shadow-card ring-1 ring-border"
					>
						<h2 id="node-now" className="text-sm font-medium">
							Right now
						</h2>
						<LiveUsage node={node} />
					</section>
					<section
						aria-labelledby="node-facts"
						className="grid gap-3 rounded-xl bg-card p-4 shadow-card ring-1 ring-border"
					>
						<h2 id="node-facts" className="text-sm font-medium">
							Details
						</h2>
						<Facts node={node} />
					</section>
				</aside>
			</div>
		</Page>
	);
}
