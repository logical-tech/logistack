import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { ScheduleWizard } from "@/components/backups/schedule-wizard";
import { Page, PageHeader } from "@/components/page-header";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/schedules_/new")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "New schedule" },
	component: NewSchedule,
});

function NewSchedule() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="New schedule"
				description="A script on a cron. Every run keeps its exit code, duration and output."
			/>
			<ScheduleWizard step={step} onStepChange={onStepChange} />
		</Page>
	);
}
