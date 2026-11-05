import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ArrowRight,
	DatabaseBackup,
	Fingerprint,
	type LucideIcon,
	ServerCrash,
	XCircle,
} from "lucide-react";
import { AnimatedNumber } from "@/components/animated-number";
import { DeploymentsTable } from "@/components/deployments-table";
import { LiveUsage } from "@/components/monitoring/node-parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { SignalStrip } from "@/components/signal-strip";
import { NodeStatusLabel, ServiceStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { foldersQuery } from "@/lib/api/folders";
import { migrationSourceQuery, migrationsApi } from "@/lib/api/migrations";
import { nodesQuery } from "@/lib/api/monitoring";
import { overviewQuery } from "@/lib/api/overview";
import { projectsQuery } from "@/lib/api/projects";
import type {
	ClusterNode,
	ObservedStatus,
	Overview,
	ProjectSummary,
} from "@/lib/api/types";
import { daysUntil, relativeTime } from "@/lib/format";
import {
	projectHealth,
	SERVICE_STATUS,
	severityRank,
	TONE_DOT,
	TONE_TEXT,
	type Tone,
} from "@/lib/status";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/")({
	staticData: { crumb: "Home" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(overviewQuery);
		void context.queryClient.prefetchQuery(projectsQuery);
		void context.queryClient.prefetchQuery(nodesQuery);
	},
	component: Home,
});

const ORDER: ObservedStatus[] = [
	"running",
	"starting",
	"unhealthy",
	"failed",
	"stopped",
	"unknown",
];

function ServicesPanel({ data }: { data: Overview | undefined }) {
	const counts = data?.servicesByStatus;
	const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
	return (
		<Panel id="services" title="Services" bodyClassName="p-4 sm:p-5">
			{!counts ? (
				<div className="grid gap-4" aria-hidden>
					<span className="t-skel h-8 w-20 rounded bg-muted-foreground/15" />
					<span className="t-skel h-2 rounded-full bg-muted-foreground/15" />
				</div>
			) : (
				<div className="t-reveal">
					<div className="flex items-baseline gap-2">
						<AnimatedNumber
							value={total}
							className="text-2xl font-semibold [font-stretch:108%]"
						/>
						<span className="text-sm text-muted-foreground">
							services across {data.projectCount} projects
						</span>
					</div>
					<div
						className="mt-4 flex h-2 gap-[3px] overflow-hidden rounded-full"
						role="img"
						aria-label={ORDER.filter((s) => counts[s])
							.map(
								(s) => `${counts[s]} ${SERVICE_STATUS[s].label.toLowerCase()}`,
							)
							.join(", ")}
					>
						{ORDER.filter((s) => counts[s]).map((s) => (
							<span
								key={s}
								className={cn(
									"h-full transition-[flex-grow] duration-(--duration-slow) ease-(--ease-smooth-out)",
									TONE_DOT[SERVICE_STATUS[s].tone],
									s === "stopped" && "opacity-45",
								)}
								style={{ flexGrow: counts[s] }}
							/>
						))}
					</div>
					<dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-5">
						{ORDER.filter((s) => s !== "unknown" || counts[s]).map((s) => (
							<div key={s} className="flex items-center gap-2 text-sm">
								<span
									aria-hidden
									className={cn(
										"size-2 rounded-full",
										TONE_DOT[SERVICE_STATUS[s].tone],
										s === "stopped" && "opacity-45",
									)}
								/>
								<dt className="text-muted-foreground">
									{SERVICE_STATUS[s].label}
								</dt>
								<dd className="ml-auto font-medium sm:ml-0">
									<AnimatedNumber value={counts[s]} />
								</dd>
							</div>
						))}
					</dl>
				</div>
			)}
		</Panel>
	);
}

function ProjectsPanel({
	projects,
}: {
	projects: ProjectSummary[] | undefined;
}) {
	const { data: folders = [] } = useQuery(foldersQuery);
	const path = (p: ProjectSummary) => {
		const f = folders.find((x) => x.id === p.folderId);
		const parent = folders.find((x) => x.id === f?.parentId);
		return [parent?.name, f?.name].filter(Boolean).join(" / ") || "Root";
	};
	const sorted = [...(projects ?? [])].sort((a, b) => {
		const ha = projectHealth(a.services.map((s) => s.status));
		const hb = projectHealth(b.services.map((s) => s.status));
		const ra = ha.kind === "empty" ? 99 : severityRank(ha.status);
		const rb = hb.kind === "empty" ? 99 : severityRank(hb.status);
		return ra - rb || a.name.localeCompare(b.name);
	});
	return (
		<Panel
			id="projects"
			title="Projects"
			actions={
				<Button
					asChild
					variant="ghost"
					size="sm"
					className="text-muted-foreground"
				>
					<Link to="/projects">
						All projects <ArrowRight data-icon="inline-end" />
					</Link>
				</Button>
			}
		>
			{!projects ? (
				<SkeletonRows rows={5} />
			) : projects.length === 0 ? (
				<p className="t-reveal px-4 py-8 text-center text-sm text-muted-foreground">
					No projects yet.
				</p>
			) : (
				<ul className="t-reveal divide-y">
					{sorted.slice(0, 6).map((p) => {
						const h = projectHealth(p.services.map((s) => s.status));
						return (
							<li key={p.id}>
								<Link
									to="/projects/$projectId"
									params={{ projectId: p.id }}
									className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_10rem_8.5rem]"
								>
									<span className="min-w-0">
										<span className="block truncate text-sm font-medium">
											{p.name}
										</span>
										<span className="block truncate text-xs text-muted-foreground">
											{path(p)}
										</span>
									</span>
									<SignalStrip
										services={p.services}
										size="sm"
										className="max-sm:col-start-1 max-sm:row-start-2"
									/>
									{h.kind === "status" ? (
										<ServiceStatus
											status={h.status}
											className="justify-self-end max-sm:row-span-2"
											suffix={
												h.status === "running"
													? undefined
													: `${h.running}/${h.total}`
											}
										/>
									) : (
										<span className="justify-self-end text-sm text-muted-foreground">
											No services
										</span>
									)}
								</Link>
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}

type Attention = {
	id: string;
	icon: LucideIcon;
	tone: Tone;
	title: string;
	detail: string;
	when: string;
	to?: { projectId: ProjectSummary["id"] };
	node?: ClusterNode["id"];
};

function attentionItems(data: Overview, nodes: ClusterNode[]): Attention[] {
	const items: Attention[] = [];
	for (const d of data.recentDeployments) {
		if (d.status !== "failed") continue;
		items.push({
			id: d.id,
			icon: XCircle,
			tone: "bad",
			title: `${d.project.name} / ${d.service.name} failed to deploy`,
			detail: d.error ?? "Deployment failed",
			when: relativeTime(d.finishedAt ?? d.startedAt ?? d.createdAt),
			to: { projectId: d.project.id },
		});
	}
	for (const b of data.failedBackups) {
		items.push({
			id: b.id,
			icon: DatabaseBackup,
			tone: "bad",
			title: `${b.kind === "verify" ? "Restore test" : "Backup"} failed: ${b.project.name} / ${b.service.name}`,
			detail: b.error ?? "",
			when: relativeTime(b.finishedAt ?? b.startedAt),
			to: { projectId: b.project.id },
		});
	}
	for (const n of nodes) {
		if (n.status !== "down") continue;
		const seen = n.lastSeenAt ? relativeTime(n.lastSeenAt) : "never";
		items.push({
			id: n.id,
			icon: ServerCrash,
			tone: "bad",
			title: `${n.hostname} is not reporting`,
			detail: `${n.address} · last seen ${seen}`,
			when: seen,
			node: n.id,
		});
	}
	for (const c of data.expiringCertificates) {
		const days = daysUntil(c.notAfter);
		if (days > 30) continue;
		items.push({
			id: c.id,
			icon: Fingerprint,
			tone: days <= 7 ? "warn" : "idle",
			title: `${c.name} expires in ${days} day${days === 1 ? "" : "s"}`,
			detail:
				c.source === "letsencrypt"
					? "Let's Encrypt renewal hasn't succeeded yet"
					: "Custom certificate: upload a renewed one",
			when: new Date(c.notAfter).toLocaleDateString("en", {
				month: "short",
				day: "numeric",
			}),
		});
	}
	return items;
}

function AttentionPanel({ data }: { data: Overview | undefined }) {
	const { data: nodes } = useQuery(nodesQuery);
	const items = data && nodes ? attentionItems(data, nodes) : undefined;
	return (
		<Panel
			id="attention"
			title={
				<span className="flex items-center gap-2">
					Needs attention
					{items && items.length > 0 && (
						<span className="rounded-full bg-bad/12 px-1.5 text-xs font-medium tabular text-bad-text">
							{items.length}
						</span>
					)}
				</span>
			}
		>
			{!items ? (
				<SkeletonRows rows={4} />
			) : items.length === 0 ? (
				<p className="t-reveal px-4 py-8 text-center text-sm text-muted-foreground">
					Nothing needs you right now.
				</p>
			) : (
				<ul className="t-reveal divide-y">
					{items.map((a) => {
						const body = (
							<>
								<a.icon
									className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[a.tone])}
									strokeWidth={1.75}
									aria-hidden
								/>
								<span className="min-w-0 flex-1">
									<span className="block text-sm leading-5 font-medium">
										{a.title}
									</span>
									<span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
										{a.detail}
									</span>
								</span>
								<span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
									{a.when}
								</span>
							</>
						);
						const cls =
							"flex items-start gap-3 px-4 py-3 transition-colors duration-(--duration-quick)";
						return (
							<li key={a.id}>
								{a.to ? (
									<Link
										to="/projects/$projectId"
										params={a.to}
										className={cn(cls, "hover:bg-muted/50")}
									>
										{body}
									</Link>
								) : a.node ? (
									<Link
										to="/monitoring/nodes/$nodeId"
										params={{ nodeId: a.node }}
										className={cn(cls, "hover:bg-muted/50")}
									>
										{body}
									</Link>
								) : (
									<div className={cls}>{body}</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}

function NodesPanel() {
	const { data: nodes } = useQuery(nodesQuery);
	return (
		<Panel
			id="nodes"
			title="Nodes"
			actions={
				<Button
					asChild
					variant="ghost"
					size="sm"
					className="text-muted-foreground"
				>
					<Link to="/monitoring">
						Monitoring <ArrowRight data-icon="inline-end" />
					</Link>
				</Button>
			}
		>
			{!nodes ? (
				<SkeletonRows rows={3} />
			) : nodes.length === 0 ? (
				<div className="t-reveal grid justify-items-center gap-3 px-4 py-8 text-center">
					<p className="text-sm text-muted-foreground">
						No servers yet. Add one over SSH to see it here.
					</p>
					<Button asChild variant="outline" size="sm">
						<Link to="/monitoring/nodes/new">Add server</Link>
					</Button>
				</div>
			) : (
				<ul className="t-reveal divide-y">
					{[...nodes]
						.sort((a, b) => a.hostname.localeCompare(b.hostname))
						.map((n) => (
							<li key={n.id}>
								<Link
									to="/monitoring/nodes/$nodeId"
									params={{ nodeId: n.id }}
									className="block px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-muted/50"
								>
									<div className="flex items-center justify-between gap-3">
										<div className="min-w-0">
											<span className="block truncate text-sm font-medium">
												{n.hostname}
											</span>
											<span className="block truncate text-xs text-muted-foreground">
												<span className="font-mono">{n.address}</span> ·{" "}
												{n.role}
											</span>
										</div>
										<NodeStatusLabel status={n.status} />
									</div>
									<LiveUsage node={n} className="mt-3" />
								</Link>
							</li>
						))}
				</ul>
			)}
		</Panel>
	);
}

/** Shown to admins while a Dokploy or Coolify next to this server has not handed over its traffic. */
function MigrationCallout() {
	const source = useQuery({ ...migrationSourceQuery, retry: false });
	const id = source.data?.migrationId;
	const mig = useQuery({
		queryKey: ["migrations", id ?? ""],
		queryFn: () => migrationsApi.get(id as string),
		enabled: Boolean(id),
	});
	const from = source.data?.source;
	if (!from) return null;
	if (mig.data?.proxy.status === "switched") return null;
	const label = from === "coolify" ? "Coolify" : "Dokploy";
	return (
		<section className="t-reveal mb-6 flex flex-col gap-4 rounded-xl bg-card px-5 py-4 shadow-card ring-1 ring-border sm:flex-row sm:items-center">
			<div className="min-w-0 flex-1">
				<h2 className="text-sm font-semibold">{label} runs on this server</h2>
				<p className="mt-0.5 text-sm text-muted-foreground text-pretty">
					{id
						? `Your migration is in progress. ${label} keeps serving until you switch traffic.`
						: `Move its projects, databases and domains here, one service at a time. ${label} keeps serving until you switch traffic.`}
				</p>
			</div>
			<Button asChild variant={id ? "outline" : "default"}>
				<Link to="/settings/migrate">
					{id ? "Continue migration" : "Start migration"}
				</Link>
			</Button>
		</section>
	);
}

function Home() {
	const { data } = useQuery(overviewQuery);
	const { data: projects } = useQuery(projectsQuery);

	return (
		<Page className="max-w-7xl">
			<PageHeader
				title="Home"
				description="What's running, what failed, and what needs you."
				actions={
					<Button asChild>
						<Link to="/projects" search={{ create: "project" }}>
							New project
						</Link>
					</Button>
				}
			/>
			<MigrationCallout />
			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
				<div className="grid min-w-0 content-start gap-6">
					<ServicesPanel data={data} />
					<div className="lg:hidden">
						<AttentionPanel data={data} />
					</div>
					<ProjectsPanel projects={projects} />
					<Panel id="deployments" title="Recent deployments">
						{!data ? (
							<SkeletonRows rows={6} />
						) : (
							<div className="t-reveal">
								<DeploymentsTable data={data.recentDeployments} />
							</div>
						)}
					</Panel>
				</div>
				<div className="grid min-w-0 content-start gap-6">
					<div className="max-lg:hidden">
						<AttentionPanel data={data} />
					</div>
					<NodesPanel />
				</div>
			</div>
		</Page>
	);
}
