import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	Boxes,
	FolderPlus,
	LayoutTemplate,
	Plus,
	Search,
	X,
} from "lucide-react";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import {
	CreateFolderDialog,
	CreateProjectDialog,
} from "@/components/projects/create-dialogs";
import {
	buildTree,
	FolderTree,
	inFolder,
} from "@/components/projects/folder-tree";
import { ProjectCard } from "@/components/projects/project-card";
import { StartFromTemplateDialog } from "@/components/templates/start-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { foldersQuery } from "@/lib/api/folders";
import { projectsQuery } from "@/lib/api/projects";
import type { Folder, FolderId, ProjectSummary } from "@/lib/api/types";

const search = z.object({
	folder: z
		.union([z.string().startsWith("fld_"), z.literal("none")])
		.optional()
		.catch(undefined),
	create: z.enum(["project", "folder", "template"]).optional().catch(undefined),
	q: z.string().optional(),
});

export const Route = createFileRoute("/_app/projects/")({
	validateSearch: search,
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(projectsQuery);
		void context.queryClient.prefetchQuery(foldersQuery);
	},
	component: ProjectsPage,
});

type Group = { key: string; title: string | null; projects: ProjectSummary[] };

/** One group per top-level folder; subfolder projects carry their subfolder name. */
function groupByFolder(projects: ProjectSummary[], folders: Folder[]): Group[] {
	const groups: Group[] = buildTree(folders)
		.map((root) => {
			const ids = new Set([root.id, ...root.children.map((c) => c.id)]);
			return {
				key: root.id,
				title: root.name,
				projects: projects
					.filter((p) => p.folderId !== null && ids.has(p.folderId))
					.sort((a, b) => a.name.localeCompare(b.name)),
			};
		})
		.filter((g) => g.projects.length > 0);
	const loose = projects.filter((p) => p.folderId === null);
	if (loose.length)
		groups.push({ key: "none", title: "No folder", projects: loose });
	return groups;
}

const subfolderName = (p: ProjectSummary, folders: Folder[]) => {
	const f = folders.find((x) => x.id === p.folderId);
	return f?.parentId ? f.name : null;
};

function CardSkeleton() {
	return (
		<div className="grid min-h-44 content-start gap-3 rounded-xl bg-card p-4 ring-1 ring-border">
			<span className="t-skel h-4 w-1/2 rounded bg-muted-foreground/15" />
			<span className="t-skel h-3 w-1/3 rounded bg-muted-foreground/10" />
			<span className="t-skel mt-3 h-3 w-4/5 rounded bg-muted-foreground/10" />
			<span className="t-skel mt-8 h-4 w-28 rounded bg-muted-foreground/15" />
		</div>
	);
}

function ProjectsPage() {
	const { folder, create, q = "" } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: projects } = useQuery(projectsQuery);
	const { data: folders = [] } = useQuery(foldersQuery);
	const selected = folder as FolderId | "none" | undefined;

	const setSearch = (patch: Partial<z.infer<typeof search>>, replace = false) =>
		navigate({ search: (s) => ({ ...s, ...patch }), replace });

	const needle = q.trim().toLowerCase();
	const visible = projects
		? inFolder(projects, folders, selected).filter(
				(p) =>
					!needle ||
					p.name.toLowerCase().includes(needle) ||
					p.description?.toLowerCase().includes(needle),
			)
		: undefined;
	const groups = visible ? groupByFolder(visible, folders) : [];
	const folderName = folders.find((f) => f.id === selected)?.name;
	const parentForNew =
		selected && selected !== "none" ? (selected as FolderId) : null;

	return (
		<Page className="max-w-7xl">
			<PageHeader
				title="Projects"
				description="Folders group projects by client or team. Each project has its own environments."
				actions={
					<>
						<Button
							variant="outline"
							onClick={() => setSearch({ create: "folder" })}
						>
							<FolderPlus data-icon="inline-start" />
							New folder
						</Button>
						<Button
							variant="outline"
							onClick={() => setSearch({ create: "template" })}
							disabled={!projects?.length}
						>
							<LayoutTemplate data-icon="inline-start" />
							New from template
						</Button>
						<Button onClick={() => setSearch({ create: "project" })}>
							<Plus data-icon="inline-start" />
							New project
						</Button>
					</>
				}
			/>

			<div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10">
				<aside className="max-lg:hidden">
					<div className="sticky top-20">
						{projects ? (
							<FolderTree
								folders={folders}
								projects={projects}
								selected={selected}
							/>
						) : (
							<div className="grid gap-2" aria-hidden>
								{[60, 80, 70, 50, 75].map((w) => (
									<span
										key={w}
										className="t-skel h-4 rounded bg-muted-foreground/12"
										style={{ width: `${w}%` }}
									/>
								))}
							</div>
						)}
					</div>
				</aside>

				<div className="@container min-w-0">
					<div className="mb-5 flex flex-col gap-2 sm:flex-row">
						<div className="lg:hidden">
							<Select
								value={selected ?? "all"}
								onValueChange={(v) =>
									setSearch({ folder: v === "all" ? undefined : v })
								}
							>
								<SelectTrigger className="w-full sm:w-56" aria-label="Folder">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="all">All projects</SelectItem>
									{buildTree(folders).flatMap((r) => [
										<SelectItem key={r.id} value={r.id}>
											{r.name}
										</SelectItem>,
										...r.children.map((c) => (
											<SelectItem key={c.id} value={c.id}>
												{r.name} / {c.name}
											</SelectItem>
										)),
									])}
									<SelectItem value="none">No folder</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="relative flex-1">
							<Search
								className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
								aria-hidden
							/>
							<Input
								type="search"
								aria-label="Filter projects"
								placeholder={
									folderName ? `Filter ${folderName}…` : "Filter projects…"
								}
								value={q}
								onChange={(e) =>
									setSearch({ q: e.target.value || undefined }, true)
								}
								className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
							/>
							{q && (
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="Clear filter"
									className="absolute top-1/2 right-1.5 -translate-y-1/2"
									onClick={() => setSearch({ q: undefined }, true)}
								>
									<X />
								</Button>
							)}
						</div>
					</div>

					{!visible ? (
						<div className="grid gap-4 @lg:grid-cols-2 @3xl:grid-cols-3">
							{[1, 2, 3, 4, 5, 6].map((i) => (
								<CardSkeleton key={i} />
							))}
						</div>
					) : visible.length === 0 ? (
						<EmptyState
							icon={Boxes}
							title={needle ? "No projects match" : "This folder is empty"}
							description={
								needle
									? `Nothing in ${folderName ?? "your projects"} matches “${q}”. Check the spelling or clear the filter.`
									: "Create a project here, or move an existing one into this folder from its settings."
							}
						>
							{needle ? (
								<Button
									variant="outline"
									onClick={() => setSearch({ q: undefined })}
								>
									Clear filter
								</Button>
							) : (
								<Button onClick={() => setSearch({ create: "project" })}>
									<Plus data-icon="inline-start" /> New project
								</Button>
							)}
						</EmptyState>
					) : (
						<div className="t-reveal grid gap-8">
							{groups.map((g) => (
								<section key={g.key} aria-label={g.title ?? undefined}>
									{(groups.length > 1 || selected === undefined) && g.title && (
										<h2 className="mb-3 text-sm font-medium text-muted-foreground [font-stretch:100%]">
											{g.title}
										</h2>
									)}
									<div className="grid gap-4 @lg:grid-cols-2 @3xl:grid-cols-3">
										{g.projects.map((p) => (
											<ProjectCard
												key={p.id}
												project={p}
												path={subfolderName(p, folders)}
											/>
										))}
									</div>
								</section>
							))}
						</div>
					)}
				</div>
			</div>

			{/* Keyed so the folder picker follows the selected folder; its state is seeded once. */}
			<CreateProjectDialog
				key={`project-${parentForNew}`}
				open={create === "project"}
				onOpenChange={(o) => !o && setSearch({ create: undefined })}
				defaultFolder={parentForNew}
			/>
			<CreateFolderDialog
				key={`folder-${parentForNew}`}
				open={create === "folder"}
				onOpenChange={(o) => !o && setSearch({ create: undefined })}
				defaultParent={parentForNew}
			/>
			{projects && projects.length > 0 && (
				<StartFromTemplateDialog
					open={create === "template"}
					onOpenChange={(o) => !o && setSearch({ create: undefined })}
					projects={projects}
				/>
			)}
		</Page>
	);
}
