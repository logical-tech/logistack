import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { MetricChart } from "@/components/charts/metric-chart";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-button";
import { Page, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	MONITOR_STATUS,
	pct,
	Stat,
	UptimeBars,
} from "@/components/uptime/parts";
import { Instructions } from "@/components/wizard/parts";
import { useInvalidating } from "@/lib/api/networking";
import {
	daysUntil,
	KIND_LABEL,
	type MonitorDetail,
	monitorQuery,
	monitorTarget,
	pushTokenKey,
	pushUrl,
	uptimeApi,
} from "@/lib/api/uptime";

export const Route = createFileRoute("/_app/monitoring/uptime_/$monitorId")({
	staticData: { crumb: "Monitor" },
	loader: ({ context, params }) => {
		void context.queryClient.prefetchQuery(monitorQuery(params.monitorId));
	},
	component: MonitorPage,
});

const ago = (iso: string | null) => {
	if (!iso) return "never";
	const s = Math.max(
		0,
		Math.round((Date.now() - new Date(iso).getTime()) / 1000),
	);
	if (s < 60) return `${s} s ago`;
	if (s < 3_600) return `${Math.round(s / 60)} min ago`;
	if (s < 86_400) return `${Math.round(s / 3_600)} h ago`;
	return `${Math.round(s / 86_400)} d ago`;
};

function PushSection({ m }: { m: MonitorDetail }) {
	const qc = useQueryClient();
	const token = qc.getQueryData<string>(pushTokenKey(m.id));
	const [shown, setShown] = useState(token);
	const [confirm, setConfirm] = useState(false);
	const rotate = useInvalidating(uptimeApi.rotatePushToken, []);
	const url = shown ? pushUrl(shown) : undefined;
	return (
		<Panel id="push-heading" title="Push URL">
			<div className="grid gap-4 p-4">
				{url ? (
					<>
						<CopyField value={url} label="Push URL" />
						<Instructions>
							<p>
								Shown once. Call it at the end of each run of your job, for
								example from cron:
							</p>
							<pre className="overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-xs text-foreground">
								{`your-job && curl -fsS -m 10 ${url}\n# report a failure:\ncurl -fsS "${url}?status=down&msg=export+failed"`}
							</pre>
						</Instructions>
					</>
				) : (
					<p className="text-sm text-muted-foreground">
						The push URL is shown only once, when it is issued. Last ping{" "}
						<span className="text-foreground">{ago(m.lastPingAt)}</span>. Lost
						it? Issue a new one; the old URL stops working.
					</p>
				)}
				<div>
					<Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
						Issue a new push URL
					</Button>
				</div>
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title="Issue a new push URL?"
				description="Jobs that still call the old URL stop counting, and the monitor goes down after its grace period until you update them."
				confirmLabel="Issue new URL"
				pending={rotate.isPending}
				onConfirm={() =>
					rotate.mutate(m.id, {
						onSuccess: (r) => {
							setShown(r.pushToken);
							setConfirm(false);
						},
						onError: (e) => toast.error(e.message),
					})
				}
			/>
		</Panel>
	);
}

function MonitorPage() {
	const { monitorId } = Route.useParams();
	const navigate = useNavigate();
	const { data: m } = useQuery(monitorQuery(monitorId));
	const remove = useInvalidating(uptimeApi.removeMonitor, [["monitors"]]);
	const update = useInvalidating(uptimeApi.updateMonitor, [["monitors"]]);
	const [confirm, setConfirm] = useState(false);

	if (!m)
		return (
			<Page className="max-w-6xl">
				<div className="t-skel h-8 w-64 rounded bg-muted-foreground/15" />
			</Page>
		);

	const to = Date.now();
	const rows = m.latency.map((l) => ({
		t: new Date(l.hour).getTime(),
		avg: l.avgMs,
		max: l.maxMs,
	}));
	const certDays = m.certExpiresAt ? daysUntil(m.certExpiresAt) : undefined;

	return (
		<Page className="max-w-6xl">
			<PageHeader
				title={
					<span className="flex items-center gap-3">
						{m.name}
						<StatusLabel
							meta={MONITOR_STATUS[m.status]}
							className="text-sm font-normal"
						/>
					</span>
				}
				description={`${KIND_LABEL[m.kind as keyof typeof KIND_LABEL]} · ${monitorTarget(m.config)}`}
				actions={
					<div className="flex gap-2">
						<Button
							variant="ghost"
							onClick={() =>
								update.mutate(
									{ id: m.id, json: { enabled: !m.enabled } },
									{ onError: (e) => toast.error(e.message) },
								)
							}
						>
							{m.enabled ? "Pause" : "Resume"}
						</Button>
						<Button variant="outline" asChild>
							<Link
								to="/monitoring/uptime/$monitorId/edit"
								params={{ monitorId: m.id }}
							>
								Edit
							</Link>
						</Button>
						<Button variant="outline" onClick={() => setConfirm(true)}>
							Delete
						</Button>
					</div>
				}
			/>

			{m.status === "down" && m.lastError && (
				<p className="t-reveal mb-6 rounded-lg bg-bad/10 px-4 py-3 text-sm text-bad-text">
					Down since {new Date(m.statusChangedAt).toLocaleString()}:{" "}
					{m.lastError}
				</p>
			)}

			<dl className="mb-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
				<Stat label="Uptime, 24 hours" value={pct(m.uptime24h)} />
				<Stat label="Uptime, 30 days" value={pct(m.uptime30d)} />
				{certDays !== undefined ? (
					<Stat
						label="Certificate expires in"
						value={certDays < 0 ? "Expired" : `${certDays} days`}
						tone={certDays < 7 ? "bad" : certDays < 30 ? "warn" : undefined}
					/>
				) : (
					<Stat
						label="Last response"
						value={m.lastLatencyMs !== null ? `${m.lastLatencyMs} ms` : "–"}
					/>
				)}
				<Stat label="Last check" value={ago(m.lastCheckAt)} />
			</dl>

			<div className="grid gap-8">
				<Panel id="bars-heading" title="Last 90 days" bodyClassName="p-4">
					<UptimeBars days={m.bars} />
				</Panel>

				{m.kind === "push" && <PushSection m={m} />}

				{m.kind !== "push" && (
					<MetricChart
						title="Response time"
						rows={rows}
						series={[
							{ key: "avg", label: "Average", color: "var(--chart-1)" },
							{
								key: "max",
								label: "Slowest",
								color: "var(--chart-2)",
								dashed: true,
							},
						]}
						format={(v) => `${Math.round(v)} ms`}
						range="7d"
						window={{ from: to - 7 * 86_400_000, to }}
						empty="No checks in the last 7 days."
					/>
				)}

				<Panel id="checks-heading" title="Recent checks">
					{m.checks.length === 0 ? (
						<p className="px-4 py-6 text-sm text-muted-foreground">
							No checks yet.
						</p>
					) : (
						<table className="w-full text-sm">
							<thead className="border-b text-xs text-muted-foreground">
								<tr>
									<th className="px-4 py-2 text-left font-normal">Time</th>
									<th className="px-4 py-2 text-left font-normal">Result</th>
									<th className="px-4 py-2 text-right font-normal">Latency</th>
								</tr>
							</thead>
							<tbody className="divide-y">
								{m.checks.map((c) => (
									<tr key={c.at}>
										<td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground tabular">
											{new Date(c.at).toLocaleTimeString()}
										</td>
										<td className="px-4 py-2.5">
											{c.ok ? (
												<span className="text-foreground">Passed</span>
											) : (
												<span className="text-bad-text">
													{c.error ?? "Failed"}
												</span>
											)}
											{c.maintenance && (
												<span className="ml-2 text-xs text-info-text">
													maintenance
												</span>
											)}
										</td>
										<td className="px-4 py-2.5 text-right text-muted-foreground tabular">
											{c.latencyMs !== null ? `${c.latencyMs} ms` : "–"}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			</div>

			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title={`Delete ${m.name}?`}
				description="Its check history and uptime go with it. Incidents it opened stay."
				confirmLabel="Delete monitor"
				pending={remove.isPending}
				onConfirm={() =>
					remove.mutate(m.id, {
						onSuccess: () => {
							toast.success(`${m.name} deleted`);
							void navigate({ to: "/monitoring/uptime" });
						},
						onError: (e) => toast.error(e.message),
					})
				}
			/>
		</Page>
	);
}
