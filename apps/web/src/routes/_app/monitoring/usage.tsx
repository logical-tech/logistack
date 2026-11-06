import { UsageRange } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { MonitoringPage } from "@/components/monitoring/monitoring-page";
import {
	UsageRangePicker,
	UsageTable,
	UsageTiles,
	UsageTrend,
} from "@/components/monitoring/usage";
import { usageQuery } from "@/lib/api/monitoring";
import type { ProjectId } from "@/lib/api/types";

export const Route = createFileRoute("/_app/monitoring/usage")({
	staticData: { crumb: "Usage" },
	validateSearch: z.object({
		range: UsageRange.optional().catch(undefined),
	}),
	component: OrganizationUsagePage,
});

function OrganizationUsagePage() {
	const { range = "24h" } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data } = useQuery(usageQuery(range));

	return (
		<MonitoringPage section="usage">
			<div className="grid gap-8">
				<section aria-labelledby="usage-heading" className="grid gap-4">
					<div className="flex flex-wrap items-end justify-between gap-3">
						<div className="grid gap-1">
							<h2 id="usage-heading" className="text-md font-semibold">
								Organization
							</h2>
							<p className="text-sm text-pretty text-muted-foreground">
								What your services consume, against the capacity of every node.
								Averages cover the whole range.
							</p>
						</div>
						<UsageRangePicker
							value={range}
							onChange={(r) =>
								navigate({
									search: { range: r === "24h" ? undefined : r },
									replace: true,
								})
							}
						/>
					</div>
					<UsageTiles totals={data?.totals} capacity={data?.capacity} />
					<UsageTrend data={data} range={range} />
				</section>
				<section aria-labelledby="projects-heading" className="grid gap-3">
					<h2 id="projects-heading" className="text-md font-semibold">
						Projects
					</h2>
					<UsageTable
						label="Usage by project"
						empty="No projects you can read."
						rows={data?.projects.map((p) => ({
							...p,
							sortName: p.name,
							name: (
								<Link
									to="/projects/$projectId/usage"
									params={{ projectId: p.id as ProjectId }}
									search={{ range: range === "24h" ? undefined : range }}
									className="rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
								>
									{p.name}
								</Link>
							),
						}))}
					/>
				</section>
			</div>
		</MonitoringPage>
	);
}
