import { useQuery } from "@tanstack/react-query";
import { ChevronDown, RotateCw, ShieldAlert, Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusDot, StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import {
	isActive,
	type NodePatchStatus,
	nodePatchesQuery,
	type PatchRun,
	type PatchRunNode,
	patchRunsQuery,
	useCancelPatchRun,
	useScanNode,
	useStartPatchRun,
} from "@/lib/api/patching";
import type { ClusterNode } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { PATCH_NODE_STATUS, PATCH_RUN_STATUS } from "@/lib/status";
import { cn } from "@/lib/utils";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const STEP_LABEL: Record<NonNullable<PatchRunNode["step"]>, string> = {
	scan: "Checking for updates",
	drain: "Moving services off",
	upgrade: "Upgrading packages",
	reboot: "Rebooting",
	rejoin: "Waiting for the node to come back",
	healthy: "Waiting for every service",
	undrain: "Taking work again",
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "12 updates · 4 security · reboot pending", or why there is nothing to show. */
export function PatchSummary({
	status,
	className,
}: {
	status: NodePatchStatus;
	className?: string;
}) {
	if (!status.scannedAt)
		return (
			<span className={cn("text-muted-foreground", className)}>
				{status.error
					? "Not scanned: the agent is unreachable"
					: "Not scanned yet"}
			</span>
		);
	return (
		<span
			className={cn(
				"inline-flex flex-wrap items-center gap-x-3 gap-y-1 tabular",
				className,
			)}
		>
			<span className={cn(!status.updates.length && "text-muted-foreground")}>
				{status.updates.length
					? plural(status.updates.length, "update")
					: "Up to date"}
			</span>
			{status.securityCount > 0 && (
				<span className="inline-flex items-center gap-1 text-bad-text">
					<ShieldAlert className="size-3.5" aria-hidden />
					{status.securityCount} security
				</span>
			)}
			{status.rebootRequired && (
				<span className="text-warn-text">Reboot pending</span>
			)}
		</span>
	);
}

function PackageList({ updates }: { updates: NodePatchStatus["updates"] }) {
	const [all, setAll] = useState(false);
	const sorted = [...updates].sort(
		(a, b) =>
			Number(b.security) - Number(a.security) || a.name.localeCompare(b.name),
	);
	const shown = all ? sorted : sorted.slice(0, 8);
	return (
		<>
			<ul className="divide-y">
				{shown.map((u) => (
					<li
						key={u.name}
						className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 px-4 py-2"
					>
						<span className="flex min-w-0 items-baseline gap-2">
							<span className="truncate font-mono text-xs">{u.name}</span>
							{u.security && (
								<span className="shrink-0 text-xs text-bad-text">security</span>
							)}
						</span>
						<span className="truncate text-right font-mono text-xs text-muted-foreground">
							{u.from ? `${u.from} → ` : ""}
							<span className="text-foreground">{u.to}</span>
						</span>
					</li>
				))}
			</ul>
			{sorted.length > shown.length && (
				<button
					type="button"
					onClick={() => setAll(true)}
					className="w-full border-t px-4 py-2 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:bg-accent"
				>
					Show all {sorted.length} packages
				</button>
			)}
		</>
	);
}

/** Options and consequences of a run, confirmed before anything changes. */
export function PatchDialog({
	open,
	onOpenChange,
	nodes,
	onStarted,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	nodes: ClusterNode[];
	onStarted?: (run: PatchRun) => void;
}) {
	const start = useStartPatchRun();
	const [securityOnly, setSecurityOnly] = useState(false);
	const [reboot, setReboot] = useState<"if_needed" | "never">("if_needed");
	const leader = nodes.find((n) => n.leader);
	const many = nodes.length > 1;

	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			destructive={false}
			title={
				many
					? `Patch ${nodes.length} nodes`
					: `Patch ${nodes[0]?.hostname ?? ""}`
			}
			description={
				many
					? "One node at a time, in this order. Each is drained, upgraded, rebooted when a new kernel needs it, and activated once it and every service are back. A failure stops the run there."
					: "The node is drained, upgraded, rebooted when a new kernel needs it, and activated once it and every service are back."
			}
			confirmLabel={many ? "Start rolling patch" : "Patch now"}
			pending={start.isPending}
			onConfirm={() =>
				start.mutate(
					{ nodeIds: nodes.map((n) => n.id), securityOnly, reboot },
					{
						onSuccess: (run) => {
							onOpenChange(false);
							toast.success(
								many ? "Rolling patch started" : "Patching started",
							);
							onStarted?.(run);
						},
						onError: (e) =>
							toast.error("Couldn't start patching", {
								description: errText(e),
							}),
					},
				)
			}
		>
			<div className="grid gap-5 text-sm">
				{many && (
					<ol className="grid gap-1 rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs">
						{nodes.map((n, i) => (
							<li key={n.id} className="flex gap-2">
								<span className="text-muted-foreground tabular">{i + 1}</span>
								{n.hostname}
							</li>
						))}
					</ol>
				)}
				<label
					htmlFor="patch-security"
					className="flex items-start justify-between gap-4"
				>
					<span className="grid gap-0.5">
						<span className="font-medium">Security updates only</span>
						<span className="text-muted-foreground">
							Leave other package updates for later.
						</span>
					</span>
					<Switch
						id="patch-security"
						checked={securityOnly}
						onCheckedChange={setSecurityOnly}
					/>
				</label>
				<fieldset className="grid gap-2">
					<legend className="mb-2 font-medium">Reboot</legend>
					<RadioGroup
						value={reboot}
						onValueChange={(v) => setReboot(v as typeof reboot)}
					>
						<div className="flex items-start gap-2.5">
							<RadioGroupItem value="if_needed" id="reboot-needed" />
							<Label
								htmlFor="reboot-needed"
								className="grid gap-0.5 font-normal"
							>
								When an update needs it
								<span className="text-muted-foreground">
									A new kernel only runs after a reboot.
								</span>
							</Label>
						</div>
						<div className="flex items-start gap-2.5">
							<RadioGroupItem value="never" id="reboot-never" />
							<Label htmlFor="reboot-never" className="font-normal">
								Never, I'll reboot myself
							</Label>
						</div>
					</RadioGroup>
				</fieldset>
				{leader && (
					<p className="rounded-lg bg-warn/10 px-3 py-2 text-warn-text">
						{leader.hostname} runs LogiStack and cannot be drained: its services
						stay in place, and a reboot takes them and this dashboard offline
						for a minute or two.
					</p>
				)}
			</div>
		</ConfirmDialog>
	);
}

/** Each node's state and step, then the run's log. */
export function RunProgress({ run }: { run: PatchRun }) {
	const cancel = useCancelPatchRun();
	return (
		<div className="grid">
			<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
				<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
					<StatusLabel meta={PATCH_RUN_STATUS[run.state]} />
					<span className="text-muted-foreground">
						{run.trigger === "window" ? "Patch window" : "Started by hand"} ·{" "}
						{run.securityOnly ? "security only" : "all updates"} ·{" "}
						{relativeTime(run.createdAt)}
					</span>
				</span>
				{isActive(run) && (
					<Button
						variant="ghost"
						size="sm"
						disabled={cancel.isPending}
						onClick={() =>
							cancel.mutate(run.id, {
								onSuccess: () =>
									toast.success("The run stops after the current step"),
								onError: (e) =>
									toast.error("Couldn't cancel", { description: errText(e) }),
							})
						}
					>
						Cancel
					</Button>
				)}
			</div>
			<ol className="divide-y border-t">
				{run.nodes.map((n) => {
					const meta = PATCH_NODE_STATUS[n.state];
					return (
						<li
							key={n.nodeId}
							className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-2.5"
						>
							<StatusDot meta={meta} className="translate-y-px" />
							<div className="min-w-0">
								<p className="truncate font-mono text-xs">{n.hostname}</p>
								<p
									className={cn(
										"text-xs",
										n.state === "failed"
											? "text-bad-text"
											: "text-muted-foreground",
									)}
								>
									{n.state === "running" && n.step
										? `${STEP_LABEL[n.step]}…`
										: n.state === "failed"
											? `${n.step ? `${STEP_LABEL[n.step]}: ` : ""}${n.error}`
											: n.state === "skipped"
												? (n.error ?? meta.label)
												: meta.label}
								</p>
							</div>
							<span className="text-right text-xs text-muted-foreground tabular">
								{n.upgraded > 0 && plural(n.upgraded, "package")}
								{n.rebooted && " · rebooted"}
							</span>
						</li>
					);
				})}
			</ol>
			{run.log.length > 0 && (
				<Collapsible className="group/log border-t" defaultOpen={isActive(run)}>
					<CollapsibleTrigger className="flex w-full items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:bg-accent">
						Log
						<ChevronDown
							aria-hidden
							className="size-3.5 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]/log:rotate-180"
						/>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<pre className="max-h-64 overflow-auto bg-muted/40 px-4 py-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap">
							{run.log.join("\n")}
						</pre>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

/** The node page's OS updates: last scan, the packages, the run touching this node. */
export function NodePatchesPanel({ node }: { node: ClusterNode }) {
	const online = node.status === "ready" || node.status === "draining";
	const { data: status } = useQuery(nodePatchesQuery(node.id));
	const { data: runs } = useQuery(patchRunsQuery);
	const scan = useScanNode(node.id);
	const [patching, setPatching] = useState(false);
	const run = runs?.find((r) => r.nodes.some((n) => n.nodeId === node.id));
	const busy = runs?.some(isActive) ?? false;

	return (
		<Panel
			id="node-patches"
			title="OS updates"
			actions={
				online && (
					<div className="flex items-center gap-1">
						{status?.scannedAt && (
							<span className="mr-1 text-xs text-muted-foreground">
								{relativeTime(status.scannedAt)}
							</span>
						)}
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Check for updates now"
							disabled={scan.isPending}
							onClick={() =>
								scan.mutate(undefined, {
									onError: (e) =>
										toast.error("Couldn't check for updates", {
											description: errText(e),
										}),
								})
							}
						>
							<RotateCw className={cn(scan.isPending && "animate-spin")} />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="text-muted-foreground"
							disabled={busy || !status?.scannedAt}
							title={busy ? "A patch run is in progress" : undefined}
							onClick={() => setPatching(true)}
						>
							<Wrench data-icon="inline-start" />
							Patch
						</Button>
					</div>
				)
			}
		>
			{!status ? (
				<SkeletonRows rows={3} />
			) : (
				<>
					<div className="grid gap-1 border-b px-4 py-3 text-sm">
						<PatchSummary status={status} />
						{status.scannedAt && (
							<p className="text-xs text-muted-foreground">
								{status.os ?? status.packageManager} · kernel{" "}
								<span className="font-mono">{status.kernel}</span>
							</p>
						)}
						{status.error && (
							<p className="text-xs text-bad-text">
								Last check failed: {status.error}
							</p>
						)}
						{!online && (
							<p className="text-xs text-muted-foreground">
								Checks run through the node's agent, which is not connected.
							</p>
						)}
					</div>
					{run && isActive(run) ? (
						<RunProgress run={run} />
					) : status.updates.length > 0 ? (
						<PackageList updates={status.updates} />
					) : status.scannedAt ? (
						<p className="px-4 py-6 text-sm text-muted-foreground">
							{status.rebootRequired
								? "Every package is current; a reboot is still due to run the new kernel."
								: "Every package is current."}
						</p>
					) : null}
				</>
			)}
			<PatchDialog open={patching} onOpenChange={setPatching} nodes={[node]} />
		</Panel>
	);
}
