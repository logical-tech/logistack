import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Boxes, Folder, Plus, Waypoints } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import { CreateEnvironmentDialog } from "@/components/projects/create-dialogs";
import { ServiceList } from "@/components/projects/service-list";
import { SignalStrip } from "@/components/signal-strip";
import { SlidingTabs } from "@/components/sliding-tabs";
import { Button } from "@/components/ui/button";
import { foldersQuery } from "@/lib/api/folders";
import { projectQuery } from "@/lib/api/projects";
import { servicesQuery } from "@/lib/api/services";
import { stacksQuery } from "@/lib/api/stacks";
import type { Environment, EnvironmentId, ProjectId } from "@/lib/api/types";

export const Route = createFileRoute("/_app/projects/$projectId/")({
	validateSearch: z.object({
		env: z.string().startsWith("env_").optional().catch(undefined),
	}),
	component: ProjectDetail,
});

function defaultEnv(envs: Environment[]) {
	return envs.find((e) => e.isDefault) ?? envs[0];
}

function EnvironmentServices({
	env,
	projectId,
}: {
	env: Environment;
	projectId: ProjectId;
}) {
	const { data: services } = useQuery(servicesQuery(env.id));
	const { data: stacks } = useQuery(stacksQuery(env.id));
	if (!services) {
		return (
			<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
				<SkeletonRows rows={4} />
			</div>
		);
	}
	if (services.length === 0) {
		return (
			<EmptyState
				icon={Boxes}
				title={`Nothing runs in ${env.name} yet`}
				description="Deploy from a Git repository or a Docker image, start a managed database, or paste a Compose file."
			>
				<Button asChild>
					<Link
						to="/projects/$projectId/services/new"
						params={{ projectId }}
						search={{ env: env.id }}
					>
						<Plus data-icon="inline-start" />
						New service
					</Link>
				</Button>
			</EmptyState>
		);
	}
	return (
		<div className="t-reveal">
			<ServiceList services={services} stacks={stacks} projectId={projectId} />
		</div>
	);
}

function ProjectDetail() {
	const { projectId } = Route.useParams();
	const { env: envParam } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: project } = useQuery(projectQuery(projectId));
	const { data: folders = [] } = useQuery(foldersQuery);
	const [creatingEnv, setCreatingEnv] = useState(false);

	if (!project) return null;
	const env =
		project.environments.find((e) => e.id === envParam) ??
		defaultEnv(project.environments);
	const folder = folders.find((f) => f.id === project.folderId);
	const parent = folders.find((f) => f.id === folder?.parentId);

	return (
		<Page className="max-w-6xl">
			<PageHeader
				title={project.name}
				description={
					<span className="flex flex-wrap items-center gap-x-3 gap-y-1">
						{folder && (
							<Link
								to="/projects"
								search={{ folder: folder.id }}
								className="inline-flex items-center gap-1 hover:text-foreground"
							>
								<Folder className="size-3.5" aria-hidden />
								{[parent?.name, folder.name].filter(Boolean).join(" / ")}
							</Link>
						)}
						{project.description}
					</span>
				}
				actions={
					env && (
						<>
							<Button variant="outline" asChild>
								<Link
									to="/network"
									search={{ project: projectId, env: env.id }}
								>
									<Waypoints data-icon="inline-start" />
									Network map
								</Link>
							</Button>
							<Button asChild>
								<Link
									to="/projects/$projectId/services/new"
									params={{ projectId }}
									search={{ env: env.id }}
								>
									<Plus data-icon="inline-start" />
									New service
								</Link>
							</Button>
						</>
					)
				}
			/>

			<CreateEnvironmentDialog
				open={creatingEnv}
				onOpenChange={setCreatingEnv}
				projectId={projectId}
				onCreated={(e) => navigate({ search: { env: e.id }, replace: true })}
			/>
			{env ? (
				<>
					<div className="mb-5 flex items-end gap-2 border-b">
						<SlidingTabs
							label="Environments"
							idPrefix="env"
							value={env.id}
							onChange={(id: EnvironmentId) =>
								navigate({ search: { env: id }, replace: true })
							}
							items={project.environments.map((e) => ({
								id: e.id,
								label: <EnvTabLabel env={e} />,
							}))}
						/>
						<Button
							variant="ghost"
							size="sm"
							className="mb-1.5 text-muted-foreground"
							onClick={() => setCreatingEnv(true)}
						>
							<Plus data-icon="inline-start" />
							New environment
						</Button>
					</div>
					<div
						id="env-panel"
						role="tabpanel"
						aria-labelledby={`env-tab-${env.id}`}
						key={env.id}
					>
						<EnvironmentServices env={env} projectId={projectId} />
					</div>
				</>
			) : (
				<EmptyState
					icon={Boxes}
					title="No environments"
					description="Every project needs at least one environment. Production is created with the project."
				>
					<Button onClick={() => setCreatingEnv(true)}>
						<Plus data-icon="inline-start" />
						New environment
					</Button>
				</EmptyState>
			)}
		</Page>
	);
}

function EnvTabLabel({ env }: { env: Environment }) {
	const { data: services } = useQuery(servicesQuery(env.id));
	return (
		<>
			{env.name}
			{services && services.length > 0 && (
				<SignalStrip
					size="sm"
					className="t-reveal flex-nowrap"
					services={services.map((s) => ({
						id: s.id,
						name: s.name,
						status: s.status.observed,
					}))}
				/>
			)}
		</>
	);
}
