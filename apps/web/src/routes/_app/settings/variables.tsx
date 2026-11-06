import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import { VariablesEditor } from "@/components/service/env-editor";
import { useOrganization } from "@/lib/api/access";
import { useReplaceVariables, variablesQuery } from "@/lib/api/variables";

export const Route = createFileRoute("/_app/settings/variables")({
	staticData: { crumb: "Variables" },
	component: OrganizationVariables,
});

function Editor({ organizationId }: { organizationId: string }) {
	const { data } = useQuery(variablesQuery("organization", organizationId));
	const replace = useReplaceVariables("organization", organizationId);
	if (!data)
		return (
			<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
				<SkeletonRows rows={4} />
			</div>
		);
	return (
		<VariablesEditor
			title="Organization variables"
			id="organization-vars"
			empty="None yet. Good candidates: a log level, an error tracker DSN, a region. Anything a project, environment or service sets wins over these."
			vars={data}
			save={replace.mutateAsync}
			savedHint="Services pick them up on their next deployment."
		/>
	);
}

function OrganizationVariables() {
	const { data: org } = useOrganization();
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Variables"
				description="Every service in every project inherits these. A project, environment or service that sets the same name wins. Open a project to set variables for it or for one environment."
			/>
			{org ? (
				<Editor organizationId={org.id} />
			) : (
				<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
					<SkeletonRows rows={4} />
				</div>
			)}
		</Page>
	);
}
