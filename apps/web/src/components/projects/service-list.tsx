import type { StorageEngine } from "@logistack/contracts";
import { GAMES } from "@logistack/contracts";
import { Link } from "@tanstack/react-router";
import { Container, GitBranch, Globe } from "lucide-react";
import { ServiceGlyph, StackGlyph } from "@/components/service/service-icon";
import { SignalStrip } from "@/components/signal-strip";
import { stackStatus } from "@/components/stack/stack-header";
import { DeploymentStatusLabel, ServiceStatus } from "@/components/status";
import { primaryOf, type Stack } from "@/lib/api/stacks";
import type {
	DatabaseEngine,
	ObservedStatus,
	ProjectId,
	Service,
} from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { severityRank } from "@/lib/status";

export const ENGINE: Record<DatabaseEngine, string> = {
	postgres: "PostgreSQL",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	redis: "Redis",
	libsql: "libSQL",
};

const STORAGE_ENGINE: Record<StorageEngine, string> = {
	minio: "MinIO",
	rustfs: "RustFS",
	garage: "Garage",
	seaweedfs: "SeaweedFS",
};

function Source({ service: s }: { service: Service }) {
	const spec = s.spec;
	if (spec.kind === "database") {
		return (
			<span className="truncate">
				{ENGINE[spec.engine]} {spec.version}
			</span>
		);
	}
	if (spec.kind === "storage")
		return <span className="truncate">{STORAGE_ENGINE[spec.engine]}</span>;
	if (spec.kind === "game")
		return <span className="truncate">{GAMES[spec.settings.game].label}</span>;
	const source = spec.source;
	if (source.type === "image") {
		return (
			<span className="flex min-w-0 items-center gap-1.5">
				<Container className="size-3.5 shrink-0" aria-hidden />
				<span className="truncate font-mono text-xs">{source.image}</span>
			</span>
		);
	}
	if (source.type === "inline") {
		return <span className="truncate">Compose file · inline</span>;
	}
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			<GitBranch className="size-3.5 shrink-0" aria-hidden />
			<span className="truncate font-mono text-xs">
				{source.repository.replace(/^(github|gitlab)\.com\//, "")}
				<span className="text-muted-foreground/70">@{source.branch}</span>
			</span>
		</span>
	);
}

const ROW =
	"relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3.5 transition-colors duration-(--duration-quick) hover:bg-muted/40 md:grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1fr)_7.5rem_9.5rem]";
const LINK =
	"block max-w-full truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset";

function Domains({ domains }: { domains: string[] }) {
	return (
		<div className="col-start-2 row-start-2 min-w-0 text-xs text-muted-foreground md:col-start-auto md:row-start-auto">
			{domains.length > 0 ? (
				<span className="flex min-w-0 items-center gap-1.5">
					<Globe className="size-3.5 shrink-0" aria-hidden />
					<span className="truncate">{domains[0]}</span>
					{domains.length > 1 && (
						<span className="shrink-0">+{domains.length - 1}</span>
					)}
				</span>
			) : (
				<span className="max-md:hidden">Internal only</span>
			)}
		</div>
	);
}

function LastDeploy({
	deployment: d,
}: {
	deployment: Service["latestDeployment"];
}) {
	return (
		<div className="col-start-3 row-start-2 justify-self-end text-xs text-muted-foreground md:col-start-auto md:row-start-auto">
			{d ? (
				<span className="flex items-center justify-end gap-2">
					{d.status !== "healthy" && (
						<DeploymentStatusLabel status={d.status} className="text-xs" />
					)}
					<time
						dateTime={d.startedAt ?? d.createdAt}
						className="whitespace-nowrap"
					>
						{relativeTime(d.startedAt ?? d.createdAt)}
					</time>
				</span>
			) : (
				"Never deployed"
			)}
		</div>
	);
}

type Item =
	| { kind: "service"; service: Service; status: ObservedStatus; name: string }
	| {
			kind: "stack";
			stack: Stack;
			services: Service[];
			status: ObservedStatus;
			name: string;
	  };

/**
 * One row per standalone service, and one per stack (a template or compose file) standing
 * for all of its containers. Worst status first.
 */
export function ServiceList({
	services,
	stacks = [],
	projectId,
}: {
	services: Service[];
	stacks?: Stack[];
	projectId: ProjectId;
}) {
	const known = new Set(stacks.map((s) => s.id));
	const items: Item[] = [
		...services
			.filter((s) => !s.stackId || !known.has(s.stackId))
			.map((s) => ({
				kind: "service" as const,
				service: s,
				status: s.status.observed,
				name: s.name,
			})),
		...stacks.flatMap((st) => {
			const members = services.filter((s) => s.stackId === st.id);
			return members.length
				? [
						{
							kind: "stack" as const,
							stack: st,
							services: members,
							status: stackStatus(members),
							name: st.name,
						},
					]
				: [];
		}),
	].sort(
		(a, b) =>
			severityRank(a.status) - severityRank(b.status) ||
			a.name.localeCompare(b.name),
	);
	return (
		<ul className="divide-y overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
			{items.map((item) =>
				item.kind === "stack" ? (
					<StackRow key={item.stack.id} {...item} projectId={projectId} />
				) : (
					<ServiceRow
						key={item.service.id}
						service={item.service}
						projectId={projectId}
					/>
				),
			)}
		</ul>
	);
}

function ServiceRow({
	service: s,
	projectId,
}: {
	service: Service;
	projectId: ProjectId;
}) {
	return (
		<li className={ROW}>
			<ServiceGlyph
				service={s}
				className="row-span-2 self-start md:row-span-1 md:self-center"
			/>
			<div className="min-w-0">
				<Link
					to="/projects/$projectId/services/$serviceId"
					params={{ projectId, serviceId: s.id }}
					className={LINK}
				>
					{s.name}
				</Link>
				<div className="mt-0.5 flex min-w-0 text-xs text-muted-foreground">
					<Source service={s} />
				</div>
			</div>
			<Domains domains={s.domains} />
			<div className="col-start-3 row-start-1 justify-self-end md:col-start-auto md:row-start-auto md:justify-self-start">
				<ServiceStatus
					status={s.status.observed}
					suffix={
						s.kind === "application" && s.status.replicasDesired > 1
							? `${s.status.replicasRunning}/${s.status.replicasDesired}`
							: undefined
					}
				/>
			</div>
			<LastDeploy deployment={s.latestDeployment} />
		</li>
	);
}

function StackRow({
	stack,
	services,
	status,
	projectId,
}: {
	stack: Stack;
	services: Service[];
	status: ObservedStatus;
	projectId: ProjectId;
}) {
	const primary = primaryOf(services) as Service;
	const running = services.filter(
		(s) => s.status.observed === "running",
	).length;
	const latest = services
		.map((s) => s.latestDeployment)
		.filter((d) => d !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	return (
		<li className={ROW}>
			<StackGlyph
				service={primary}
				className="row-span-2 self-start md:row-span-1 md:self-center"
			/>
			<div className="min-w-0">
				<Link
					to="/projects/$projectId/stacks/$stackId"
					params={{ projectId, stackId: stack.id }}
					className={LINK}
				>
					{stack.name}
				</Link>
				<div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
					<SignalStrip
						size="sm"
						className="flex-nowrap"
						services={services.map((s) => ({
							id: s.id,
							name: s.name,
							status: s.status.observed,
						}))}
					/>
					<span className="truncate">
						{services.length} containers ·{" "}
						{stack.git
							? `Compose · ${stack.git.repository}`
							: stack.source === "compose"
								? "Compose"
								: "Template"}
					</span>
				</div>
			</div>
			<Domains domains={primary.domains} />
			<div className="col-start-3 row-start-1 justify-self-end md:col-start-auto md:row-start-auto md:justify-self-start">
				<ServiceStatus
					status={status}
					suffix={
						running < services.length
							? `${running}/${services.length}`
							: undefined
					}
				/>
			</div>
			<LastDeploy deployment={latest ?? null} />
		</li>
	);
}
