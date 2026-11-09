import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { ClickUpWizard } from "@/components/work/import/clickup-wizard";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/work/import/clickup")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "ClickUp" },
	component: ImportClickUp,
});

function ImportClickUp() {
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
				title="Import from ClickUp"
				description="Spaces, lists, tasks, subtasks, checklists, fields, comments, attachments and time. Running it again updates what it brought over."
			/>
			<ClickUpWizard step={step} onStepChange={onStepChange} />
		</Page>
	);
}
