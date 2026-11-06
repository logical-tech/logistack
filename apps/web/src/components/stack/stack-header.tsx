import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	ExternalLink,
	MoreHorizontal,
	Play,
	Rocket,
	RotateCw,
	Square,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field } from "@/components/field";
import { StackGlyph } from "@/components/service/service-icon";
import { SignalStrip } from "@/components/signal-strip";
import { ServiceStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { primaryOf, type StackDetail, useDeleteStack } from "@/lib/api/stacks";
import type { ObservedStatus, ProjectId, Service } from "@/lib/api/types";
import { severityRank } from "@/lib/status";

type Op = "deploy" | "restart" | "stop" | "start";

const VERB: Record<Op, { doing: string; failed: string }> = {
	deploy: { doing: "Deploying", failed: "deploy" },
	restart: { doing: "Restarting", failed: "restart" },
	stop: { doing: "Stopping", failed: "stop" },
	start: { doing: "Starting", failed: "start" },
};

/** The worst observed status among the containers: what the stack as a whole is. */
export const stackStatus = (services: Service[]) =>
	services.reduce<ObservedStatus>(
		(w, s) =>
			severityRank(s.status.observed) < severityRank(w) ? s.status.observed : w,
		"stopped",
	);

/** Runs `op` on every container at once; one toast reports how many it reached. */
function useBulk(stack: StackDetail) {
	const qc = useQueryClient();
	const [pending, setPending] = useState<Op | null>(null);
	const run = async (op: Op, targets: Service[]) => {
		setPending(op);
		const results = await Promise.allSettled(
			targets.map((s) => api.serviceOps[op](s.id)),
		);
		setPending(null);
		await Promise.all(
			[["stacks"], ["services"], ["service"], ["projects"]].map((queryKey) =>
				qc.invalidateQueries({ queryKey }),
			),
		);
		const failed = results.flatMap((r, i) =>
			r.status === "rejected" ? [targets[i]?.name] : [],
		);
		if (!failed.length)
			toast.success(
				`${VERB[op].doing} ${targets.length} ${targets.length === 1 ? "container" : "containers"} of ${stack.name}`,
			);
		else
			toast.error(`Couldn't ${VERB[op].failed} ${failed.join(", ")}`, {
				description:
					op === "restart"
						? "A container restarts only after one healthy deployment. Deploy it instead."
						: "Open the container to see why.",
			});
	};
	return { run, pending };
}

export function StackHeader({
	stack,
	projectId,
}: {
	stack: StackDetail;
	projectId: ProjectId;
}) {
	const navigate = useNavigate();
	const [confirm, setConfirm] = useState<"restart" | "stop" | "delete" | null>(
		null,
	);
	const [typed, setTyped] = useState("");
	const remove = useDeleteStack();
	const { run, pending } = useBulk(stack);
	const services = stack.services;
	const primary = primaryOf(services);
	const status = stackStatus(services);
	const running = services.filter((s) => s.status.observed === "running");
	const allStopped = services.every((s) => s.desiredState === "stopped");
	const host = primary?.domains[0];

	return (
		<header className="flex flex-col gap-4 pb-5 sm:flex-row sm:items-end sm:justify-between">
			<div className="flex min-w-0 items-center gap-3.5">
				{primary && <StackGlyph service={primary} large />}
				<div className="min-w-0">
					<h1 className="truncate text-xl font-semibold">{stack.name}</h1>
					<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
						<ServiceStatus
							status={status}
							suffix={
								running.length < services.length
									? `${running.length}/${services.length}`
									: undefined
							}
						/>
						<SignalStrip
							size="sm"
							className="flex-nowrap"
							services={services.map((s) => ({
								id: s.id,
								name: s.name,
								status: s.status.observed,
							}))}
						/>
						<span>
							{services.length}{" "}
							{services.length === 1 ? "container" : "containers"} ·{" "}
							{stack.git ? (
								<span className="font-mono text-xs">
									{stack.git.repository}@{stack.git.branch}
								</span>
							) : stack.source === "compose" ? (
								"Compose file"
							) : stack.templateId ? (
								<Link
									to="/projects/$projectId/templates/$templateId"
									params={{ projectId, templateId: stack.templateId }}
									search={{ env: stack.environmentId }}
									className="underline-offset-4 hover:text-foreground hover:underline"
								>
									Template
								</Link>
							) : (
								"Template"
							)}
						</span>
						{host && (
							<a
								href={`https://${host}`}
								target="_blank"
								rel="noreferrer"
								className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-foreground underline-offset-4 hover:underline"
							>
								<span className="truncate">{host}</span>
								<ExternalLink className="size-3 shrink-0" aria-hidden />
							</a>
						)}
					</div>
				</div>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				{allStopped ? (
					<Button
						variant="outline"
						disabled={pending !== null}
						onClick={() => run("start", services)}
					>
						<Play data-icon="inline-start" />
						Start
						<span className="max-sm:hidden"> all</span>
					</Button>
				) : (
					<Button
						variant="outline"
						disabled={pending !== null}
						onClick={() => setConfirm("stop")}
					>
						<Square data-icon="inline-start" />
						Stop
						<span className="max-sm:hidden"> all</span>
					</Button>
				)}
				<Button
					variant="outline"
					disabled={pending !== null}
					onClick={() => setConfirm("restart")}
				>
					<RotateCw data-icon="inline-start" />
					Restart
					<span className="max-sm:hidden"> all</span>
				</Button>
				<Button
					disabled={pending !== null}
					onClick={() => run("deploy", services)}
				>
					<Rocket data-icon="inline-start" />
					Deploy
					<span className="max-sm:hidden"> all</span>
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" aria-label="More actions">
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							variant="destructive"
							onSelect={() => setConfirm("delete")}
						>
							<Trash2 />
							Delete stack…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<ConfirmDialog
				open={confirm === "restart"}
				onOpenChange={(open) => !open && setConfirm(null)}
				title={`Restart every container of ${stack.name}?`}
				description="Each container's replicas are replaced on their current image, one at a time. No build runs."
				confirmLabel="Restart all"
				destructive={false}
				pending={pending === "restart"}
				onConfirm={() => {
					setConfirm(null);
					void run(
						"restart",
						services.filter((s) => s.latestDeployment !== null),
					);
				}}
			/>
			<ConfirmDialog
				open={confirm === "stop"}
				onOpenChange={(open) => !open && setConfirm(null)}
				title={`Stop ${stack.name}?`}
				description="Every container scales to zero and its domains leave the proxy. Data, volumes and configuration stay; Start all brings it back."
				confirmLabel="Stop all"
				pending={pending === "stop"}
				onConfirm={() => {
					setConfirm(null);
					void run(
						"stop",
						services.filter((s) => s.desiredState !== "stopped"),
					);
				}}
			/>
			<ConfirmDialog
				open={confirm === "delete"}
				onOpenChange={(open) => {
					if (!open) {
						setConfirm(null);
						setTyped("");
					}
				}}
				title={`Delete ${stack.name}?`}
				description={`Its ${services.length} containers, their domains, environment variables and deployments are removed. This cannot be undone.`}
				confirmLabel="Delete stack"
				pending={remove.isPending}
				confirmDisabled={typed !== stack.name}
				onConfirm={() =>
					remove.mutate(stack.id, {
						onSuccess: () => {
							toast.success(`Deleted ${stack.name}`);
							void navigate({
								to: "/projects/$projectId",
								params: { projectId },
								search: { env: stack.environmentId },
							});
						},
						onError: (e) =>
							toast.error("Couldn't delete the stack", {
								description: e instanceof Error ? e.message : undefined,
							}),
					})
				}
			>
				<Field
					id="stack-delete-confirm"
					label={`Type ${stack.name} to confirm`}
				>
					<Input
						id="stack-delete-confirm"
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						placeholder={stack.name}
						autoCapitalize="none"
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
					/>
				</Field>
			</ConfirmDialog>
		</header>
	);
}
