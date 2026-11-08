import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Server, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CronField } from "@/components/backups/cron-field";
import { EmptyState } from "@/components/empty-state";
import { MonitoringPage } from "@/components/monitoring/monitoring-page";
import {
	PatchDialog,
	PatchSummary,
	RunProgress,
} from "@/components/monitoring/patches";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { nodesQuery } from "@/lib/api/monitoring";
import {
	fleetPatchesQuery,
	isActive,
	type NodePatchStatus,
	type PatchPolicy,
	patchPolicyQuery,
	patchRunsQuery,
	useSavePatchPolicy,
} from "@/lib/api/patching";
import type { ClusterNode } from "@/lib/api/types";
import { cronError } from "@/lib/cron";
import { relativeTime } from "@/lib/format";
import { PATCH_RUN_STATUS } from "@/lib/status";

export const Route = createFileRoute("/_app/monitoring/patches")({
	staticData: { crumb: "OS updates" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(nodesQuery);
		void context.queryClient.prefetchQuery(fleetPatchesQuery);
		void context.queryClient.prefetchQuery(patchRunsQuery);
	},
	component: Patches,
});

/** Workers first, the leader last: rebooting it restarts LogiStack itself. */
const rollingOrder = (a: ClusterNode, b: ClusterNode) =>
	Number(a.leader) - Number(b.leader) || a.hostname.localeCompare(b.hostname);

function FleetTable({
	nodes,
	status,
	selected,
	onToggle,
	disabled,
}: {
	nodes: ClusterNode[];
	status: Map<string, NodePatchStatus>;
	selected: Set<string>;
	onToggle: (id: string, on: boolean) => void;
	disabled: boolean;
}) {
	return (
		<ul className="divide-y">
			{nodes.map((n) => {
				const s = status.get(n.id);
				return (
					<li
						key={n.id}
						className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-4 py-3 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_9rem]"
					>
						<Checkbox
							aria-label={`Patch ${n.hostname}`}
							checked={selected.has(n.id)}
							disabled={disabled || n.desired === "remove"}
							onCheckedChange={(v) => onToggle(n.id, v === true)}
						/>
						<div className="min-w-0">
							<Link
								to="/monitoring/nodes/$nodeId"
								params={{ nodeId: n.id }}
								className="truncate text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
							>
								{n.hostname}
							</Link>
							{n.leader && (
								<p className="text-xs text-muted-foreground">
									Leader, runs LogiStack
								</p>
							)}
						</div>
						<p className="col-start-2 min-w-0 truncate text-xs text-muted-foreground md:col-start-auto">
							{s?.os ?? "Unknown OS"}
							{s?.kernel && (
								<>
									{" · "}
									<span className="font-mono">{s.kernel}</span>
								</>
							)}
						</p>
						{s ? (
							<PatchSummary
								status={s}
								className="col-start-2 text-sm md:col-start-auto"
							/>
						) : (
							<span />
						)}
						<span className="col-start-2 text-xs whitespace-nowrap text-muted-foreground tabular md:col-start-auto md:text-right">
							{s?.scannedAt ? `Checked ${relativeTime(s.scannedAt)}` : ""}
						</span>
					</li>
				);
			})}
		</ul>
	);
}

function PolicyForm() {
	const { data } = useQuery(patchPolicyQuery);
	const save = useSavePatchPolicy();
	const [draft, setDraft] = useState<PatchPolicy>();
	useEffect(() => {
		if (data && !draft) setDraft(data);
	}, [data, draft]);
	if (!draft) return <SkeletonRows rows={3} />;
	const set = (p: Partial<PatchPolicy>) => setDraft({ ...draft, ...p });
	const invalid = cronError(draft.cron);
	const dirty = JSON.stringify(draft) !== JSON.stringify(data);

	return (
		<form
			className="grid gap-5 p-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (invalid) return;
				save.mutate(draft, {
					onSuccess: () => toast.success("Patch window saved"),
					onError: (err) =>
						toast.error("Couldn't save the patch window", {
							description: err instanceof Error ? err.message : String(err),
						}),
				});
			}}
		>
			<label
				htmlFor="window-enabled"
				className="flex items-start justify-between gap-4 text-sm"
			>
				<span className="grid gap-0.5">
					<span className="font-medium">Patch on a schedule</span>
					<span className="text-muted-foreground text-pretty">
						A rolling run over every active node, workers first and the leader
						last.
					</span>
				</span>
				<Switch
					id="window-enabled"
					checked={draft.enabled}
					onCheckedChange={(enabled) => set({ enabled })}
				/>
			</label>
			{draft.enabled && (
				<>
					<CronField
						id="window-cron"
						label="Window"
						cron={draft.cron}
						timezone={draft.timezone}
						onCron={(cron) => set({ cron })}
						onTimezone={(timezone) => set({ timezone })}
						hint="Pick a quiet hour: services move between nodes while each one patches."
					/>
					<label
						htmlFor="window-security"
						className="flex items-center justify-between gap-4 text-sm"
					>
						<span className="font-medium">Security updates only</span>
						<Switch
							id="window-security"
							checked={draft.securityOnly}
							onCheckedChange={(securityOnly) => set({ securityOnly })}
						/>
					</label>
					<div className="flex flex-wrap items-center justify-between gap-3 text-sm">
						<span id="window-reboot" className="font-medium">
							Reboot
						</span>
						<Select
							value={draft.reboot}
							onValueChange={(reboot: PatchPolicy["reboot"]) => set({ reboot })}
						>
							<SelectTrigger className="w-56" aria-labelledby="window-reboot">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="if_needed">
									When an update needs it
								</SelectItem>
								<SelectItem value="never">Never</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</>
			)}
			<div className="flex justify-end">
				<Button type="submit" disabled={!dirty || !!invalid || save.isPending}>
					Save
				</Button>
			</div>
		</form>
	);
}

function Patches() {
	const { data: nodes } = useQuery(nodesQuery);
	const { data: fleet } = useQuery(fleetPatchesQuery);
	const { data: runs } = useQuery(patchRunsQuery);
	const [selected, setSelected] = useState<Set<string>>();
	const [patching, setPatching] = useState(false);
	const sorted = nodes && [...nodes].sort(rollingOrder);
	const status = new Map(fleet?.map((s) => [s.nodeId, s]));
	const busy = runs?.some(isActive) ?? false;
	const [latest, ...older] = runs ?? [];

	// Preselect the nodes with something to install, once the first scan results arrive.
	useEffect(() => {
		if (selected || !nodes || !fleet) return;
		setSelected(
			new Set(fleet.filter((s) => s.updates.length > 0).map((s) => s.nodeId)),
		);
	}, [selected, nodes, fleet]);

	const picked = sorted?.filter((n) => selected?.has(n.id)) ?? [];
	const outdated = fleet?.filter((s) => s.updates.length).length ?? 0;
	const security = fleet?.reduce((a, s) => a + s.securityCount, 0) ?? 0;

	if (sorted?.length === 0)
		return (
			<MonitoringPage section="patches">
				<EmptyState
					icon={Server}
					title="No servers to patch"
					description="Once a server runs the agent, its pending OS updates show here."
				/>
			</MonitoringPage>
		);

	return (
		<MonitoringPage section="patches">
			<div className="grid gap-8">
				<Panel
					id="fleet-updates"
					title={
						fleet ? (
							<span className="tabular">
								{outdated
									? `${outdated} of ${fleet.length} nodes have updates`
									: "Every node is up to date"}
								{security > 0 && (
									<span className="font-normal text-bad-text">
										{" "}
										· {security} security
									</span>
								)}
							</span>
						) : (
							"OS updates"
						)
					}
					actions={
						<Button
							size="sm"
							disabled={busy || picked.length === 0}
							onClick={() => setPatching(true)}
						>
							<Wrench data-icon="inline-start" />
							{picked.length > 1
								? `Patch ${picked.length} nodes`
								: "Patch node"}
						</Button>
					}
				>
					{sorted && fleet ? (
						<FleetTable
							nodes={sorted}
							status={status}
							selected={selected ?? new Set()}
							disabled={busy}
							onToggle={(id, on) => {
								const next = new Set(selected);
								if (on) next.add(id);
								else next.delete(id);
								setSelected(next);
							}}
						/>
					) : (
						<SkeletonRows rows={3} />
					)}
				</Panel>

				<div className="grid gap-8 xl:grid-cols-2">
					<Panel
						id="patch-runs"
						className="min-w-0"
						title={latest && isActive(latest) ? "Running now" : "Last run"}
					>
						{!runs ? (
							<SkeletonRows rows={2} />
						) : latest ? (
							<RunProgress run={latest} />
						) : (
							<p className="px-4 py-6 text-sm text-muted-foreground text-pretty">
								No patch run yet. Pick nodes above to patch them one at a time:
								each is drained, upgraded, rebooted if a new kernel needs it,
								and activated once its services are back.
							</p>
						)}
						{older.length > 0 && (
							<ul className="divide-y border-t">
								{older.slice(0, 8).map((r) => (
									<li
										key={r.id}
										className="flex items-center gap-3 px-4 py-2.5 text-xs"
									>
										<StatusDot meta={PATCH_RUN_STATUS[r.state]} />
										<span className="min-w-0 flex-1 truncate">
											{r.nodes.map((n) => n.hostname).join(", ")}
										</span>
										<span className="shrink-0 text-muted-foreground tabular">
											{PATCH_RUN_STATUS[r.state].label} ·{" "}
											{relativeTime(r.createdAt)}
										</span>
									</li>
								))}
							</ul>
						)}
					</Panel>
					<Panel id="patch-window" title="Patch window">
						<PolicyForm />
					</Panel>
				</div>
			</div>
			<PatchDialog open={patching} onOpenChange={setPatching} nodes={picked} />
		</MonitoringPage>
	);
}
