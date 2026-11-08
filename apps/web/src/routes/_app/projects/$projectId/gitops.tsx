import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { GitopsStatus, GitopsWizard } from "@/components/projects/gitops";
import { gitopsQuery } from "@/lib/api/gitops";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/projects/$projectId/gitops")({
	validateSearch: z.object({ step: stepParam, edit: z.boolean().optional() }),
	staticData: { crumb: "GitOps" },
	component: GitopsPage,
});

function GitopsPage() {
	const { projectId } = Route.useParams();
	const { step, edit } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: link, isPending } = useQuery(gitopsQuery(projectId));
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id, edit: true }, replace }),
		[navigate],
	);
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="GitOps"
				description="The project follows a manifest in a git repository: a push that changes it applies it, and the history of the file is the history of the project."
			/>
			{!isPending &&
				(link && !edit && !step ? (
					<GitopsStatus
						projectId={projectId}
						link={link}
						onEdit={() => navigate({ search: { edit: true } })}
					/>
				) : (
					<GitopsWizard
						projectId={projectId}
						link={link ?? null}
						step={step}
						onStepChange={onStepChange}
					/>
				))}
		</Page>
	);
}
