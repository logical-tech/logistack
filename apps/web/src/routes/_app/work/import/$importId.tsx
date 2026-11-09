import { createFileRoute } from "@tanstack/react-router";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import { ImportRun } from "@/components/work/import/import-progress";
import { useWorkImport } from "@/lib/api/work-queries";

export const Route = createFileRoute("/_app/work/import/$importId")({
	staticData: { crumb: "Import" },
	component: ImportDetail,
});

function ImportDetail() {
	const { importId } = Route.useParams();
	const imp = useWorkImport(importId);
	return (
		<Page className="max-w-3xl">
			<PageHeader
				title={imp.data?.kind === "csv" ? "CSV import" : "ClickUp import"}
				description={
					imp.data
						? `Started ${new Date(imp.data.startedAt ?? imp.data.createdAt).toLocaleString()}`
						: undefined
				}
			/>
			{imp.isError ? (
				<p className="text-sm text-bad-text">{imp.error.message}</p>
			) : imp.data ? (
				<ImportRun imp={imp.data} />
			) : (
				<SkeletonRows rows={4} />
			)}
		</Page>
	);
}
