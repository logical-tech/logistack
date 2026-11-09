import { createFileRoute } from "@tanstack/react-router";
import { Page, PageHeader } from "@/components/page-header";
import { WorkloadGrid } from "@/components/work/workload/workload-grid";

export const Route = createFileRoute("/_app/work/workload")({
	staticData: { crumb: "Workload" },
	component: () => (
		<Page>
			<PageHeader
				title="Workload"
				description="Estimated hours of open tasks per person over the next six weeks, spread across each task's working days. Highlighted weeks are over capacity."
			/>
			<WorkloadGrid />
		</Page>
	),
});
