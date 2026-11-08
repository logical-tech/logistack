import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import {
	pageSteps,
	pageValuesOf,
	toPageInput,
} from "@/components/uptime/status-page-wizard";
import { Wizard } from "@/components/wizard/wizard";
import { useInvalidating } from "@/lib/api/networking";
import { projectsQuery } from "@/lib/api/projects";
import { monitorsQuery, statusPagesQuery, uptimeApi } from "@/lib/api/uptime";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute(
	"/_app/monitoring/status-pages_/$pageId_/edit",
)({
	staticData: { crumb: "Edit status page" },
	validateSearch: z.object({ step: stepParam }),
	component: EditStatusPage,
});

function EditStatusPage() {
	const { pageId } = Route.useParams();
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: projects } = useQuery(projectsQuery);
	const { data: monitors } = useQuery(monitorsQuery);
	const { data: pages } = useQuery(statusPagesQuery);
	const page = pages?.find((p) => p.id === pageId);
	const update = useInvalidating(uptimeApi.updatePage, [["status-pages"]]);
	const steps = useMemo(
		() => pageSteps(true, projects ?? [], monitors ?? []),
		[projects, monitors],
	);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	if (!projects || !monitors || !page) return null;
	return (
		<Page className="max-w-5xl">
			<PageHeader title={`Edit ${page.title}`} />
			<Wizard
				id={`status-page-edit-${page.id}`}
				steps={steps}
				defaultValues={pageValuesOf(page)}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Save status page"
				onComplete={async (v) => {
					await update.mutateAsync({ id: page.id, json: toPageInput(v) });
					toast.success(`${v.title} saved`);
					await navigate({ to: "/monitoring/status-pages" });
				}}
			/>
		</Page>
	);
}
