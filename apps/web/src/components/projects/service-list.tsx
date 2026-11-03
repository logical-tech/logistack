import type { StorageEngine } from "@logistack/contracts";
import { Link } from "@tanstack/react-router";
import {
	Box,
	Container,
	Database,
	GitBranch,
	Globe,
	HardDrive,
	Layers,
	type LucideIcon,
} from "lucide-react";
import { DeploymentStatusLabel, ServiceStatus } from "@/components/status";
import type {
	DatabaseEngine,
	ProjectId,
	Service,
	ServiceKind,
} from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { severityRank } from "@/lib/status";

const KIND_ICON: Record<ServiceKind, LucideIcon> = {
	application: Box,
	database: Database,
	compose: Layers,
	storage: HardDrive,
};

export const ENGINE: Record<DatabaseEngine, string> = {
	postgres: "PostgreSQL",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	redis: "Redis",
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

export function ServiceList({
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
		<ul className="divide-y overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
			{sorted.map((s) => {
				const Icon = KIND_ICON[s.kind];
				const d = s.latestDeployment;
				return (
					<li
						key={s.id}
						className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3.5 transition-colors duration-(--duration-quick) hover:bg-muted/40 md:grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1fr)_7.5rem_9.5rem]"
					>
						<span className="row-span-2 grid size-9 place-items-center self-start rounded-lg bg-muted text-muted-foreground md:row-span-1 md:self-center">
							<Icon className="size-4" strokeWidth={1.75} aria-hidden />
						</span>
						<div className="min-w-0">
							<Link
								to="/projects/$projectId/services/$serviceId"
								params={{ projectId, serviceId: s.id }}
								className="block max-w-full truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
							>
								{s.name}
							</Link>
							<div className="mt-0.5 flex min-w-0 text-xs text-muted-foreground">
								<Source service={s} />
							</div>
						</div>
						<div className="col-start-2 row-start-2 min-w-0 text-xs text-muted-foreground md:col-start-auto md:row-start-auto">
							{s.domains.length > 0 ? (
								<span className="flex min-w-0 items-center gap-1.5">
									<Globe className="size-3.5 shrink-0" aria-hidden />
									<span className="truncate">{s.domains[0]}</span>
									{s.domains.length > 1 && (
										<span className="shrink-0">+{s.domains.length - 1}</span>
									)}
								</span>
							) : (
								<span className="max-md:hidden">Internal only</span>
							)}
						</div>
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
						<div className="col-start-3 row-start-2 justify-self-end text-xs text-muted-foreground md:col-start-auto md:row-start-auto">
							{d ? (
								<span className="flex items-center justify-end gap-2">
									{d.status !== "healthy" && (
										<DeploymentStatusLabel
											status={d.status}
											className="text-xs"
										/>
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
					</li>
				);
			})}
		</ul>
	);
}
