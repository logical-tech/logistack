import { UsageRange } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
	UsageRangePicker,
	UsageTable,
	UsageTiles,
	UsageTrend,
} from "@/components/monitoring/usage";
import { Page, PageHeader } from "@/components/page-header";
import { projectUsageQuery } from "@/lib/api/monitoring";
import { projectQuery } from "@/lib/api/projects";
import type { ServiceId } from "@/lib/api/types";

export const Route = createFileRoute("/_app/projects/$projectId/usage")({
	staticData: { crumb: "Usage" },
	validateSearch: z.object({
		range: UsageRange.optional().catch(undefined),
	}),
	component: ProjectUsagePage,
});

function ProjectUsagePage() {
	const { projectId } = Route.useParams();
	const { range = "24h" } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: project } = useQuery(projectQuery(projectId));
	const { data } = useQuery(projectUsageQuery(projectId, range));

	return (
		<Page className="max-w-6xl">
			<PageHeader
				title={project ? `${project.name} usage` : "Usage"}
				description="CPU and memory averaged over the range, network moved and current volume size, per environment and service."
				actions={
					<UsageRangePicker
						value={range}
						onChange={(r) =>
							navigate({
								search: { range: r === "24h" ? undefined : r },
								replace: true,
							})
						}
					/>
				}
			/>
			<div className="grid gap-8">
				<section aria-label="Totals and trend" className="grid gap-4">
					<UsageTiles totals={data?.totals} />
					<UsageTrend data={data} range={range} />
				</section>
				<section aria-labelledby="services-heading" className="grid gap-3">
					<h2 id="services-heading" className="text-md font-semibold">
						Environments and services
					</h2>
					<UsageTable
						label="Usage by environment and service"
						empty="This project has no environments."
						rows={data?.environments.map((e) => ({
							...e,
							sortName: e.name,
							name: e.name,
							children: e.services.map((s) => ({
								...s,
								sortName: s.name,
								name: (
									<Link
										to="/projects/$projectId/services/$serviceId/metrics"
										params={{ projectId, serviceId: s.id as ServiceId }}
										className="rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
									>
										{s.name}
									</Link>
								),
							})),
						}))}
					/>
				</section>
			</div>
		</Page>
	);
}
