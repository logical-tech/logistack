import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Panel } from "@/components/panel";
import { ServiceGlyph } from "@/components/service/service-icon";
import { DeploymentStatusLabel, ServiceStatus } from "@/components/status";
import { serviceMetricsQuery } from "@/lib/api/monitoring";
import type { ProjectId, Service } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { formatBytes, formatPct } from "@/lib/metrics";
import { severityRank } from "@/lib/status";

const GRID =
	"grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 md:grid-cols-[auto_minmax(0,1.4fr)_8rem_4.5rem_6.5rem_minmax(0,1fr)_7rem]";

/** What a container runs, in one mono line. */
function runs(s: Service) {
	const spec = s.spec;
	if (spec.kind === "database") return `${spec.engine}:${spec.version}`;
	if (spec.kind === "storage") return `${spec.engine} object storage`;
	if (spec.source.type === "image") return spec.source.image;
	if (spec.source.type === "inline") return "compose";
	return `${spec.source.repository}@${spec.source.branch}`;
}

/** Where a container is reached: its domain, else its first container port, else nothing. */
function endpoint(s: Service) {
	if (s.domains[0]) return s.domains[0];
	if (s.spec.kind === "application" && s.spec.ports[0])
		return `${s.slug}:${s.spec.ports[0].target}`;
	return null;
}

function Usage({ service }: { service: Service }) {
	// The last hour is what a glance needs; the newest sample is the live reading.
	const { data } = useQuery(serviceMetricsQuery(service.id, "1h"));
	const last = data?.points.at(-1);
	const quiet = service.status.observed !== "running";
	return (
		<>
			<span className="text-right text-xs tabular text-muted-foreground max-md:hidden">
				{last && !quiet ? (
					<span className="text-foreground">{formatPct(last.cpu)}</span>
				) : (
					"–"
				)}
			</span>
			<span className="text-right text-xs tabular text-muted-foreground max-md:hidden">
				{last && !quiet ? (
					<>
						<span className="text-foreground">{formatBytes(last.memUsed)}</span>
						{last.memLimit ? (
							<span className="block text-[11px]">
								of {formatBytes(last.memLimit)}
							</span>
						) : null}
					</>
				) : (
					"–"
				)}
			</span>
		</>
	);
}

/**
 * Every container of the stack, worst first: what it runs, its state and replicas, live CPU
 * and memory, where it is reached and its last deployment. A row opens the container.
 */
export function StackContainers({
	services,
	projectId,
}: {
	services: Service[];
	projectId: ProjectId;
}) {
	const sorted = [...services].sort(
		(a, b) =>
			severityRank(a.status.observed) - severityRank(b.status.observed) ||
			a.name.localeCompare(b.name),
	);
	return (
		<Panel title="Containers" id="stack-containers">
			<div
				className={`${GRID} border-b py-2 text-xs text-muted-foreground max-md:hidden`}
				aria-hidden
			>
				<span className="col-span-2">Container</span>
				<span>Status</span>
				<span className="text-right">CPU</span>
				<span className="text-right">Memory</span>
				<span>Reached at</span>
				<span className="text-right">Deployed</span>
			</div>
			<ul className="divide-y">
				{sorted.map((s) => {
					const d = s.latestDeployment;
					const at = endpoint(s);
					return (
						<li
							key={s.id}
							className={`${GRID} relative py-3 transition-colors duration-(--duration-quick) hover:bg-muted/40`}
						>
							<ServiceGlyph
								service={s}
								className="size-8 rounded-md max-md:row-span-2 max-md:self-start"
							/>
							<div className="min-w-0">
								<Link
									to="/projects/$projectId/services/$serviceId"
									params={{ projectId, serviceId: s.id }}
									className="block max-w-full truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
								>
									{s.name}
								</Link>
								<span className="block truncate font-mono text-xs text-muted-foreground">
									{runs(s)}
								</span>
							</div>
							<span className="justify-self-end md:justify-self-start">
								<ServiceStatus
									status={s.status.observed}
									className="text-[13px]"
									suffix={
										s.status.replicasDesired > 1
											? `${s.status.replicasRunning}/${s.status.replicasDesired}`
											: undefined
									}
								/>
							</span>
							<Usage service={s} />
							<span className="col-start-2 row-start-2 min-w-0 truncate font-mono text-xs text-muted-foreground md:col-start-auto md:row-start-auto">
								{at ?? <span className="font-sans">Internal only</span>}
							</span>
							<span className="col-start-3 row-start-2 justify-self-end text-xs text-muted-foreground md:col-start-auto md:row-start-auto">
								{d ? (
									d.status === "healthy" ? (
										<time dateTime={d.createdAt} className="whitespace-nowrap">
											{relativeTime(d.startedAt ?? d.createdAt)}
										</time>
									) : (
										<DeploymentStatusLabel
											status={d.status}
											className="text-xs"
										/>
									)
								) : (
									"Never"
								)}
							</span>
						</li>
					);
				})}
			</ul>
		</Panel>
	);
}
