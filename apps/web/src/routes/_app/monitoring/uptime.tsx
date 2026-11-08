import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { MonitoringPage } from "@/components/monitoring/monitoring-page";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckStrip, MONITOR_STATUS, pct } from "@/components/uptime/parts";
import { useInvalidating } from "@/lib/api/networking";
import {
	daysUntil,
	KIND_LABEL,
	type Monitor,
	monitorsQuery,
	monitorTarget,
	type Suggestion,
	suggestionsQuery,
	uptimeApi,
} from "@/lib/api/uptime";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/monitoring/uptime")({
	staticData: { crumb: "Uptime" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(monitorsQuery);
	},
	component: Uptime,
});

/** Worst first: what is down is what you came for. */
const ORDER = { down: 0, pending: 1, maintenance: 2, up: 3, paused: 4 };

function NewMonitorButton() {
	return (
		<Button asChild>
			<Link to="/monitoring/uptime/new">
				<Plus data-icon="inline-start" />
				New monitor
			</Link>
		</Button>
	);
}

function CertDays({ iso }: { iso: string }) {
	const d = daysUntil(iso);
	return (
		<span
			className={cn(
				"tabular",
				d < 7 ? "text-bad-text" : d < 30 ? "text-warn-text" : undefined,
			)}
		>
			{d < 0 ? "Expired" : `${d} d`}
		</span>
	);
}

function MonitorRow({ m }: { m: Monitor }) {
	const keys = [["monitors"]];
	const update = useInvalidating(uptimeApi.updateMonitor, keys);
	const remove = useInvalidating(uptimeApi.removeMonitor, keys);
	const [confirm, setConfirm] = useState(false);
	return (
		<li className="group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-muted/40 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_5rem_5rem_4.5rem_2rem]">
			<div className="min-w-0">
				<div className="flex items-center gap-2.5">
					<StatusDot meta={MONITOR_STATUS[m.status]} />
					<span className="sr-only">{MONITOR_STATUS[m.status].label}:</span>
					<Link
						to="/monitoring/uptime/$monitorId"
						params={{ monitorId: m.id }}
						className="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
					>
						{m.name}
					</Link>
					<span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground">
						{KIND_LABEL[m.kind as keyof typeof KIND_LABEL]}
					</span>
				</div>
				<p className="mt-0.5 truncate text-xs text-muted-foreground">
					{m.status === "down" && m.lastError ? (
						<span className="text-bad-text">{m.lastError}</span>
					) : (
						monitorTarget(m.config)
					)}
				</p>
			</div>
			<CheckStrip checks={m.recent.slice(-30)} className="hidden md:flex" />
			<span className="hidden text-right text-sm tabular md:block">
				<span className="sr-only">Uptime 24 hours </span>
				{pct(m.uptime24h)}
			</span>
			<span className="hidden text-right text-sm text-muted-foreground tabular md:block">
				<span className="sr-only">Uptime 30 days </span>
				{pct(m.uptime30d)}
			</span>
			<span className="hidden text-right text-sm text-muted-foreground md:block">
				{m.certExpiresAt ? (
					<CertDays iso={m.certExpiresAt} />
				) : m.lastLatencyMs !== null ? (
					<span className="tabular">{m.lastLatencyMs} ms</span>
				) : (
					"–"
				)}
			</span>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="relative z-10 size-8"
						aria-label={`Actions for ${m.name}`}
					>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem asChild>
						<Link
							to="/monitoring/uptime/$monitorId/edit"
							params={{ monitorId: m.id }}
						>
							Edit
						</Link>
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() =>
							update.mutate(
								{ id: m.id, json: { enabled: !m.enabled } },
								{
									onSuccess: () =>
										toast.success(
											m.enabled ? `${m.name} paused` : `${m.name} resumed`,
										),
									onError: (e) => toast.error(e.message),
								},
							)
						}
					>
						{m.enabled ? "Pause" : "Resume"}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						onSelect={() => setConfirm(true)}
					>
						Delete…
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
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
							setConfirm(false);
							toast.success(`${m.name} deleted`);
						},
						onError: (e) => toast.error(e.message),
					})
				}
			/>
		</li>
	);
}

function Suggestions({ items }: { items: Suggestion[] }) {
	const add = useInvalidating(uptimeApi.createMonitor, [
		["monitors"],
		["monitors", "suggestions"],
	]);
	const [busy, setBusy] = useState<string>();
	return (
		<Panel
			id="suggested-heading"
			title="Suggested"
			actions={
				<span className="text-xs text-muted-foreground">
					Domains without a monitor
				</span>
			}
		>
			<ul className="divide-y">
				{items.map((s) => (
					<li key={s.domainId} className="flex items-center gap-4 px-4 py-3">
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-medium">{s.hostname}</p>
							<p className="truncate text-xs text-muted-foreground">
								{s.projectName} · {s.serviceName}
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							disabled={busy === s.domainId}
							onClick={() => {
								setBusy(s.domainId);
								add.mutate(
									{
										name: s.hostname,
										config: {
											kind: "http",
											http: {
												url: s.url,
												method: "GET",
												headers: [],
												statusCodes: ["2xx"],
												followRedirects: true,
											},
										},
										domainId: s.domainId,
										serviceId: s.serviceId,
										projectId: s.projectId,
									},
									{
										onSuccess: () =>
											toast.success(`Watching ${s.hostname}`, {
												description:
													"The first check runs within a few seconds.",
											}),
										onError: (e) => toast.error(e.message),
										onSettled: () => setBusy(undefined),
									},
								);
							}}
						>
							Add monitor
						</Button>
					</li>
				))}
			</ul>
		</Panel>
	);
}

function Uptime() {
	const { data: monitors } = useQuery(monitorsQuery);
	const { data: suggestions } = useQuery(suggestionsQuery);
	const sorted =
		monitors &&
		[...monitors].sort(
			(a, b) =>
				ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name),
		);
	const down = monitors?.filter((m) => m.status === "down").length ?? 0;

	return (
		<MonitoringPage
			section="uptime"
			description="Checks your sites, ports, DNS and certificates from the outside, and alerts when they stop answering."
			action={<NewMonitorButton />}
		>
			<div className="grid gap-8">
				{sorted && sorted.length === 0 ? (
					<EmptyState
						icon={Activity}
						title="Nothing is watched yet"
						description="A monitor checks a URL, port, DNS record or certificate every minute and tells your notification channels when it goes down."
					>
						<NewMonitorButton />
					</EmptyState>
				) : (
					<Panel
						id="monitors-heading"
						title="Monitors"
						actions={
							sorted && (
								<span className="text-xs text-muted-foreground tabular">
									{sorted.length} {sorted.length === 1 ? "monitor" : "monitors"}
									{down > 0 && (
										<span className="text-bad-text"> · {down} down</span>
									)}
								</span>
							)
						}
					>
						<div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_5rem_5rem_4.5rem_2rem] gap-x-6 border-b px-4 py-2 text-xs text-muted-foreground md:grid">
							<span>Name</span>
							<span>Last 30 checks</span>
							<span className="text-right">24 h</span>
							<span className="text-right">30 d</span>
							<span className="text-right">Latency</span>
							<span />
						</div>
						{sorted ? (
							<ul className="t-reveal divide-y">
								{sorted.map((m) => (
									<MonitorRow key={m.id} m={m} />
								))}
							</ul>
						) : (
							<SkeletonRows />
						)}
					</Panel>
				)}
				{suggestions && suggestions.length > 0 && (
					<Suggestions items={suggestions} />
				)}
			</div>
		</MonitoringPage>
	);
}
