import { Link } from "@tanstack/react-router";
import { Folder as FolderIcon } from "lucide-react";
import { EnvDot } from "@/components/projects/env-color";
import { SignalStrip } from "@/components/signal-strip";
import { ServiceStatus } from "@/components/status";
import type { ProjectSummary } from "@/lib/api/types";
import { projectHealth } from "@/lib/status";

export function ProjectCard({
	project: p,
	path,
}: {
	project: ProjectSummary;
	path: string | null;
}) {
	const health = projectHealth(p.services.map((s) => s.status));
	const envs = p.environments.length;
	return (
		<Link
			to="/projects/$projectId"
			params={{ projectId: p.id }}
			className="group flex min-h-44 flex-col rounded-xl bg-card p-4 shadow-card ring-1 ring-border outline-none transition-[box-shadow,translate] duration-(--duration-fast) ease-(--ease-smooth-out) hover:-translate-y-px hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="truncate text-md font-semibold [font-stretch:104%]">
						{p.name}
					</h3>
					{path && (
						<p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
							<FolderIcon className="size-3 shrink-0" aria-hidden />
							{path}
						</p>
					)}
				</div>
				{p.archivedAt ? (
					<span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
						Archived
					</span>
				) : health.kind === "status" ? (
					<ServiceStatus status={health.status} className="shrink-0 text-xs" />
				) : (
					<span className="shrink-0 text-xs text-muted-foreground">Empty</span>
				)}
			</div>
			<p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
				{p.description || "No description"}
			</p>
			<div className="mt-auto pt-5">
				<SignalStrip services={p.services} />
				<div className="mt-3 flex items-center gap-2.5 text-xs whitespace-nowrap text-muted-foreground">
					<span className="tabular">
						{p.services.length} service{p.services.length === 1 ? "" : "s"}
					</span>
					<span
						aria-hidden
						className="size-0.5 rounded-full bg-muted-foreground"
					/>
					<span
						className="inline-flex min-w-0 items-center gap-1.5"
						title={p.environments.map((e) => e.name).join(", ")}
					>
						<span className="flex shrink-0 gap-0.5">
							{p.environments.map((e) => (
								<EnvDot key={e.id} env={e} className="size-1.5" />
							))}
						</span>
						<span className="truncate">
							{envs === 1 ? p.environments[0]?.name : `${envs} environments`}
						</span>
					</span>
				</div>
			</div>
		</Link>
	);
}
