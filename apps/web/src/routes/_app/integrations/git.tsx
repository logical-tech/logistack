import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Ellipsis, ExternalLink, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { GIT_KIND, KindTile } from "@/components/integration-kinds";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import { StatusDot, StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	type GitProvider,
	gitProvidersQuery,
	useDeleteGitProvider,
} from "@/lib/api/integrations";
import { relativeTime } from "@/lib/format";
import { section } from "@/lib/nav";
import { GIT_PROVIDER_STATUS } from "@/lib/status";

export const Route = createFileRoute("/_app/integrations/git")({
	staticData: { crumb: "Git providers" },
	loader: ({ context }) => context.queryClient.prefetchQuery(gitProvidersQuery),
	component: GitProviders,
});

const SECTION = section("/integrations/git");

const col = createColumnHelper<BaseFeatures, GitProvider>();

function columns(onDelete: (p: GitProvider) => void) {
	return col.columns([
		col.display({
			id: "provider",
			header: "Provider",
			meta: { className: "w-[34%] max-sm:w-auto" },
			cell: ({ row: { original: p } }) => {
				const kind = GIT_KIND[p.kind];
				return (
					<div className="flex min-w-0 items-center gap-3">
						<KindTile icon={kind.icon} />
						<div className="min-w-0">
							<span className="flex min-w-0 items-center gap-2">
								<StatusDot
									meta={GIT_PROVIDER_STATUS[p.state]}
									className="sm:hidden"
								/>
								<span className="truncate font-medium">{p.name}</span>
							</span>
							<span className="block truncate text-xs text-muted-foreground">
								{p.state === "connected"
									? kind.label
									: (p.message ?? kind.label)}
							</span>
						</div>
					</div>
				);
			},
		}),
		col.accessor("state", {
			header: "Status",
			meta: { className: "w-36 max-sm:hidden" },
			cell: (c) => <StatusLabel meta={GIT_PROVIDER_STATUS[c.getValue()]} />,
		}),
		col.accessor("repoCount", {
			header: "Repositories",
			meta: { className: "w-28 max-md:hidden" },
			cell: (c) => {
				const n = c.getValue();
				return n === null ? (
					<span className="text-muted-foreground">None yet</span>
				) : (
					<span className="tabular">{n}</span>
				);
			},
		}),
		col.accessor("webhookUrl", {
			header: "Webhook",
			meta: { className: "max-lg:hidden" },
			cell: (c) => {
				const url = c.getValue();
				if (!url)
					return <span className="text-muted-foreground">Not used</span>;
				const shown = url.replace(/^https?:\/\//, "");
				const cut = shown.lastIndexOf("/") + 1;
				// Ellipsis in the middle: the provider id at the end is what tells rows apart.
				return (
					<div className="flex min-w-0 items-center gap-1">
						<span
							className="flex min-w-0 font-mono text-xs text-muted-foreground"
							title={url}
						>
							<span className="truncate">{shown.slice(0, cut)}</span>
							<span className="shrink-0">{shown.slice(cut)}</span>
						</span>
						<CopyButton
							value={url}
							label={`Copy webhook URL for ${c.row.original.name}`}
						/>
					</div>
				);
			},
		}),
		col.accessor("createdAt", {
			header: "Added",
			meta: { className: "w-28 max-md:hidden" },
			cell: (c) => (
				<span className="whitespace-nowrap text-muted-foreground">
					{relativeTime(c.getValue())}
				</span>
			),
		}),
		col.display({
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			meta: { className: "w-40 text-right max-sm:w-32" },
			cell: ({ row: { original: p } }) => (
				<div className="flex items-center justify-end gap-1">
					{p.kind === "github" && p.state === "pending" && (
						<Button asChild variant="outline" size="sm">
							<Link
								to="/integrations/git/new"
								search={{ kind: "github", provider: p.id, step: "install" }}
							>
								Finish setup
							</Link>
						</Button>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Actions for ${p.name}`}
							>
								<Ellipsis />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-48">
							{p.appUrl && (
								<>
									<DropdownMenuItem asChild>
										<a href={p.appUrl} target="_blank" rel="noreferrer">
											<ExternalLink />
											Open app on GitHub
										</a>
									</DropdownMenuItem>
									<DropdownMenuSeparator />
								</>
							)}
							<DropdownMenuItem
								variant="destructive"
								onSelect={() => onDelete(p)}
							>
								<Trash2 />
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			),
		}),
	]);
}

function GitProviders() {
	const { data, isPending } = useQuery(gitProvidersQuery);
	const remove = useDeleteGitProvider();
	const [deleting, setDeleting] = useState<GitProvider | null>(null);
	const empty = SECTION.empty;

	const connect = (
		<Button asChild>
			<Link to="/integrations/git/new">
				<Plus data-icon="inline-start" />
				Connect provider
			</Link>
		</Button>
	);

	return (
		<Page>
			<PageHeader
				title={SECTION.title}
				description={SECTION.description}
				actions={data?.length ? connect : undefined}
			/>
			{isPending ? (
				<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					<SkeletonRows rows={3} />
				</div>
			) : !data?.length ? (
				empty && (
					<EmptyState
						icon={SECTION.icon}
						title={empty.title}
						description={empty.body}
					>
						{connect}
					</EmptyState>
				)
			) : (
				<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					<DataTable
						label="Git providers"
						columns={columns(setDeleting)}
						data={data}
						getRowId={(p) => p.id}
					/>
				</div>
			)}

			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "provider"}?`}
				description={
					deleting?.kind === "github"
						? "Services that build from it keep their settings, but their next deployment fails until another provider is chosen. The GitHub App itself stays on GitHub; uninstall it there."
						: "Services that build from it keep their settings, but their next deployment fails until another provider is chosen."
				}
				confirmLabel="Delete provider"
				pending={remove.isPending}
				onConfirm={() => {
					const p = deleting;
					if (!p) return;
					remove.mutate(p.id, {
						onSuccess: () => {
							setDeleting(null);
							toast.success(`${p.name} deleted`);
						},
						onError: (e) =>
							toast.error("Couldn't delete the provider", {
								description: e.message,
							}),
					});
				}}
			/>
		</Page>
	);
}
