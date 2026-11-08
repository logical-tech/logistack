import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Plus, RadioTower } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { MonitoringPage } from "@/components/monitoring/monitoring-page";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useInvalidating } from "@/lib/api/networking";
import {
	badgeUrl,
	monitorsQuery,
	type StatusPage,
	statusPagesQuery,
	statusPageUrl,
	uptimeApi,
} from "@/lib/api/uptime";

export const Route = createFileRoute("/_app/monitoring/status-pages")({
	staticData: { crumb: "Status pages" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(statusPagesQuery);
	},
	component: StatusPages,
});

function NewPageButton() {
	return (
		<Button asChild>
			<Link to="/monitoring/status-pages/new">
				<Plus data-icon="inline-start" />
				New status page
			</Link>
		</Button>
	);
}

function Badges({
	page,
	names,
}: {
	page: StatusPage;
	names: Map<string, string>;
}) {
	const ids = page.sections.flatMap((s) => s.monitors);
	return (
		<Collapsible>
			<CollapsibleTrigger asChild>
				<Button
					variant="link"
					size="sm"
					className="h-auto px-0 text-muted-foreground hover:text-foreground"
				>
					Embed badges
				</Button>
			</CollapsibleTrigger>
			<CollapsibleContent className="grid gap-3 pt-3">
				<p className="text-xs text-muted-foreground">
					SVG badges for a README or your own site. Use <code>type=status</code>{" "}
					for up or down, <code>type=uptime&amp;days=30</code> for a percentage.
				</p>
				{ids.map((m) => (
					<div key={m.monitorId} className="grid gap-1.5">
						<div className="flex items-center gap-3 text-sm">
							<span className="font-medium">
								{m.label || names.get(m.monitorId)}
							</span>
							<img
								src={badgeUrl(page, m.monitorId, "status")}
								alt=""
								className="h-5"
								loading="lazy"
							/>
							<img
								src={badgeUrl(page, m.monitorId, "uptime")}
								alt=""
								className="h-5"
								loading="lazy"
							/>
						</div>
						<CopyField
							label={`Badge HTML for ${m.label || names.get(m.monitorId)}`}
							value={`<img src="${badgeUrl(page, m.monitorId, "uptime")}" alt="Uptime">`}
						/>
					</div>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

function PageRow({
	page,
	names,
}: {
	page: StatusPage;
	names: Map<string, string>;
}) {
	const remove = useInvalidating(uptimeApi.removePage, [["status-pages"]]);
	const [confirm, setConfirm] = useState(false);
	const url = statusPageUrl(page);
	const count = page.sections.reduce((n, s) => n + s.monitors.length, 0);
	return (
		<li className="grid gap-2 px-4 py-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="flex items-center gap-2 font-medium">
						{page.title}
						{!page.published && (
							<span className="rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground">
								Unpublished
							</span>
						)}
					</p>
					<p className="mt-0.5 truncate text-xs text-muted-foreground">
						<span className="text-foreground">
							{page.hostname ?? `/status/${page.slug}`}
						</span>
						{page.hostname && ` · also /status/${page.slug}`} · {count}{" "}
						{count === 1 ? "monitor" : "monitors"} · {page.historyDays} days
					</p>
				</div>
				<div className="flex items-center gap-1">
					<Button variant="ghost" size="sm" asChild>
						<a href={url} target="_blank" rel="noreferrer">
							Open
							<ExternalLink data-icon="inline-end" />
						</a>
					</Button>
					<Button variant="ghost" size="sm" asChild>
						<Link
							to="/monitoring/status-pages/$pageId/edit"
							params={{ pageId: page.id }}
						>
							Edit
						</Link>
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="text-muted-foreground"
						onClick={() => setConfirm(true)}
					>
						Delete
					</Button>
				</div>
			</div>
			<Badges page={page} names={names} />
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title={`Delete ${page.title}?`}
				description={`Visitors to ${page.hostname ?? `/status/${page.slug}`} get a 404, and embedded badges stop working. Monitors and incidents stay.`}
				confirmLabel="Delete page"
				pending={remove.isPending}
				onConfirm={() =>
					remove.mutate(page.id, {
						onSuccess: () => {
							setConfirm(false);
							toast.success(`${page.title} deleted`);
						},
						onError: (e) => toast.error(e.message),
					})
				}
			/>
		</li>
	);
}

function StatusPages() {
	const { data: pages } = useQuery(statusPagesQuery);
	const { data: monitors = [] } = useQuery(monitorsQuery);
	const names = new Map(monitors.map((m) => [m.id, m.name]));
	return (
		<MonitoringPage
			section="status-pages"
			description="Public pages that show your monitors' status, 90 days of uptime and your incidents."
			action={<NewPageButton />}
		>
			{pages && pages.length === 0 ? (
				<EmptyState
					icon={RadioTower}
					title="No status pages"
					description="Give your users one place to check before they write to support. Pick monitors, set your colours, optionally use your own domain."
				>
					<NewPageButton />
				</EmptyState>
			) : (
				<Panel id="pages-heading" title="Status pages">
					{pages ? (
						<ul className="t-reveal divide-y">
							{pages.map((p) => (
								<PageRow key={p.id} page={p} names={names} />
							))}
						</ul>
					) : (
						<SkeletonRows rows={2} />
					)}
				</Panel>
			)}
		</MonitoringPage>
	);
}
