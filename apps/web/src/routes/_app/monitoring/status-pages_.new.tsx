import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import {
	emptyPage,
	pageSteps,
	toPageInput,
} from "@/components/uptime/status-page-wizard";
import { Wizard } from "@/components/wizard/wizard";
import { useInvalidating } from "@/lib/api/networking";
import { projectsQuery } from "@/lib/api/projects";
import { monitorsQuery, uptimeApi } from "@/lib/api/uptime";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/monitoring/status-pages_/new")({
	staticData: { crumb: "New status page" },
	validateSearch: z.object({ step: stepParam }),
	component: NewStatusPage,
});

function NewStatusPage() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: projects } = useQuery(projectsQuery);
	const { data: monitors } = useQuery(monitorsQuery);
	const create = useInvalidating(uptimeApi.createPage, [["status-pages"]]);
	const steps = useMemo(
		() => pageSteps(false, projects ?? [], monitors ?? []),
		[projects, monitors],
	);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	if (!projects || !monitors) return null;
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="New status page"
				description="A public page with live status, 90 days of uptime and your incident history."
			/>
			<Wizard
				id="status-page-new"
				steps={steps}
				defaultValues={emptyPage}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Create status page"
				onComplete={async (v) => {
					const p = await create.mutateAsync(toPageInput(v));
					toast.success(`${p.title} is live`, {
						description: p.hostname
							? `${p.hostname} works once its DNS points here and the certificate is issued.`
							: `At /status/${p.slug}.`,
					});
					await navigate({ to: "/monitoring/status-pages" });
				}}
			/>
		</Page>
	);
}
