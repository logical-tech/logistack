import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { SlidingTabs } from "@/components/sliding-tabs";
import { TimeReport } from "@/components/work/time/time-report";
import { WeekGrid } from "@/components/work/time/week-grid";
import { useMe } from "@/lib/api/access";

export const Route = createFileRoute("/_app/work/time")({
	staticData: { crumb: "Time" },
	validateSearch: z.object({
		tab: z.enum(["week", "report"]).optional().catch(undefined),
	}),
	component: TimePage,
});

function TimePage() {
	const tab = Route.useSearch().tab ?? "week";
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: me } = useMe();
	return (
		<Page>
			<PageHeader
				title="Time"
				description="Log hours by day, or report on tracked time across projects and people."
			/>
			<div className="mb-5 border-b">
				<SlidingTabs
					label="Time"
					idPrefix="time"
					value={tab}
					onChange={(id) =>
						navigate({
							search: { tab: id === "week" ? undefined : id },
							replace: true,
						})
					}
					items={[
						{ id: "week", label: "My week" },
						{ id: "report", label: "Report" },
					]}
				/>
			</div>
			<div id="time-panel" role="tabpanel" aria-labelledby={`time-tab-${tab}`}>
				{tab === "report" ? (
					<TimeReport />
				) : me ? (
					<WeekGrid userId={me.userId} />
				) : null}
			</div>
		</Page>
	);
}
