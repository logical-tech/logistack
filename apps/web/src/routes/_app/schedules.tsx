import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
	RunNowButton,
	RunStatusLabel,
	TargetLabel,
} from "@/components/backups/schedule-parts";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	type Schedule,
	schedulesQuery,
	useUpdateSchedule,
} from "@/lib/api/backups";
import { describeCron } from "@/lib/cron";
import { relativeTime } from "@/lib/format";
import { section } from "@/lib/nav";
import { RUN_STATUS } from "@/lib/status";
import { useNow } from "@/lib/use-now";

export const Route = createFileRoute("/_app/schedules")({
	staticData: { crumb: "Schedules" },
	loader: ({ context }) => context.queryClient.prefetchQuery(schedulesQuery),
	component: SchedulesPage,
});

const SECTION = section("/schedules");
const col = createColumnHelper<BaseFeatures, Schedule>();

function When({ s }: { s: Schedule }) {
	const now = useNow(30_000);
	return (
		<div className="min-w-0">
			<span className="block truncate">
				{describeCron(s.cron) ?? (
					<span className="font-mono text-xs">{s.cron}</span>
				)}
			</span>
			<span className="block truncate text-xs text-muted-foreground tabular">
				{s.nextRunAt ? `Next ${relativeTime(s.nextRunAt, now)}` : "Paused"}
				{s.timezone !== "UTC" && ` · ${s.timezone.replaceAll("_", " ")}`}
			</span>
		</div>
	);
}

function EnabledSwitch({ s }: { s: Schedule }) {
	const update = useUpdateSchedule();
	return (
		<Switch
			checked={
				update.isPending ? (update.variables?.enabled ?? s.enabled) : s.enabled
			}
			disabled={update.isPending}
			aria-label={`${s.enabled ? "Pause" : "Enable"} ${s.name}`}
			onCheckedChange={(enabled) =>
				update.mutate(
					{ id: s.id, enabled },
					{
						onSuccess: () =>
							toast.success(
								enabled ? `${s.name} enabled` : `${s.name} paused`,
								{
									description: enabled
										? "It runs again on its schedule."
										: "History stays. It can still be run by hand.",
								},
							),
						onError: (e) =>
							toast.error(
								`Couldn't ${enabled ? "enable" : "pause"} ${s.name}`,
								{
									description: e.message,
								},
							),
					},
				)
			}
		/>
	);
}

const COLUMNS = col.columns([
	col.display({
		id: "name",
		header: "Schedule",
		meta: { className: "w-[34%] max-md:w-auto" },
		cell: ({ row: { original: s } }) => (
			<div className="min-w-0">
				<span className="flex min-w-0 items-center gap-2">
					{s.lastRun && (
						<StatusDot
							meta={RUN_STATUS[s.lastRun.status]}
							className="sm:hidden"
						/>
					)}
					<Link
						to="/schedules/$scheduleId"
						params={{ scheduleId: s.id }}
						className="truncate font-medium hover:underline"
					>
						{s.name}
						{s.lastRun && (
							<span className="sr-only sm:hidden">
								, last run {RUN_STATUS[s.lastRun.status].label.toLowerCase()}
							</span>
						)}
					</Link>
				</span>
				<TargetLabel
					target={s.target}
					className="max-w-full text-xs text-muted-foreground"
				/>
			</div>
		),
	}),
	col.display({
		id: "when",
		header: "When",
		meta: { className: "w-[26%] max-md:hidden" },
		cell: ({ row: { original: s } }) => <When s={s} />,
	}),
	col.display({
		id: "last",
		header: "Last run",
		meta: { className: "w-[20%] max-sm:hidden" },
		cell: ({ row: { original: s } }) =>
			s.lastRun ? (
				<div className="min-w-0">
					<RunStatusLabel status={s.lastRun.status} />
					<span className="block truncate text-xs text-muted-foreground">
						{relativeTime(s.lastRun.startedAt)}
						{s.lastRun.trigger === "manual" && " · by hand"}
					</span>
				</div>
			) : (
				<span className="text-muted-foreground">Never</span>
			),
	}),
	col.display({
		id: "actions",
		header: () => <span className="sr-only">Enabled and run</span>,
		meta: { className: "w-28 text-right max-md:w-24" },
		cell: ({ row: { original: s } }) => (
			<div className="flex items-center justify-end gap-3">
				<EnabledSwitch s={s} />
				<RunNowButton s={s} />
			</div>
		),
	}),
]);

function SchedulesPage() {
	const { data } = useQuery(schedulesQuery);
	const empty = SECTION.empty;
	const add = (
		<Button asChild>
			<Link to="/schedules/new">
				<Plus data-icon="inline-start" />
				New schedule
			</Link>
		</Button>
	);
	return (
		<Page>
			<PageHeader
				title={SECTION.title}
				description={SECTION.description}
				actions={data?.length ? add : undefined}
			/>
			{!data ? (
				<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					<SkeletonRows rows={4} />
				</div>
			) : data.length ? (
				<Panel
					title={`${data.length} ${data.length === 1 ? "schedule" : "schedules"}`}
					actions={
						<span className="text-xs text-muted-foreground tabular">
							{data.filter((s) => s.lastRun?.status === "failed").length ||
								"None"}{" "}
							failing
						</span>
					}
				>
					<DataTable
						label="Schedules"
						columns={COLUMNS}
						data={data}
						getRowId={(s) => s.id}
					/>
				</Panel>
			) : (
				empty && (
					<EmptyState
						icon={SECTION.icon}
						title={empty.title}
						description={empty.body}
					>
						{add}
					</EmptyState>
				)
			)}
		</Page>
	);
}
