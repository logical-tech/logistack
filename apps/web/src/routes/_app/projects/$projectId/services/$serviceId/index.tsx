import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, GitCommitHorizontal, Globe, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Panel } from "@/components/panel";
import { AddDomainDialog } from "@/components/service/add-domain-dialog";
import {
	DeploymentStatusLabel,
	StatusDot,
	StatusLabel,
} from "@/components/status";
import { Button } from "@/components/ui/button";
import { domainsQuery } from "@/lib/api/networking";
import {
	overviewQuery,
	type ServiceOverview,
	type ServiceTask,
} from "@/lib/api/service-ops";
import type { ProjectId } from "@/lib/api/types";
import { formatDuration, relativeTime, shortImage } from "@/lib/format";
import { DOMAIN_STATUS, SERVICE_STATUS, type StatusMeta } from "@/lib/status";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/",
)({
	component: OverviewTab,
});

/** Swarm task states, read as the service vocabulary. */
const TASK_STATE: Record<string, StatusMeta> = {
	running: { label: "Running", tone: "ok" },
	new: { label: "Scheduling", tone: "busy", live: true },
	pending: { label: "Pending", tone: "busy", live: true },
	assigned: { label: "Assigned", tone: "busy", live: true },
	accepted: { label: "Accepted", tone: "busy", live: true },
	preparing: { label: "Pulling", tone: "busy", live: true },
	ready: { label: "Ready", tone: "busy", live: true },
	starting: { label: "Starting", tone: "busy", live: true },
	complete: { label: "Exited", tone: "idle" },
	shutdown: { label: "Shut down", tone: "idle" },
	failed: { label: "Failed", tone: "bad" },
	rejected: { label: "Rejected", tone: "bad" },
	orphaned: { label: "Orphaned", tone: "warn" },
};
const taskMeta = (state: string): StatusMeta =>
	TASK_STATE[state] ?? { label: state, tone: "idle" };

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="min-w-0 truncate text-right text-sm">{children}</dd>
		</div>
	);
}

function StatePanel({ service: o }: { service: ServiceOverview }) {
	return (
		<Panel title="State" id="state">
			<dl className="divide-y">
				<Fact label="Desired">
					{o.desiredState === "running" ? "Running" : "Stopped"}
				</Fact>
				<Fact label="Observed">
					<StatusLabel meta={SERVICE_STATUS[o.status.observed]} />
				</Fact>
				<Fact label="Replicas">
					<span className="tabular">
						{o.status.replicasRunning} of {o.status.replicasDesired} running
					</span>
				</Fact>
				<Fact label="Last observed">
					{o.status.observedAt ? (
						<time dateTime={o.status.observedAt}>
							{relativeTime(o.status.observedAt)}
						</time>
					) : (
						<span className="text-muted-foreground">Not yet</span>
					)}
				</Fact>
			</dl>
		</Panel>
	);
}

function Replicas({ tasks }: { tasks: ServiceTask[] }) {
	return (
		<Panel title="Replicas" id="replicas">
			{tasks.length === 0 ? (
				<p className="px-4 py-6 text-sm text-muted-foreground">
					No replica is scheduled. Start the service or deploy it to create one.
				</p>
			) : (
				<ul className="divide-y">
					{[...tasks]
						.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
						.map((t) => (
							<li
								key={t.id}
								className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3"
							>
								<span className="text-sm text-muted-foreground tabular">
									#{t.slot ?? "?"}
								</span>
								<div className="min-w-0">
									<span className="block truncate text-sm">
										{t.hostname ?? t.nodeId ?? "Unassigned"}
									</span>
									<span className="flex min-w-0 items-center gap-1">
										<code
											className="truncate font-mono text-xs text-muted-foreground"
											title={t.containerName}
										>
											{t.containerName}
										</code>
										<CopyButton
											value={t.containerName}
											label="Copy container name"
											className="-my-1 size-6 shrink-0"
										/>
									</span>
									{(t.error || t.message) && (
										<span
											className={
												t.error
													? "block truncate text-xs text-bad-text"
													: "block truncate text-xs text-muted-foreground"
											}
											title={t.error ?? t.message}
										>
											{t.error ?? t.message}
										</span>
									)}
								</div>
								<div className="flex flex-col items-end gap-0.5">
									<StatusLabel meta={taskMeta(t.state)} />
									{t.at && (
										<time
											dateTime={t.at}
											className="text-xs text-muted-foreground"
										>
											since {relativeTime(t.at)}
										</time>
									)}
								</div>
							</li>
						))}
				</ul>
			)}
		</Panel>
	);
}

function Current({
	service: o,
	projectId,
}: {
	service: ServiceOverview;
	projectId: ProjectId;
}) {
	const d = o.current;
	const latest = o.latest;
	const pendingLatest = latest && latest.id !== d?.id ? latest : null;
	const params = { projectId, serviceId: o.id };
	return (
		<Panel
			title="Running image"
			id="current"
			actions={
				d && (
					<Button variant="ghost" size="sm" asChild>
						<Link
							to="/projects/$projectId/services/$serviceId/deployments"
							params={params}
							search={{ d: d.id }}
						>
							View log
						</Link>
					</Button>
				)
			}
		>
			{d ? (
				<div className="grid gap-3 px-4 py-4">
					{d.imageRef && (
						<div className="flex min-w-0 items-center gap-1">
							<code
								className="truncate font-mono text-[13px]"
								title={d.imageRef}
							>
								{shortImage(d.imageRef)}
							</code>
							<CopyButton
								value={d.imageRef}
								label="Copy full image reference"
								className="-my-1 shrink-0"
							/>
						</div>
					)}
					<div className="flex min-w-0 items-center gap-2 text-sm">
						{d.commitSha ? (
							<>
								<GitCommitHorizontal
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								<span className="shrink-0 font-mono text-xs text-muted-foreground">
									{d.commitSha.slice(0, 7)}
								</span>
								<span className="truncate">{d.commitMessage}</span>
							</>
						) : (
							<span className="text-muted-foreground">
								Pulled from the registry, no commit
							</span>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						Deployed{" "}
						<time dateTime={d.finishedAt ?? d.createdAt}>
							{relativeTime(d.finishedAt ?? d.createdAt)}
						</time>
						{d.startedAt && d.finishedAt && (
							<>
								{" "}
								in{" "}
								<span className="tabular">
									{formatDuration(
										(Date.parse(d.finishedAt) - Date.parse(d.startedAt)) / 1000,
									)}
								</span>
							</>
						)}
					</p>
				</div>
			) : (
				<p className="px-4 py-6 text-sm text-muted-foreground">
					Nothing has deployed successfully yet.
				</p>
			)}
			{pendingLatest && (
				<Link
					to="/projects/$projectId/services/$serviceId/deployments"
					params={params}
					search={{ d: pendingLatest.id }}
					className="flex items-center justify-between gap-3 border-t px-4 py-2.5 text-sm transition-colors duration-(--duration-quick) hover:bg-muted/40"
				>
					<span className="text-muted-foreground">Latest deployment</span>
					<DeploymentStatusLabel status={pendingLatest.status} />
				</Link>
			)}
		</Panel>
	);
}

function Domains({ service: o }: { service: ServiceOverview }) {
	const { data } = useQuery(domainsQuery);
	const mine = data?.filter((d) => d.service.id === o.id);
	const [adding, setAdding] = useState(false);
	return (
		<Panel
			title="Domains"
			id="domains"
			actions={
				<Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
					<Plus data-icon="inline-start" />
					Add
				</Button>
			}
		>
			<AddDomainDialog service={o} open={adding} onOpenChange={setAdding} />
			{!mine ? (
				<div className="h-12" />
			) : mine.length === 0 ? (
				<p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
					<Globe className="size-4" aria-hidden />
					Internal only: reachable from services in this environment.
				</p>
			) : (
				<ul className="divide-y">
					{mine.map((d) => (
						<li
							key={d.id}
							className="flex items-center justify-between gap-3 px-4 py-2.5"
						>
							<a
								href={`${d.https ? "https" : "http"}://${d.hostname.replace(/^\*\./, "")}${d.pathPrefix ?? ""}`}
								target="_blank"
								rel="noreferrer"
								className="group inline-flex min-w-0 items-center gap-1 font-mono text-[13px] hover:underline"
							>
								<span className="truncate">{d.hostname}</span>
								<ArrowUpRight
									className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-(--duration-quick) group-hover:opacity-100"
									aria-hidden
								/>
							</a>
							<StatusLabel meta={DOMAIN_STATUS[d.status]} className="text-xs" />
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}

const CRASH_LOOP: StatusMeta = { label: "Crash loop", tone: "bad" };

/** Quiet on purpose: the replicas below already show the failing tasks in red. */
function CrashLoopNotice({
	service: o,
	projectId,
}: {
	service: ServiceOverview;
	projectId: ProjectId;
}) {
	const loop = o.status.crashLoop;
	if (!loop) return null;
	return (
		<div
			role="status"
			className="t-reveal flex items-start gap-3 rounded-xl bg-card px-4 py-3 shadow-card ring-1 ring-border lg:col-span-2"
		>
			<StatusDot meta={CRASH_LOOP} className="mt-1.5" />
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">Restarting repeatedly</p>
				<p className="mt-0.5 text-xs text-muted-foreground">
					<span className="tabular">{loop.failures}</span> failed{" "}
					{loop.failures === 1 ? "task" : "tasks"} in the last 5 minutes, since{" "}
					<time dateTime={loop.since}>{relativeTime(loop.since)}</time>. Last
					exit:{" "}
					<code
						className="font-mono text-bad-text break-all"
						title={loop.reason}
					>
						{loop.reason}
					</code>
				</p>
			</div>
			<Button variant="ghost" size="sm" asChild>
				<Link
					to="/projects/$projectId/services/$serviceId/logs"
					params={{ projectId, serviceId: o.id }}
				>
					View logs
				</Link>
			</Button>
		</div>
	);
}

function OverviewTab() {
	const { serviceId, projectId } = Route.useParams();
	const { data: service } = useQuery(overviewQuery(serviceId));
	if (!service) return null;
	return (
		<div className="t-reveal grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
			<CrashLoopNotice service={service} projectId={projectId} />
			<div className="grid content-start gap-6">
				<Replicas tasks={service.status.tasks} />
				<Current service={service} projectId={projectId} />
			</div>
			<div className="grid content-start gap-6">
				<StatePanel service={service} />
				<Domains service={service} />
			</div>
		</div>
	);
}
