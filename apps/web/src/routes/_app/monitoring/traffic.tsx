import { MetricRange } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { RangePicker } from "@/components/monitoring/host-charts";
import { MonitoringPage } from "@/components/monitoring/monitoring-page";
import { Panel, SkeletonRows } from "@/components/panel";
import {
	formatCount,
	formatMs,
	StatRow,
	TrafficCharts,
} from "@/components/projects/service-traffic";
import { trafficOverviewQuery } from "@/lib/api/traffic";
import type { ProjectId, ServiceId } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/monitoring/traffic")({
	staticData: { crumb: "Traffic" },
	validateSearch: z.object({
		range: MetricRange.optional().catch(undefined),
	}),
	component: TrafficPage,
});

function TrafficPage() {
	const { range = "24h" } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data } = useQuery(trafficOverviewQuery(range));
	const sum = (k: "requests" | "s5" | "pageviews") =>
		data?.series.reduce((a, p) => a + p[k], 0);
	const requests = sum("requests");
	const errors = sum("s5");

	return (
		<MonitoringPage section="traffic">
			<div className="grid gap-6">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<p className="text-sm text-muted-foreground">
						Every request through the proxy, for all services with a domain.
					</p>
					<RangePicker
						value={range}
						onChange={(r) => navigate({ search: { range: r } })}
					/>
				</div>
				{data && data.services.length === 0 ? (
					<EmptyState
						icon={Activity}
						title="No traffic yet"
						description="Requests to your services' domains appear here within two minutes of reaching the proxy."
					/>
				) : (
					<>
						<StatRow
							items={[
								{ label: "Requests", value: formatCount(requests) },
								{
									label: "Pageviews",
									value: formatCount(sum("pageviews")),
								},
								{
									label: "5xx errors",
									value:
										requests && errors !== undefined
											? `${((errors / requests) * 100).toFixed(2)}%`
											: "–",
									hint: `${formatCount(errors)} responses`,
								},
								{
									label: "Services",
									value: data ? String(data.services.length) : "–",
								},
								{
									label: "Peak rate",
									value: data
										? `${Math.max(0, ...data.series.map((p) => p.rps)).toFixed(1)}/s`
										: "–",
								},
							]}
						/>
						<TrafficCharts
							range={range}
							step={data?.step}
							series={data?.series}
						/>
						<Panel title="By service">
							{!data ? (
								<SkeletonRows rows={4} />
							) : (
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b text-xs text-muted-foreground">
											<th className="px-4 py-2 text-left font-medium">
												Service
											</th>
											<th className="px-4 py-2 text-right font-medium">
												Requests
											</th>
											<th className="hidden px-4 py-2 text-right font-medium sm:table-cell">
												Visitors
											</th>
											<th className="px-4 py-2 text-right font-medium">5xx</th>
											<th className="hidden px-4 py-2 text-right font-medium sm:table-cell">
												p95
											</th>
										</tr>
									</thead>
									<tbody className="divide-y">
										{data.services.map((s) => (
											<tr key={s.serviceId} className="hover:bg-muted/40">
												<td className="px-4 py-2.5">
													<Link
														to="/projects/$projectId/services/$serviceId/analytics"
														params={{
															projectId: s.projectId as ProjectId,
															serviceId: s.serviceId as ServiceId,
														}}
														className="font-medium underline-offset-2 hover:underline"
													>
														{s.name}
													</Link>
													<span className="ml-2 text-xs text-muted-foreground">
														{s.project}
													</span>
												</td>
												<td className="px-4 py-2.5 text-right tabular">
													{formatCount(s.requests)}
												</td>
												<td className="hidden px-4 py-2.5 text-right tabular sm:table-cell">
													{formatCount(s.visitors)}
												</td>
												<td
													className={cn(
														"px-4 py-2.5 text-right tabular",
														s.errorRate >= 0.01 && "text-bad-text",
													)}
												>
													{(s.errorRate * 100).toFixed(2)}%
												</td>
												<td className="hidden px-4 py-2.5 text-right tabular sm:table-cell">
													{formatMs(s.p95)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</Panel>
					</>
				)}
			</div>
		</MonitoringPage>
	);
}
