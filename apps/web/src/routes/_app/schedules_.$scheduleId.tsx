import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	useNavigate,
} from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { CalendarClock, Pencil, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import {
	OutputPane,
	RunNowButton,
	RunStatusLabel,
	TargetLabel,
	TruncatedNote,
} from "@/components/backups/schedule-parts";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ConfirmDelete } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api";
import {
	type ScheduleDetail,
	type ScheduleRun,
	scheduleQuery,
	useDeleteSchedule,
	useScheduleRun,
	useUpdateSchedule,
} from "@/lib/api/backups";
import { describeCron, formatInZone } from "@/lib/cron";
import { formatDuration, relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/schedules_/$scheduleId")({
	validateSearch: z.object({ run: z.string().optional() }),
	loader: async ({ context, params }) => {
		try {
			const s = await context.queryClient.ensureQueryData(
				scheduleQuery(params.scheduleId),
			);
			return { crumb: s.name };
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
	component: ScheduleDetailPage,
});

const col = createColumnHelper<BaseFeatures, ScheduleRun>();

const duration = (r: ScheduleRun) =>
	r.durationMs === null ? null : formatDuration(r.durationMs / 1000);

function columns(scheduleId: string, selected: string | undefined) {
	return col.columns([
		col.display({
			id: "started",
			header: "Started",
			meta: { className: "w-[24%] max-sm:w-auto" },
			cell: ({ row: { original: r } }) => (
				<Link
					to="/schedules/$scheduleId"
					params={{ scheduleId }}
					search={{ run: r.id }}
					replace
					resetScroll={false}
					aria-current={r.id === selected ? "true" : undefined}
					className={cn(
						"block truncate tabular hover:underline",
						r.id === selected && "font-medium",
					)}
					title={new Date(r.startedAt).toLocaleString("en-GB")}
				>
					{relativeTime(r.startedAt)}
				</Link>
			),
		}),
		col.display({
			id: "status",
			header: "Status",
			meta: { className: "w-[20%] max-sm:w-auto" },
			cell: ({ row: { original: r } }) => <RunStatusLabel status={r.status} />,
		}),
		col.display({
			id: "trigger",
			header: "Trigger",
			meta: { className: "w-[14%] max-md:hidden" },
			cell: ({ row: { original: r } }) => (
				<span className="text-muted-foreground">
					{r.trigger === "cron" ? "Schedule" : "By hand"}
				</span>
			),
		}),
		col.display({
			id: "exit",
			header: "Exit",
			meta: { className: "w-[12%] max-md:hidden" },
			cell: ({ row: { original: r } }) => (
				<span
					className={cn(
						"font-mono text-xs",
						r.exitCode ? "text-bad-text" : "text-muted-foreground",
					)}
				>
					{r.exitCode ?? "–"}
				</span>
			),
		}),
		col.display({
			id: "duration",
			header: "Duration",
			meta: { className: "w-[14%] max-sm:hidden" },
			cell: ({ row: { original: r } }) => (
				<span className="tabular">{duration(r) ?? "–"}</span>
			),
		}),
		col.display({
			id: "output",
			header: "Output",
			meta: { className: "text-right max-md:hidden" },
			cell: ({ row: { original: r } }) => (
				<span className="text-muted-foreground tabular">
					{formatBytes(r.outputBytes, true)}
				</span>
			),
		}),
	]);
}

function Fact({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="min-w-0">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-0.5 truncate text-sm tabular">{children}</dd>
		</div>
	);
}

function RunViewer({
	runId,
	schedule,
}: {
	runId: string;
	schedule: ScheduleDetail;
}) {
	const { run, live } = useScheduleRun(runId);
	const now = useNow(1000, run?.status === "running");
	const running = run?.status === "running";
	const text = running ? live || run?.output || "" : (run?.output ?? live);
	const elapsed = run
		? (run.durationMs ?? now - new Date(run.startedAt).getTime())
		: null;
	return (
		<Panel
			title={
				run
					? `Run from ${formatInZone(run.startedAt, schedule.timezone)}`
					: "Run"
			}
			actions={run && <RunStatusLabel status={run.status} />}
			bodyClassName="divide-y"
		>
			<dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-4">
				<Fact label="Trigger">
					{run ? (run.trigger === "cron" ? "Schedule" : "By hand") : "–"}
				</Fact>
				<Fact label="Exit code">
					<span
						className={cn(
							"font-mono text-xs",
							run?.exitCode && "text-bad-text",
						)}
					>
						{run?.exitCode ?? (running ? "…" : "–")}
					</span>
				</Fact>
				<Fact label={running ? "Running for" : "Duration"}>
					{elapsed === null ? "–" : formatDuration(elapsed / 1000)}
				</Fact>
				<Fact label="Output">
					{running ? "Streaming" : formatBytes(run?.outputBytes ?? null, true)}
				</Fact>
			</dl>
			{run?.error && (
				<p className="bg-bad/8 px-4 py-2.5 text-sm text-bad-text">
					{run.error}
				</p>
			)}
			<OutputPane
				text={text}
				running={running}
				empty={
					run?.status === "skipped"
						? "Skipped runs don't start, so there is no output."
						: running
							? "Waiting for the first line…"
							: "This run printed nothing."
				}
			/>
			{run &&
				run.outputBytes !== null &&
				run.outputBytes > run.outputLimitBytes && (
					<div className="px-4 py-2.5">
						<TruncatedNote
							outputBytes={run.outputBytes}
							limit={run.outputLimitBytes}
						/>
					</div>
				)}
		</Panel>
	);
}

function Header({ s }: { s: ScheduleDetail }) {
	const update = useUpdateSchedule();
	const remove = useDeleteSchedule();
	const navigate = useNavigate();
	const [deleting, setDeleting] = useState(false);
	const switchId = useId();
	const now = useNow(30_000);
	return (
		<>
			<PageHeader
				title={s.name}
				description={
					<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<TargetLabel target={s.target} />
						<span className="whitespace-nowrap">
							<span aria-hidden>· </span>
							{describeCron(s.cron) ?? (
								<span className="font-mono text-xs">{s.cron}</span>
							)}
						</span>
						<span className="whitespace-nowrap tabular">
							<span aria-hidden>· </span>
							{s.nextRunAt
								? `next ${relativeTime(s.nextRunAt, now)}`
								: "paused"}
						</span>
					</span>
				}
				actions={
					<>
						<label
							htmlFor={switchId}
							className="mr-1 flex items-center gap-2 text-sm text-muted-foreground"
						>
							Enabled
							<Switch
								id={switchId}
								checked={s.enabled}
								disabled={update.isPending}
								onCheckedChange={(enabled) =>
									update.mutate(
										{ id: s.id, enabled },
										{
											onError: (e) =>
												toast.error("Couldn't change the schedule", {
													description: e.message,
												}),
										},
									)
								}
							/>
						</label>
						<Button
							variant="ghost"
							size="icon"
							aria-label={`Delete ${s.name}`}
							onClick={() => setDeleting(true)}
						>
							<Trash2 />
						</Button>
						<Button variant="outline" asChild>
							<Link
								to="/schedules/$scheduleId/edit"
								params={{ scheduleId: s.id }}
							>
								<Pencil data-icon="inline-start" />
								Edit
							</Link>
						</Button>
						<RunNowButton s={s} variant="outline" label />
					</>
				}
			/>
			<ConfirmDelete
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete ${s.name}?`}
				description="It stops running and its run history and output are deleted. Nothing it changed is undone."
				action="Delete schedule"
				onConfirm={async () => {
					await remove.mutateAsync(s.id);
					toast.success(`${s.name} deleted`);
					await navigate({ to: "/schedules" });
				}}
			/>
		</>
	);
}

function ScheduleDetailPage() {
	const { scheduleId } = Route.useParams();
	const { run } = Route.useSearch();
	const { data: s } = useQuery(scheduleQuery(scheduleId));
	if (!s) return null;
	const selected = run ?? s.runs[0]?.id;
	return (
		<Page>
			<Header s={s} />
			{s.runs.length === 0 ? (
				<EmptyState
					icon={CalendarClock}
					title="No runs yet"
					description={
						s.nextRunAt
							? `The first run starts ${relativeTime(s.nextRunAt)}, or run it by hand now.`
							: "It's paused. Run it by hand to try the script."
					}
				>
					<RunNowButton s={s} variant="outline" label />
				</EmptyState>
			) : (
				<div className="grid gap-8">
					{selected && (
						<RunViewer key={selected} runId={selected} schedule={s} />
					)}
					<Panel
						title="History"
						actions={
							<span className="text-xs text-muted-foreground">
								Newest {s.runs.length} runs
							</span>
						}
					>
						<DataTable
							label="Run history"
							columns={columns(s.id, selected)}
							data={s.runs}
							getRowId={(r) => r.id}
						/>
					</Panel>
				</div>
			)}
		</Page>
	);
}
