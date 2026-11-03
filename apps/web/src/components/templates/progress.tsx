import type { Template } from "@logistack/contracts";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	ArrowRight,
	Box,
	CircleAlert,
	CircleCheck,
	Database,
	ExternalLink,
	Loader2,
} from "lucide-react";
import { DeploymentStatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	deploymentQuery,
	type TemplateDeployResult,
} from "@/lib/api/templates";
import type { EnvironmentId, ProjectId, ServiceId } from "@/lib/api/types";
import { DEPLOYMENT_STATUS } from "@/lib/status";
import { publicRoutes } from "@/lib/templates";

/** One row per created service, in dependency order, each polling its own deployment. */
export function DeployProgress({
	result,
	template: t,
	projectId,
	environmentId,
}: {
	result: TemplateDeployResult;
	template: Template;
	projectId: ProjectId;
	environmentId: EnvironmentId;
}) {
	const deployments = useQueries({
		queries: result.services.map((s) => ({
			...deploymentQuery(s.deploymentId ?? ""),
			enabled: s.deploymentId !== null,
		})),
	});
	const statuses = deployments.map((q) => q.data?.status);
	const pending = result.services.filter(
		(s, i) =>
			s.deploymentId && (!statuses[i] || DEPLOYMENT_STATUS[statuses[i]].live),
	).length;
	const failed = statuses.filter(
		(s) => s === "failed" || s === "cancelled",
	).length;
	const done = pending === 0;
	const primaryName = publicRoutes(t).find(
		(r) => r.input.role === "primary",
	)?.service;
	const primaryHost = result.services.find(
		(s) => s.name === primaryName,
	)?.hostname;
	const ready = result.services.length - pending - failed;

	const heading = !result.created
		? `${t.name} is already in this environment`
		: failed
			? `${t.name} didn't start`
			: done
				? `${t.name} is running`
				: `Deploying ${t.name}`;

	return (
		<div className="grid grid-cols-1 max-w-3xl gap-6">
			<div className="flex items-start gap-3" aria-live="polite">
				<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
					{failed ? (
						<CircleAlert className="t-reveal size-5 text-bad-text" />
					) : done ? (
						<CircleCheck className="t-reveal size-5 text-ok-text" />
					) : (
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					)}
				</span>
				<div className="min-w-0">
					<h2 key={heading} className="t-swap text-lg font-semibold">
						{heading}
					</h2>
					<p className="mt-0.5 text-sm text-muted-foreground">
						{!result.created ? (
							"Nothing new was created. These are the services from the first deploy."
						) : failed ? (
							"Open the failed service to read its deployment log, fix it there and redeploy."
						) : done ? (
							"Every service is healthy."
						) : (
							<>
								<span className="tabular">{ready}</span> of{" "}
								<span className="tabular">{result.services.length}</span> ready.
								Services start in dependency order.
							</>
						)}
					</p>
				</div>
			</div>

			<ol className="divide-y overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				{result.services.map((s, i) => {
					const d = deployments[i]?.data;
					const Icon = s.kind === "database" ? Database : Box;
					return (
						<li key={s.id} className="flex items-center gap-3 px-4 py-3">
							<span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
								<Icon className="size-4" strokeWidth={1.75} aria-hidden />
							</span>
							<div className="min-w-0 flex-1">
								<Link
									to="/projects/$projectId/services/$serviceId"
									params={{ projectId, serviceId: s.id as ServiceId }}
									className="text-sm font-medium underline-offset-4 hover:underline"
								>
									{s.name}
								</Link>
								{s.hostname && (
									<span className="block truncate font-mono text-xs text-muted-foreground">
										{s.hostname}
									</span>
								)}
								{d?.error && (
									<span className="block text-xs text-bad-text">{d.error}</span>
								)}
							</div>
							{s.deploymentId === null ? (
								<span className="text-sm text-muted-foreground">Existing</span>
							) : d ? (
								<DeploymentStatusLabel status={d.status} />
							) : (
								<DeploymentStatusLabel status="queued" />
							)}
						</li>
					);
				})}
			</ol>

			<div className="flex flex-wrap items-center gap-2">
				{primaryHost && done && !failed && (
					<Button asChild>
						<a href={`https://${primaryHost}`} target="_blank" rel="noreferrer">
							Open {primaryHost}
							<ExternalLink data-icon="inline-end" />
						</a>
					</Button>
				)}
				<Button asChild variant="outline">
					<Link
						to="/projects/$projectId"
						params={{ projectId }}
						search={{ env: environmentId }}
					>
						Go to the environment
						<ArrowRight data-icon="inline-end" />
					</Link>
				</Button>
			</div>
		</div>
	);
}
