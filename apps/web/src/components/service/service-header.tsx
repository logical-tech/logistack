import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FileDiff, Layers, Play, Rocket, RotateCw, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AnimatedNumber } from "@/components/animated-number";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EnvDot } from "@/components/projects/env-color";
import {
	changeCount,
	PendingChangesDialog,
} from "@/components/service/pending-changes";
import { ServiceGlyph } from "@/components/service/service-icon";
import { ServiceStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { projectQuery } from "@/lib/api/projects";
import {
	type DeploymentRow,
	pendingDiffQuery,
	type ServiceOverview,
	useServiceMutation,
} from "@/lib/api/service-ops";
import type { StackId } from "@/lib/api/stacks";
import type { ProjectId } from "@/lib/api/types";

/** What the service runs, in one line: its source; the built image lives on the overview. */
function sourceLabel(o: ServiceOverview) {
	const spec = o.spec;
	if (spec.kind === "database") return `${spec.engine} ${spec.version}`;
	if (spec.kind === "storage") return `${spec.engine} object storage`;
	if (spec.source.type === "image") return spec.source.image;
	if (spec.source.type === "inline") return "Compose file";
	return `${spec.source.repository}@${spec.source.branch}`;
}

/** Desired and observed disagree while the reconciler converges, or when it cannot. */
function convergence(o: ServiceOverview) {
	const observed = o.status.observed;
	if (o.desiredState === "stopped" && observed !== "stopped") return "stopping";
	if (o.desiredState === "running" && observed === "stopped") return "starting";
	return null;
}

const errorText = (e: unknown) =>
	e instanceof Error ? e.message : "Something went wrong.";

type Confirm = "restart" | "stop" | "review" | null;

export function ServiceHeader({
	service: o,
	projectId,
}: {
	service: ServiceOverview;
	projectId: ProjectId;
}) {
	const navigate = useNavigate();
	const [confirm, setConfirm] = useState<Confirm>(null);
	const openLog = (d: DeploymentRow) =>
		navigate({
			to: "/projects/$projectId/services/$serviceId/deployments",
			params: { projectId, serviceId: o.id },
			search: { d: d.id },
		});
	const deploy = useServiceMutation(o.id, () => api.serviceOps.deploy(o.id));
	const restart = useServiceMutation(o.id, () => api.serviceOps.restart(o.id));
	const stop = useServiceMutation(o.id, () => api.serviceOps.stop(o.id));
	const start = useServiceMutation(o.id, () => api.serviceOps.start(o.id));
	const { data: diff } = useQuery(pendingDiffQuery(o.id));
	const { data: project } = useQuery(projectQuery(projectId));
	const env = project?.environments.find((e) => e.id === o.environmentId);
	const pending = diff?.baseline ? diff.changes.length : 0;
	const runDeploy = () =>
		deploy.mutate(undefined, {
			onSuccess: (d) => {
				setConfirm(null);
				openLog(d);
			},
			onError: (e) =>
				toast.error("Couldn't deploy", { description: errorText(e) }),
		});
	const stopped = o.desiredState === "stopped";
	const note = convergence(o);
	const replicas =
		o.kind === "application" && o.status.replicasDesired > 0
			? `${o.status.replicasRunning}/${o.status.replicasDesired}`
			: undefined;

	return (
		<header className="flex flex-col gap-4 pb-5 sm:flex-row sm:items-end sm:justify-between">
			<div className="flex min-w-0 items-center gap-3.5">
				<ServiceGlyph service={o} className="size-11 rounded-xl" />
				<div className="min-w-0">
					<h1 className="truncate text-xl font-semibold">{o.name}</h1>
					<p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
						<ServiceStatus status={o.status.observed} suffix={replicas} />
						{note && (
							<span className="text-foreground">
								Desired {o.desiredState}, {note}
							</span>
						)}
						{o.stackId ? (
							<Link
								to="/projects/$projectId/stacks/$stackId"
								params={{ projectId, stackId: o.stackId as StackId }}
								className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
							>
								<Layers className="size-3.5" aria-hidden />
								Part of a stack
							</Link>
						) : null}
						<span className="inline-flex items-center gap-1.5">
							{env && <EnvDot env={env} />}
							{o.environmentName}
						</span>
						<span className="min-w-0 truncate font-mono text-xs">
							{sourceLabel(o)}
						</span>
					</p>
				</div>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				{stopped ? (
					<Button
						variant="outline"
						disabled={start.isPending}
						onClick={() =>
							start.mutate(undefined, {
								onSuccess: () => toast.success(`Starting ${o.name}`),
								onError: (e) =>
									toast.error("Couldn't start", { description: errorText(e) }),
							})
						}
					>
						<Play data-icon="inline-start" />
						Start
					</Button>
				) : (
					<Button variant="outline" onClick={() => setConfirm("stop")}>
						<Square data-icon="inline-start" />
						Stop
					</Button>
				)}
				<Button
					variant="outline"
					disabled={!o.current}
					title={o.current ? undefined : "Needs one healthy deployment first"}
					onClick={() => setConfirm("restart")}
				>
					<RotateCw data-icon="inline-start" />
					Restart
				</Button>
				{pending > 0 && (
					<Button variant="outline" onClick={() => setConfirm("review")}>
						<FileDiff data-icon="inline-start" />
						Review changes
					</Button>
				)}
				<Button
					disabled={deploy.isPending}
					onClick={runDeploy}
					aria-label={
						pending > 0 ? `Deploy, ${changeCount(pending)}` : undefined
					}
				>
					<Rocket data-icon="inline-start" />
					Deploy
					{pending > 0 && (
						<span
							aria-hidden
							className="-mr-1 ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-foreground/15 px-1.5 text-xs"
						>
							<AnimatedNumber value={pending} />
						</span>
					)}
				</Button>
			</div>

			{diff?.baseline && (
				<PendingChangesDialog
					diff={diff}
					open={confirm === "review"}
					onOpenChange={(open) => !open && setConfirm(null)}
					onDeploy={runDeploy}
					deploying={deploy.isPending}
				/>
			)}
			<ConfirmDialog
				open={confirm === "restart"}
				onOpenChange={(open) => !open && setConfirm(null)}
				title={`Restart ${o.name}?`}
				description="Each replica is replaced on the current image, one at a time, with the new one started first. No build runs."
				confirmLabel="Restart"
				destructive={false}
				pending={restart.isPending}
				onConfirm={() =>
					restart.mutate(undefined, {
						onSuccess: (d) => {
							setConfirm(null);
							openLog(d);
						},
						onError: (e) =>
							toast.error("Couldn't restart", { description: errorText(e) }),
					})
				}
			/>
			<ConfirmDialog
				open={confirm === "stop"}
				onOpenChange={(open) => !open && setConfirm(null)}
				title={`Stop ${o.name}?`}
				description="It scales to zero replicas and its domains leave the proxy. Data, volumes and configuration stay; Start brings it back."
				confirmLabel="Stop service"
				pending={stop.isPending}
				onConfirm={() =>
					stop.mutate(undefined, {
						onSuccess: () => {
							setConfirm(null);
							toast.success(`Stopping ${o.name}`);
						},
						onError: (e) =>
							toast.error("Couldn't stop", { description: errorText(e) }),
					})
				}
			/>
		</header>
	);
}
