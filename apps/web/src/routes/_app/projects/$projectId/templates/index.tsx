import { TemplateCategory } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { TemplateGallery } from "@/components/templates/gallery";
import { projectQuery } from "@/lib/api/projects";
import { templatesQuery } from "@/lib/api/templates";

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
