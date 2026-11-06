import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import { EnvDot } from "@/components/projects/env-color";
import { VariablesEditor } from "@/components/service/env-editor";
import { SlidingTabs } from "@/components/sliding-tabs";
import { Button } from "@/components/ui/button";
import { projectQuery } from "@/lib/api/projects";
import {
	type SharedScope,
	useReplaceVariables,
	variablesQuery,
} from "@/lib/api/variables";

export const Route = createFileRoute("/_app/projects/$projectId/variables")({
	staticData: { crumb: "Variables" },
	validateSearch: z.object({
		env: z.string().startsWith("env_").optional().catch(undefined),
	}),
	component: ProjectVariables,
});

function ScopeEditor({
	scope,
	scopeId,
	name,
}: {
	scope: SharedScope;
	scopeId: string;
	name: string;
}) {
	const { data } = useQuery(variablesQuery(scope, scopeId));
	const replace = useReplaceVariables(scope, scopeId);
	if (!data)
		return (
			<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
				<SkeletonRows rows={4} />
			</div>
		);
	return (
		<VariablesEditor
			title={scope === "project" ? "Every environment" : name}
			id={`${scope}-vars`}
			empty={
				scope === "project"
					? "None yet. Variables here reach every service in every environment of this project."
					: `None yet. Variables here reach every service in ${name} and win over the project's.`
			}
			vars={data}
			save={replace.mutateAsync}
			savedHint="Services pick them up on their next deployment."
		/>
	);
}

function ProjectVariables() {
	const { projectId } = Route.useParams();
	const { env: envParam } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: project } = useQuery(projectQuery(projectId));
	if (!project) return null;
	const env = project.environments.find((e) => e.id === envParam);
	const value = env?.id ?? "project";

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Shared variables"
				description={`Every service in ${project.name} inherits these. The most specific scope wins: a service's own variable over the environment's, the environment's over the project's, the project's over the organization's.`}
				actions={
					<Button variant="outline" asChild>
						<Link to="/settings/variables">
							<Building2 data-icon="inline-start" />
							Organization variables
						</Link>
					</Button>
				}
			/>
			<div className="mb-5 border-b">
				<SlidingTabs
					label="Scope"
					idPrefix="scope"
					value={value}
					onChange={(id) =>
						navigate({
							search: { env: id === "project" ? undefined : id },
							replace: true,
						})
					}
					items={[
						{ id: "project", label: "All environments" },
						...project.environments.map((e) => ({
							id: e.id,
							label: (
								<>
									<EnvDot env={e} />
									{e.name}
								</>
							),
						})),
					]}
				/>
			</div>
			<div
				id="scope-panel"
				role="tabpanel"
				aria-labelledby={`scope-tab-${value}`}
			>
				{env ? (
					<ScopeEditor
						key={env.id}
						scope="environment"
						scopeId={env.id}
						name={env.name}
					/>
				) : (
					<ScopeEditor
						key="project"
						scope="project"
						scopeId={projectId}
						name={project.name}
					/>
				)}
			</div>
		</Page>
	);
}
