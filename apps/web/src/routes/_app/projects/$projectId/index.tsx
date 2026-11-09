import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	Archive,
	ArchiveRestore,
	Boxes,
	Check,
	CopyPlus,
	Download,
	ExternalLink,
	FileUp,
	Folder,
	Gauge,
	GitBranch,
	GitPullRequest,
	MoreHorizontal,
	Plus,
	Settings2,
	Variable,
	Waypoints,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import { CreateEnvironmentDialog } from "@/components/projects/create-dialogs";
import { ENV_COLORS, EnvDot, envColor } from "@/components/projects/env-color";
import { PreviewPanel } from "@/components/projects/preview-panel";
import {
	ProjectSections,
	sectionPanel,
	useProjectPluginTabs,
	useSectionsShown,
} from "@/components/projects/project-sections";
import { ServiceList } from "@/components/projects/service-list";
import { SignalStrip } from "@/components/signal-strip";
import { SlidingTabs } from "@/components/sliding-tabs";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { foldersQuery } from "@/lib/api/folders";
import { gitopsQuery } from "@/lib/api/gitops";
import { downloadManifest } from "@/lib/api/manifest";
import {
	projectQuery,
	useSetArchived,
	useUpdateEnvironment,
} from "@/lib/api/projects";
import { servicesQuery } from "@/lib/api/services";
import { stacksQuery } from "@/lib/api/stacks";
import type {
	Environment,
	EnvironmentColor,
	EnvironmentId,
	ProjectId,
} from "@/lib/api/types";
import { GITOPS_STATUS } from "@/lib/status";

export const Route = createFileRoute("/_app/projects/$projectId/")({
	validateSearch: z.object({
		env: z.string().startsWith("env_").optional().catch(undefined),
	}),
	component: ProjectDetail,
});

function exportManifest(...args: Parameters<typeof downloadManifest>) {
	downloadManifest(...args).catch((e) =>
		toast.error("Couldn't export the manifest", {
			description: e instanceof Error ? e.message : undefined,
		}),
	);
}

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
	const { data: gitops } = useQuery(gitopsQuery(projectId));
	const [creatingEnv, setCreatingEnv] = useState(false);
	const [archiving, setArchiving] = useState(false);
	const pluginTabs = useProjectPluginTabs();
	const sectionsShown = useSectionsShown(pluginTabs);
	const setArchived = useSetArchived(projectId);
	const toggleArchived = (archived: boolean) =>
		setArchived.mutate(archived, {
			onSuccess: () => {
				setArchiving(false);
				toast.success(archived ? "Project archived" : "Project unarchived", {
					description: archived
						? "Its services are stopping. Unarchive to start them again."
						: "Services archiving stopped are starting again.",
				});
			},
			onError: (e) =>
				toast.error(archived ? "Couldn't archive" : "Couldn't unarchive", {
					description: e instanceof Error ? e.message : undefined,
				}),
		});

	if (!project) return null;
	const archived = project.archivedAt !== null;
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
						{gitops && (
							<Link
								to="/projects/$projectId/gitops"
								params={{ projectId }}
								className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground ring-1 ring-border transition-colors hover:bg-muted/70"
								title={`${gitops.repository}#${gitops.branch}: ${gitops.path}`}
							>
								{gitops.lastStatus === "failed" ? (
									<StatusDot meta={GITOPS_STATUS.failed} />
								) : (
									<GitBranch className="size-3.5" aria-hidden />
								)}
								{gitops.managed ? "Managed by git" : "Follows git"}
								{gitops.lastStatus === "failed" && (
									<span className="text-bad-text">sync failed</span>
								)}
							</Link>
						)}
						{project.description}
					</span>
				}
				actions={
					env && (
						<>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="outline"
										size="icon"
										aria-label="Project actions"
									>
										<MoreHorizontal />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-52">
									<DropdownMenuItem
										onSelect={() =>
											exportManifest(
												{ kind: "project", id: projectId },
												project.slug,
											)
										}
									>
										<Download />
										Export manifest
									</DropdownMenuItem>
									{!archived && (
										<DropdownMenuItem asChild>
											<Link
												to="/projects/$projectId/import"
												params={{ projectId }}
												search={{ env: env.id }}
											>
												<FileUp />
												Import manifest…
											</Link>
										</DropdownMenuItem>
									)}
									<DropdownMenuItem asChild>
										<Link
											to="/projects/$projectId/variables"
											params={{ projectId }}
										>
											<Variable />
											Secrets & variables
										</Link>
									</DropdownMenuItem>
									<DropdownMenuItem asChild>
										<Link
											to="/projects/$projectId/gitops"
											params={{ projectId }}
										>
											<GitBranch />
											GitOps…
										</Link>
									</DropdownMenuItem>
									<DropdownMenuItem asChild>
										<Link
											to="/projects/$projectId/previews"
											params={{ projectId }}
										>
											<GitPullRequest />
											Preview deployments…
										</Link>
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									{archived ? (
										<DropdownMenuItem
											disabled={setArchived.isPending}
											onSelect={() => toggleArchived(false)}
										>
											<ArchiveRestore />
											Unarchive project
										</DropdownMenuItem>
									) : (
										<DropdownMenuItem onSelect={() => setArchiving(true)}>
											<Archive />
											Archive project…
										</DropdownMenuItem>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
							<Button variant="outline" asChild>
								<Link to="/projects/$projectId/usage" params={{ projectId }}>
									<Gauge data-icon="inline-start" />
									Usage
								</Link>
							</Button>
							<Button variant="outline" asChild>
								<Link
									to="/network"
									search={{ project: projectId, env: env.id }}
								>
									<Waypoints data-icon="inline-start" />
									Network map
								</Link>
							</Button>
							{!archived && (
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
							)}
						</>
					)
				}
			/>
			<ProjectSections
				projectId={projectId}
				value="services"
				tabs={pluginTabs}
			/>
			<div {...sectionPanel(sectionsShown, "services")}>
				{archived && (
					<div
						role="status"
						className="mb-6 flex flex-col gap-3 rounded-xl bg-muted/50 px-4 py-3 ring-1 ring-border sm:flex-row sm:items-center sm:justify-between"
					>
						<div className="flex items-start gap-3">
							<Archive
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							<div className="text-sm">
								<p className="font-medium">This project is archived</p>
								<p className="text-pretty text-muted-foreground">
									Its services are stopped and deploys are paused. Data,
									configuration and replica counts are kept.
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							className="shrink-0"
							disabled={setArchived.isPending}
							onClick={() => toggleArchived(false)}
						>
							<ArchiveRestore data-icon="inline-start" />
							Unarchive
						</Button>
					</div>
				)}

				<ConfirmDialog
					open={archiving}
					onOpenChange={setArchiving}
					title={`Archive ${project.name}?`}
					description="Every running service stops and the project leaves the projects list. Nothing is deleted: unarchive to start the same services again at their replica counts."
					confirmLabel="Archive project"
					pending={setArchived.isPending}
					onConfirm={() => toggleArchived(true)}
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
							<EnvironmentMenu env={env} projectSlug={project.slug} />
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
							{env.preview && <PreviewPanel preview={env.preview} />}
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
			</div>
		</Page>
	);
}

function EnvTabLabel({ env }: { env: Environment }) {
	const { data: services } = useQuery(servicesQuery(env.id));
	return (
		<>
			<EnvDot env={env} />
			{env.name}
			{env.preview && (
				<span
					className="max-w-40 truncate font-normal text-muted-foreground"
					title={env.preview.title}
				>
					{env.preview.title}
				</span>
			)}
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

/** Color, default and export of the selected environment. */
function EnvironmentMenu({
	env,
	projectSlug,
}: {
	env: Environment;
	projectSlug: string;
}) {
	const update = useUpdateEnvironment();
	const save = (
		input: { color: EnvironmentColor } | { isDefault: true },
		done: string,
	) =>
		update.mutate(
			{ id: env.id, ...input },
			{
				onSuccess: () => toast.success(done),
				onError: (e) =>
					toast.error("Couldn't update the environment", {
						description: e instanceof Error ? e.message : undefined,
					}),
			},
		);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					className="mb-1.5 ml-auto text-muted-foreground"
					aria-label={`${env.name} settings`}
				>
					<Settings2 />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52">
				<DropdownMenuLabel>{env.name}</DropdownMenuLabel>
				{env.preview && (
					<>
						{(env.preview.primaryUrl ?? env.preview.urls[0]) && (
							<DropdownMenuItem asChild>
								<a
									href={env.preview.primaryUrl ?? env.preview.urls[0]}
									target="_blank"
									rel="noreferrer"
								>
									<ExternalLink />
									Open preview
								</a>
							</DropdownMenuItem>
						)}
						{env.preview.url && (
							<DropdownMenuItem asChild>
								<a href={env.preview.url} target="_blank" rel="noreferrer">
									<GitPullRequest />
									Pull request #{env.preview.number}
								</a>
							</DropdownMenuItem>
						)}
						<DropdownMenuSeparator />
					</>
				)}
				<DropdownMenuItem
					disabled={env.isDefault || update.isPending}
					onSelect={() =>
						save({ isDefault: true }, `${env.name} now opens by default`)
					}
				>
					<Check className={env.isDefault ? undefined : "invisible"} />
					Open by default
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<Link
						to="/projects/$projectId/variables"
						params={{ projectId: env.projectId }}
						search={{ env: env.id }}
					>
						<Variable />
						Variables
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<Link
						to="/projects/$projectId/duplicate"
						params={{ projectId: env.projectId }}
						search={{ from: env.id }}
					>
						<CopyPlus />
						Duplicate…
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() =>
						exportManifest(
							{ kind: "environment", id: env.id },
							`${projectSlug}-${env.slug}`,
						)
					}
				>
					<Download />
					Export manifest
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
					Color
				</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={envColor(env)}
					onValueChange={(v) =>
						save({ color: v as EnvironmentColor }, `${env.name} recolored`)
					}
				>
					{(Object.keys(ENV_COLORS) as EnvironmentColor[]).map((c) => (
						<DropdownMenuRadioItem key={c} value={c}>
							<EnvDot env={{ color: c, kind: env.kind }} />
							{ENV_COLORS[c].label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
