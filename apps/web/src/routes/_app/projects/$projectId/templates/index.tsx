import { TemplateCategory } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { TemplateGallery } from "@/components/templates/gallery";
import { Button } from "@/components/ui/button";
import { projectQuery } from "@/lib/api/projects";
import {
	communityIndexQuery,
	templatesQuery,
	useRefreshCommunity,
} from "@/lib/api/templates";
import { relativeTime } from "@/lib/format";

export const Route = createFileRoute("/_app/projects/$projectId/templates/")({
	validateSearch: z.object({
		env: z.string().startsWith("env_").optional().catch(undefined),
		q: z.string().optional().catch(undefined),
		category: TemplateCategory.optional().catch(undefined),
	}),
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(templatesQuery);
	},
	staticData: { crumb: "Templates" },
	component: TemplatesPage,
});

function TemplatesPage() {
	const { projectId } = Route.useParams();
	const { env: envParam, q = "", category } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: project } = useQuery(projectQuery(projectId));
	const { data: templates } = useQuery(templatesQuery);
	const env =
		project?.environments.find((e) => e.id === envParam) ??
		project?.environments.find((e) => e.isDefault) ??
		project?.environments[0];
	if (!project || !env) return null;

	return (
		<Page className="max-w-6xl">
			<PageHeader
				title="New from a template"
				description={
					<>
						Ready-made apps that deploy in one step, with their databases,
						volumes and secrets. Into{" "}
						<span className="text-foreground">{project.name}</span> ·{" "}
						<span className="text-foreground">{env.name}</span>.
					</>
				}
				actions={<RefreshCommunity />}
			/>
			<TemplateGallery
				templates={templates}
				projectId={projectId}
				environmentId={env.id}
				query={q}
				category={category}
				onQueryChange={(next) =>
					navigate({
						search: (s) => ({ ...s, q: next || undefined }),
						replace: true,
					})
				}
				onCategoryChange={(next) =>
					navigate({ search: (s) => ({ ...s, category: next }), replace: true })
				}
			/>
		</Page>
	);
}

/** Community templates change only here: an explicit fetch of the signed index, never a timer. */
function RefreshCommunity() {
	const { data: index } = useQuery(communityIndexQuery);
	const refresh = useRefreshCommunity();
	if (!index) return null;
	const fetched = index.fetchedAt
		? `${index.templates} from ${index.source}, fetched ${relativeTime(index.fetchedAt)}`
		: `Not fetched yet from ${index.source}`;
	return (
		<Button
			variant="outline"
			title={fetched}
			disabled={refresh.isPending}
			onClick={() =>
				refresh.mutate(undefined, {
					onSuccess: (i) =>
						toast.success("Community templates refreshed", {
							description: `${i.templates} from ${i.source}${i.skipped ? `, ${i.skipped} skipped` : ""}.`,
						}),
					onError: (e) =>
						toast.error("Couldn't refresh community templates", {
							description: e instanceof Error ? e.message : undefined,
						}),
				})
			}
		>
			<RefreshCw
				data-icon="inline-start"
				className={refresh.isPending ? "animate-spin" : undefined}
				aria-hidden
			/>
			Refresh community
		</Button>
	);
}
