import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, History, Rocket, Undo2, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TRIGGER } from "@/components/deployments-table";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/panel";
import { LogViewer } from "@/components/service/log-viewer";
import { DeploymentStatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api";
import {
	type DeploymentRow,
	deploymentsQuery,
	isRunning,
	overviewQuery,
	useLogStream,
	useServiceMutation,
} from "@/lib/api/service-ops";
import { formatDuration, relativeTime, shortImage } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/deployments",
)({
	validateSearch: z.object({
		d: z.string().startsWith("dep_").optional().catch(undefined),
	}),
	component: DeploymentsTab,
});

const CANCELLABLE = new Set([
	"awaiting_checks",
	"queued",
	"cloning",
	"building",
	"pushing",
]);

function Duration({ d }: { d: DeploymentRow }) {
	const live = d.finishedAt === null && d.startedAt !== null;
	const now = useNow(1000, live);
	if (!d.startedAt) return null;
	const end = d.finishedAt ? Date.parse(d.finishedAt) : now;
	return (
		<span className="tabular">
			{formatDuration((end - Date.parse(d.startedAt)) / 1000)}
		</span>
	);
}

function What({ d }: { d: DeploymentRow }) {
	if (d.commitSha || d.gitRef)
		return (
			<>
				<span className="font-mono text-xs text-muted-foreground">
					{d.gitRef ?? d.commitSha?.slice(0, 7)}
				</span>{" "}
				{d.commitMessage}
			</>
		);
	return (
		<span className="font-mono text-xs" title={d.imageRef ?? undefined}>
			{d.imageRef ? shortImage(d.imageRef) : "Image from the service's source"}
		</span>
	);
}

function DeploymentsTab() {
	const { serviceId, projectId } = Route.useParams();
	const { d: selectedId } = Route.useSearch();
	const mobile = useIsMobile();
	const { data: service } = useQuery(overviewQuery(serviceId));
	const { data: deployments } = useQuery(deploymentsQuery(serviceId));

	if (!deployments) {
		return (
			<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
				<SkeletonRows rows={5} />
			</div>
		);
	}
	if (deployments.length === 0) {
		return (
			<EmptyState
				icon={Rocket}
				title="No deployments yet"
				description="Deploy builds the source, or pulls the image, and rolls it out replica by replica."
			/>
		);
	}

	// On a phone the list and the log take turns; elsewhere the newest is open by default.
	const selected =
		deployments.find((d) => d.id === selectedId) ??
		(mobile ? undefined : deployments[0]);
	const params = { projectId, serviceId };

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
			<nav
				aria-label="Deployments"
				className={cn(
					"min-w-0 self-start overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border",
					mobile && selected && "hidden",
				)}
			>
				<ul className="max-h-[min(72vh,44rem)] divide-y overflow-y-auto">
					{deployments.map((d) => {
						const active = d.id === selected?.id;
						return (
							<li key={d.id}>
								<Link
									to="."
									search={{ d: d.id }}
									replace
									aria-current={active ? "page" : undefined}
									className={cn(
										"relative grid gap-1 px-4 py-3 outline-none transition-colors duration-(--duration-quick) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
										active
											? "bg-muted/70 dark:bg-muted/50"
											: "hover:bg-muted/40",
									)}
								>
									<span className="flex items-center justify-between gap-3">
										<DeploymentStatusLabel status={d.status} />
										<time
											dateTime={d.createdAt}
											className="shrink-0 text-xs text-muted-foreground"
										>
											{relativeTime(d.createdAt)}
										</time>
									</span>
									<span className="truncate text-sm">
										<What d={d} />
									</span>
									<span className="flex items-center gap-2 text-xs text-muted-foreground">
										<span className="shrink-0">{TRIGGER[d.trigger]}</span>
										{d.reason && (
											<span className="min-w-0 truncate" title={d.reason}>
												{d.reason}
											</span>
										)}
										{d.id === service?.current?.id && (
											<span className="text-ok-text">Current</span>
										)}
										<span className="ml-auto">
											<Duration d={d} />
										</span>
									</span>
								</Link>
							</li>
						);
					})}
				</ul>
			</nav>
			{selected && (
				<Detail
					key={selected.id}
					d={selected}
					isCurrent={selected.id === service?.current?.id}
					back={
						mobile && (
							<Button variant="ghost" size="sm" asChild>
								<Link to="." params={params} search={{}} replace>
									<ArrowLeft data-icon="inline-start" />
									All deployments
								</Link>
							</Button>
						)
					}
				/>
			)}
		</div>
	);
}

function Detail({
	d,
	isCurrent,
	back,
}: {
	d: DeploymentRow;
	isCurrent: boolean;
	back: ReactNode;
}) {
	const navigate = useNavigate({ from: Route.fullPath });
	const { lines, ended } = useLogStream({ kind: "deployment", id: d.id });
	const [confirm, setConfirm] = useState(false);
	const cancel = useServiceMutation(d.serviceId, () =>
		api.serviceOps.cancel(d.id),
	);
	const rollback = useServiceMutation(d.serviceId, () =>
		api.serviceOps.rollback(d.id),
	);
	const running = isRunning(d);
	const canRollback = d.status === "healthy" && !!d.imageRef && !isCurrent;

	return (
		<section
			aria-label="Deployment log"
			className="flex min-w-0 flex-col gap-3"
		>
			{back && <div>{back}</div>}
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<DeploymentStatusLabel status={d.status} className="font-medium" />
						<span className="font-mono text-xs text-muted-foreground">
							{d.id}
						</span>
					</div>
					<p className="mt-1 truncate text-sm text-muted-foreground">
						{TRIGGER[d.trigger]} ·{" "}
						<time
							dateTime={d.createdAt}
							title={new Date(d.createdAt).toLocaleString()}
						>
							{relativeTime(d.createdAt)}
						</time>
						{d.startedAt && (
							<>
								{" "}
								· <Duration d={d} />
							</>
						)}
					</p>
				</div>
				<div className="flex shrink-0 gap-2">
					{CANCELLABLE.has(d.status) && (
						<Button
							variant="outline"
							size="sm"
							disabled={cancel.isPending}
							onClick={() =>
								cancel.mutate(undefined, {
									onSuccess: () => toast.success("Deployment cancelled"),
									onError: (e) =>
										toast.error("Couldn't cancel", { description: e.message }),
								})
							}
						>
							<X data-icon="inline-start" />
							Cancel
						</Button>
					)}
					{canRollback && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setConfirm(true)}
						>
							<Undo2 data-icon="inline-start" />
							Roll back to this
						</Button>
					)}
				</div>
			</div>
			{d.error && (
				<p className="rounded-lg bg-[color-mix(in_oklch,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-bad-text">
					{d.error}
				</p>
			)}
			{d.reason && (
				<p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
					{d.reason}
				</p>
			)}
			<LogViewer
				lines={lines}
				live={running && !ended}
				empty="This deployment wrote no output."
				status={
					running ? (
						<span className="flex items-center gap-1.5">
							<History className="size-3.5" aria-hidden />
							Replayed from the start, following live
						</span>
					) : (
						"Complete log"
					)
				}
				className="h-[min(68vh,42rem)] max-sm:h-[70vh]"
			/>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title="Roll back to this deployment?"
				description={
					<>
						A new rollback deployment runs{" "}
						<code className="font-mono text-xs">{d.imageRef}</code> again, with
						no build. The current variables and settings apply.
					</>
				}
				confirmLabel="Roll back"
				destructive={false}
				pending={rollback.isPending}
				onConfirm={() =>
					rollback.mutate(undefined, {
						onSuccess: (next) => {
							setConfirm(false);
							toast.success("Rollback queued");
							navigate({ search: { d: next.id }, replace: true });
						},
						onError: (e) =>
							toast.error("Couldn't roll back", { description: e.message }),
					})
				}
			/>
		</section>
	);
}
