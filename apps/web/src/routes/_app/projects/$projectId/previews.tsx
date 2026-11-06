import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { PreviewWizard } from "@/components/projects/preview-wizard";
import { previewSettingsQuery } from "@/lib/api/previews";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/projects/$projectId/previews")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "Preview deployments" },
	component: PreviewSettingsPage,
});

function PreviewSettingsPage() {
	const { projectId } = Route.useParams();
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: settings, isPending } = useQuery(
		previewSettingsQuery(projectId),
	);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Preview deployments"
				description="A live copy of the project for every pull request, with its own URL, removed when the pull request closes."
			/>
			{!isPending && (
				<PreviewWizard
					projectId={projectId}
					settings={settings ?? null}
					step={step}
					onStepChange={onStepChange}
				/>
			)}
		</Page>
	);
}
