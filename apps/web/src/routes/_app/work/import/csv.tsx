import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { CsvWizard } from "@/components/work/import/csv-wizard";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/work/import/csv")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "CSV" },
	component: ImportCsv,
});

function ImportCsv() {
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
				title="Import a CSV"
				description="Rows become tasks in one list. Map each column once; the preview shows what comes through."
			/>
			<CsvWizard step={step} onStepChange={onStepChange} />
		</Page>
	);
}
