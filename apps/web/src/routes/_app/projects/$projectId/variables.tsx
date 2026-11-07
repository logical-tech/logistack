import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import { EnvDot } from "@/components/projects/env-color";
import { SecretsPanel } from "@/components/secrets/secrets-panel";
import { Segmented } from "@/components/segmented";
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
	staticData: { crumb: "Secrets & variables" },
	validateSearch: z.object({
		tab: z.enum(["secrets", "variables"]).optional().catch(undefined),
		env: z.string().startsWith("env_").optional().catch(undefined),
	}),
	component: ProjectVariables,
});

function ScopeEditor({
	scope,
	scopeId,
	name,
	tab,
}: {
	scope: SharedScope;
	scopeId: string;
	name: string;
	tab: "secrets" | "variables";
}) {
	if (tab === "secrets")
		return (
			<SecretsPanel
				scope={scope}
				scopeId={scopeId}
				id={`${scope}-secrets`}
				title={scope === "project" ? "Project secrets" : `${name} secrets`}
				empty={
					scope === "project"
						? "None yet. Services in any environment of this project can reference a secret defined here."
						: `None yet. Services in ${name} can reference a secret defined here.`
				}
			/>
		);
	return <PlainEditor scope={scope} scopeId={scopeId} name={name} />;
}

function PlainEditor({
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
	const { env: envParam, tab = "secrets" } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: project } = useQuery(projectQuery(projectId));
	if (!project) return null;
	const env = project.environments.find((e) => e.id === envParam);
	const value = env?.id ?? "project";

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Secrets & variables"
				description={`Secrets defined here can be referenced by any service in ${project.name} below the scope that defines them. Plain variables reach every service; the most specific scope wins.`}
				actions={
					<Button variant="outline" asChild>
						<Link to="/settings/variables">
							<Building2 data-icon="inline-start" />
							Organization
						</Link>
					</Button>
				}
			/>
			<div className="mb-4 border-b">
				<SlidingTabs
					label="Kind"
					idPrefix="kind"
					value={tab}
					onChange={(id) =>
						navigate({
							search: (s) => ({ ...s, tab: id === "secrets" ? undefined : id }),
							replace: true,
						})
					}
					items={[
						{ id: "secrets", label: "Secrets" },
						{ id: "variables", label: "Variables" },
					]}
				/>
			</div>
			<div className="mb-5 overflow-x-auto">
				<Segmented
					label="Scope"
					value={value}
					onChange={(id) =>
						navigate({
							search: (s) => ({ ...s, env: id === "project" ? undefined : id }),
							replace: true,
						})
					}
					options={[
						{ value: "project", label: "Project" },
						...project.environments.map((e) => ({
							value: e.id,
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
			<div id="kind-panel" role="tabpanel" aria-labelledby={`kind-tab-${tab}`}>
				{env ? (
					<ScopeEditor
						key={env.id}
						scope="environment"
						scopeId={env.id}
						name={env.name}
						tab={tab}
					/>
				) : (
					<ScopeEditor
						key="project"
						scope="project"
						scopeId={projectId}
						name={project.name}
						tab={tab}
					/>
				)}
			</div>
		</Page>
	);
}
