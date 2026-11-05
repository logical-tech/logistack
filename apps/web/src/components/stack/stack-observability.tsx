import type { MetricRange } from "@logistack/contracts";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { MetricChart, seriesColor } from "@/components/charts/metric-chart";
import { TRIGGER } from "@/components/deployments-table";
import { RangePicker } from "@/components/monitoring/host-charts";
import { Panel, SkeletonRows } from "@/components/panel";
import { DeploymentStatusLabel } from "@/components/status";
import { serviceMetricsQuery } from "@/lib/api/monitoring";
import { deploymentsQuery } from "@/lib/api/service-ops";
import type { ProjectId, Service } from "@/lib/api/types";
import { relativeTime, shortImage } from "@/lib/format";
import { formatBytes, formatPct, toRows } from "@/lib/metrics";

/** Colour per container, by position in the stack; logs and charts share it. */
export const containerColors = (services: Service[]) =>
	new Map(services.map((s, i) => [s.name, seriesColor(i)]));

/** CPU and memory of every container on one time axis, one line each. */
export function StackResources({ services }: { services: Service[] }) {
	const [range, setRange] = useState<MetricRange>("24h");
	const results = useQueries({
		queries: services.map((s) => serviceMetricsQuery(s.id, range)),
	});
	const loaded = results.every((r) => r.data);
	const first = results[0]?.data;
	const window = first && { from: first.from, to: first.to };
	const rows = (key: "cpu" | "memUsed") =>
		loaded
			? toRows(
					services.map((s, i) => ({
						key: s.id,
						points: results[i]?.data?.points ?? [],
					})),
					(p) => p[key],
					first?.stepSec ?? 60,
				)
			: undefined;
	const series = services.map((s, i) => ({
		key: s.id,
		label: s.name,
		color: seriesColor(i),
	}));
	const shared = {
		range,
		window,
		series,
		height: 170,
		showLatest: false,
		empty: "No samples yet: no container of this stack has reported.",
	};
	return (
		<section aria-labelledby="stack-resources" className="min-w-0">
			<div className="mb-2.5 flex min-h-7 items-center justify-between gap-3">
				<h2
					id="stack-resources"
					className="text-sm font-semibold [font-stretch:100%]"
				>
					Resources
				</h2>
				<RangePicker value={range} onChange={setRange} />
			</div>
			<div className="grid gap-4 md:grid-cols-2">
				<MetricChart
					{...shared}
					title="CPU by container"
					rows={rows("cpu")}
					format={formatPct}
					detail="100% is one core"
				/>
				<MetricChart
					{...shared}
					title="Memory by container"
					rows={rows("memUsed")}
					format={formatBytes}
					axisFormat={(v) => formatBytes(v, true)}
				/>
			</div>
		</section>
	);
}

const ACTIVITY = 8;

/** The newest deployments of every container, as one feed. */
export function StackActivity({
	services,
	projectId,
}: {
	services: Service[];
	projectId: ProjectId;
}) {
	const results = useQueries({
		queries: services.map((s) => deploymentsQuery(s.id)),
	});
	const loading = results.some((r) => r.isPending);
	const feed = results
		.flatMap((r, i) =>
			(r.data ?? []).map((d) => ({ d, service: services[i] as Service })),
		)
		.sort((a, b) => b.d.createdAt.localeCompare(a.d.createdAt))
		.slice(0, ACTIVITY);

	return (
		<Panel title="Recent deployments" id="stack-activity">
			{loading ? (
				<SkeletonRows rows={4} />
			) : feed.length === 0 ? (
				<p className="px-4 py-6 text-sm text-muted-foreground">
					No container has been deployed yet.
				</p>
			) : (
				<ol className="divide-y">
					{feed.map(({ d, service }) => (
						<li
							key={d.id}
							className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 transition-colors duration-(--duration-quick) hover:bg-muted/40 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]"
						>
							<DeploymentStatusLabel
								status={d.status}
								className="text-[13px] max-sm:col-span-2"
							/>
							<div className="min-w-0 text-sm">
								<Link
									to="/projects/$projectId/services/$serviceId/deployments"
									params={{ projectId, serviceId: service.id }}
									search={{ d: d.id }}
									className="font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
								>
									{service.name}
								</Link>
								<span className="text-muted-foreground">
									{" "}
									· {TRIGGER[d.trigger]}
									{d.commitSha ? (
										<span className="font-mono text-xs">
											{" "}
											{d.commitSha.slice(0, 7)}
										</span>
									) : d.imageRef ? (
										<span className="font-mono text-xs">
											{" "}
											{shortImage(d.imageRef)}
										</span>
									) : null}
								</span>
								{d.error && (
									<span className="block truncate text-xs text-bad-text">
										{d.error}
									</span>
								)}
							</div>
							<time
								dateTime={d.createdAt}
								className="text-xs whitespace-nowrap text-muted-foreground"
							>
								{relativeTime(d.startedAt ?? d.createdAt)}
							</time>
						</li>
					))}
				</ol>
			)}
		</Panel>
	);
}
