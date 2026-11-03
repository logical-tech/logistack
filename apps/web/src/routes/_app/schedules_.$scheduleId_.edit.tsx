import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { ScheduleWizard } from "@/components/backups/schedule-wizard";
import { Page, PageHeader } from "@/components/page-header";
import { ApiError } from "@/lib/api";
import { scheduleQuery } from "@/lib/api/backups";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/schedules_/$scheduleId_/edit")({
	validateSearch: z.object({ step: stepParam }),
	loader: async ({ context, params }) => {
		try {
			const s = await context.queryClient.ensureQueryData(
				scheduleQuery(params.scheduleId),
			);
			return { crumb: `Edit ${s.name}` };
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
	component: EditSchedule,
});

function EditSchedule() {
	const { scheduleId } = Route.useParams();
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data } = useQuery(scheduleQuery(scheduleId));
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);
	if (!data) return null;
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title={`Edit ${data.name}`}
				description="Changes apply from the next run; history stays as it is."
			/>
			<ScheduleWizard schedule={data} step={step} onStepChange={onStepChange} />
		</Page>
	);
}
