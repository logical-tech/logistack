import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { PluginFrame } from "@/components/plugins/plugin-frame";
import { Button } from "@/components/ui/button";
import { pluginContributionsQuery } from "@/lib/api/plugins";

// Not /plugins/…: the server proxies that prefix to plugin containers, so a reload there
// would never reach the dashboard.
export const Route = createFileRoute("/_app/plugin/$installId/$pageId/$")({
	loader: async ({ context, params }) => {
		const all = await context.queryClient.ensureQueryData(
			pluginContributionsQuery,
		);
		const c = all.find((x) => x.installId === params.installId);
		const page = c?.pages.find((p) => p.id === params.pageId);
		return { crumb: page?.title ?? "Plugin" };
	},
	component: PluginPageRoute,
});

function PluginPageRoute() {
	const { installId, pageId, _splat } = Route.useParams();
	const { data, isPending } = useQuery(pluginContributionsQuery);
	const contribution = data?.find((c) => c.installId === installId);
	const page = contribution?.pages.find(
		(p) =>
			p.id === pageId &&
			(p.location === "sidebar" || p.location === "settings"),
	);
	return (
		<Page className="max-w-6xl">
			{isPending ? (
				<Panel title="Loading" id="plugin">
					<SkeletonRows rows={3} />
				</Panel>
			) : contribution && page ? (
				<>
					<h1 className="sr-only">{page.title}</h1>
					<PluginFrame
						contribution={contribution}
						page={page}
						subpath={_splat ?? ""}
						context={{}}
					/>
				</>
			) : (
				<EmptyState
					icon={Puzzle}
					title="This page isn't available"
					description="The plugin that adds it was turned off or uninstalled, or it no longer has this page."
				>
					<Button asChild variant="outline">
						<Link to="/settings/plugins">Open Plugins</Link>
					</Button>
				</EmptyState>
			)}
		</Page>
	);
}
