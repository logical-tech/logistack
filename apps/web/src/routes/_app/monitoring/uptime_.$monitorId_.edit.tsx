import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import {
	monitorSteps,
	toInput,
	valuesOf,
} from "@/components/uptime/monitor-wizard";
import { Wizard } from "@/components/wizard/wizard";
import { useInvalidating } from "@/lib/api/networking";
import { monitorQuery, uptimeApi } from "@/lib/api/uptime";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute(
	"/_app/monitoring/uptime_/$monitorId_/edit",
)({
	staticData: { crumb: "Edit monitor" },
	validateSearch: z.object({ step: stepParam }),
	component: EditMonitor,
});

function EditMonitor() {
	const { monitorId } = Route.useParams();
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: m } = useQuery(monitorQuery(monitorId));
	const update = useInvalidating(uptimeApi.updateMonitor, [["monitors"]]);
	const steps = useMemo(() => monitorSteps(true), []);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	if (!m) return null;
	return (
		<Page className="max-w-5xl">
			<PageHeader title={`Edit ${m.name}`} />
			<Wizard
				id={`monitor-edit-${m.id}`}
				steps={steps}
				defaultValues={valuesOf(m)}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Save monitor"
				onComplete={async (v) => {
					const {
						domainId: _d,
						serviceId: _s,
						projectId: _p,
						...json
					} = toInput(v);
					await update.mutateAsync({ id: m.id, json });
					toast.success(`${v.name} saved`);
					await navigate({
						to: "/monitoring/uptime/$monitorId",
						params: { monitorId: m.id },
					});
				}}
			/>
		</Page>
	);
}
