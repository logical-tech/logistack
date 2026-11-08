import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import {
	emptyMonitor,
	monitorSteps,
	toInput,
} from "@/components/uptime/monitor-wizard";
import { Wizard } from "@/components/wizard/wizard";
import { useInvalidating } from "@/lib/api/networking";
import { pushTokenKey, uptimeApi } from "@/lib/api/uptime";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/monitoring/uptime_/new")({
	staticData: { crumb: "New monitor" },
	validateSearch: z.object({ step: stepParam }),
	component: NewMonitor,
});

function NewMonitor() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const qc = useQueryClient();
	const create = useInvalidating(uptimeApi.createMonitor, [
		["monitors"],
		["monitors", "suggestions"],
	]);
	const steps = useMemo(() => monitorSteps(false), []);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="New monitor"
				description="Check a site, port, DNS record or certificate from the outside, or hear from a cron job."
			/>
			<Wizard
				id="monitor-new"
				steps={steps}
				defaultValues={emptyMonitor}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Create monitor"
				onComplete={async (v) => {
					const m = await create.mutateAsync(toInput(v));
					if (m.pushToken) qc.setQueryData(pushTokenKey(m.id), m.pushToken);
					toast.success(`${m.name} created`, {
						description:
							v.kind === "push"
								? "Copy its push URL now; it is shown once."
								: "The first check runs within a few seconds.",
						icon: <Activity className="size-4" />,
					});
					await navigate({
						to: "/monitoring/uptime/$monitorId",
						params: { monitorId: m.id },
					});
				}}
			/>
		</Page>
	);
}
