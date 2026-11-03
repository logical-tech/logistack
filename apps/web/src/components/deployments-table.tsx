import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { GitCommitHorizontal } from "lucide-react";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { DeploymentStatusLabel } from "@/components/status";
import type { DeploymentListItem, DeploymentTrigger } from "@/lib/api/types";
import { formatDuration, relativeTime } from "@/lib/format";
import { DEPLOYMENT_STATUS } from "@/lib/status";
import { useNow } from "@/lib/use-now";

export const TRIGGER: Record<DeploymentTrigger, string> = {
	manual: "Manual",
	git_push: "Push",
	webhook: "Webhook",
	rollback: "Rollback",
	schedule: "Schedule",
	api: "API",
};

function Duration({ d }: { d: DeploymentListItem }) {
	const live = d.finishedAt === null;
	const now = useNow(1000, live);
	const end = d.finishedAt ? new Date(d.finishedAt).getTime() : now;
	const seconds = (end - new Date(d.startedAt ?? d.createdAt).getTime()) / 1000;
	return (
		<span className="tabular text-muted-foreground">
			{formatDuration(seconds)}
			{live && <span className="sr-only"> so far</span>}
		</span>
	);
}

const col = createColumnHelper<BaseFeatures, DeploymentListItem>();

const columns = col.columns([
	col.accessor("status", {
		header: "Status",
		meta: { className: "w-32" },
		cell: (c) => <DeploymentStatusLabel status={c.getValue()} />,
	}),
	col.display({
		id: "service",
		header: "Service",
		meta: { className: "w-[26%] max-sm:w-[44%]" },
		cell: ({ row: { original: d } }) => (
			<div className="min-w-0">
				<Link
					to="/projects/$projectId"
					params={{ projectId: d.project.id }}
					search={{ env: d.environment.id }}
					className="block truncate font-medium hover:underline"
				>
					{d.service.name}
				</Link>
				<span className="block truncate text-xs text-muted-foreground">
					{d.project.name} · {d.environment.name}
				</span>
			</div>
		),
	}),
	col.display({
		id: "commit",
		header: "Commit",
		meta: { className: "max-md:hidden" },
		cell: ({ row: { original: d } }) =>
			d.commitSha ? (
				<div className="flex min-w-0 items-center gap-2">
					<GitCommitHorizontal
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<span className="shrink-0 font-mono text-xs text-muted-foreground">
						{d.commitSha.slice(0, 7)}
					</span>
					<span className="truncate" title={d.commitMessage ?? undefined}>
						{d.commitMessage}
					</span>
				</div>
			) : (
				<span className="truncate whitespace-nowrap text-muted-foreground">
					Image redeploy
				</span>
			),
	}),
	col.accessor("trigger", {
		header: "Trigger",
		meta: { className: "w-24 max-lg:hidden" },
		cell: (c) => (
			<span className="text-muted-foreground">{TRIGGER[c.getValue()]}</span>
		),
	}),
	col.display({
		id: "duration",
		header: "Duration",
		meta: { className: "w-24 max-sm:hidden text-right" },
		cell: ({ row: { original: d } }) => <Duration d={d} />,
	}),
	// A queued deployment has not started; its age counts from when it was queued.
	col.accessor((d) => d.startedAt ?? d.createdAt, {
		id: "startedAt",
		header: "Started",
		meta: { className: "w-28 text-right" },
		cell: (c) => (
			<time
				dateTime={c.getValue()}
				title={new Date(c.getValue()).toLocaleString()}
				className="whitespace-nowrap text-muted-foreground"
			>
				{relativeTime(c.getValue())}
			</time>
		),
	}),
]);

export function DeploymentsTable({ data }: { data: DeploymentListItem[] }) {
	return (
		<DataTable
			label="Recent deployments"
			columns={columns}
			data={data}
			getRowId={(d) => d.id}
			empty={
				<span className="text-sm text-muted-foreground">
					No deployments yet.
				</span>
			}
		/>
	);
}

export const isInFlight = (d: { status: DeploymentListItem["status"] }) =>
	DEPLOYMENT_STATUS[d.status].live === true;
