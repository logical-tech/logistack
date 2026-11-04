import { MonitoringSettingsInput } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronDown, Loader2, Plus, ServerCrash, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { TimezonePicker } from "@/components/backups/cron-field";
import { MonitoringPage } from "@/components/monitoring/monitoring-page";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	monitoringSettingsQuery,
	nodesQuery,
	useSaveMonitoring,
} from "@/lib/api/monitoring";
import type {
	PruneTarget,
	MonitoringSettingsInput as SettingsInput,
	ThresholdMetric,
} from "@/lib/api/types";
import { cronError } from "@/lib/cron";
import { relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/monitoring/alerts")({
	staticData: { crumb: "Settings" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(monitoringSettingsQuery);
		void context.queryClient.prefetchQuery(nodesQuery);
	},
	component: Alerts,
});

const METRIC: Record<ThresholdMetric, string> = {
	cpu: "CPU",
	memory: "Memory",
	disk: "Disk",
};

const WINDOWS = [60, 300, 600, 900, 1_800, 3_600];
const minutes = (s: number) => (s < 3_600 ? `${s / 60} min` : `${s / 3_600} h`);
const ALL = "__all";

type Draft = SettingsInput & { cleanup: NonNullable<SettingsInput["cleanup"]> };

const TARGETS: { value: PruneTarget; label: string; hint: string }[] = [
	{
		value: "images",
		label: "Unused images",
		hint: "Images no running app uses. They download again if needed.",
	},
	{
		value: "buildCache",
		label: "Build cache",
		hint: "Leftovers from builds. The next build may take a bit longer.",
	},
	{
		value: "containers",
		label: "Stopped containers",
		hint: "Old copies of your apps that are no longer running.",
	},
];

/** First message per dotted path, e.g. `thresholds.0.percent`. */
function validate(d: Draft): Record<string, string> {
	const r = MonitoringSettingsInput.safeParse(d);
	const out: Record<string, string> = {};
	if (!r.success)
		for (const i of r.error.issues) out[i.path.join(".")] ??= i.message;
	const cron = cronError(d.cleanup.cron);
	if (cron) out["cleanup.cron"] ??= cron;
	if (d.cleanup.enabled && !d.cleanup.targets.length)
		out["cleanup.targets"] ??= "Pick at least one thing to clean up";
	return out;
}

type CleanupDraft = Draft["cleanup"];
type Frequency = "daily" | "weekly" | "custom";

const SIMPLE_CRON = /^(\d{1,2}) (\d{1,2}) \* \* (\*|0)$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** The common case as "every day at 03:00"; cron, time zone and targets stay one click away. */
function CleanupSchedule({
	cleanup,
	onChange,
	errors,
}: {
	cleanup: CleanupDraft;
	onChange: (patch: Partial<CleanupDraft>) => void;
	errors: Record<string, string>;
}) {
	const m = SIMPLE_CRON.exec(cleanup.cron);
	const [custom, setCustom] = useState(!m);
	const freq: Frequency =
		custom || !m ? "custom" : m[3] === "0" ? "weekly" : "daily";
	const minute = m ? Number(m[1]) : 0;
	const hour = m ? Number(m[2]) : 3;
	const cronFor = (f: Frequency, h: number, min: number) =>
		`${min} ${h} * * ${f === "weekly" ? "0" : "*"}`;
	const advancedErrors =
		errors["cleanup.targets"] || errors["cleanup.untilHours"];

	return (
		<div className="grid gap-5">
			<fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
				<legend className="mb-2 text-sm font-medium">Runs</legend>
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<Select
						value={freq}
						onValueChange={(f: Frequency) => {
							setCustom(f === "custom");
							if (f !== "custom") onChange({ cron: cronFor(f, hour, minute) });
						}}
					>
						<SelectTrigger className="w-40" aria-label="How often">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="daily">Every day</SelectItem>
							<SelectItem value="weekly">Every Sunday</SelectItem>
							<SelectItem value="custom">Custom (cron)</SelectItem>
						</SelectContent>
					</Select>
					{freq === "custom" ? (
						<Input
							aria-label="Cron expression"
							value={cleanup.cron}
							onChange={(e) => onChange({ cron: e.target.value })}
							aria-invalid={errors["cleanup.cron"] ? true : undefined}
							className="w-40 font-mono"
							spellCheck={false}
						/>
					) : (
						<>
							<span className="text-muted-foreground">at</span>
							<Input
								aria-label="Time"
								type="time"
								step={60}
								required
								value={`${pad2(hour)}:${pad2(minute)}`}
								onChange={(e) => {
									const [h, min] = e.target.value.split(":").map(Number);
									if (Number.isInteger(h) && Number.isInteger(min))
										onChange({
											cron: cronFor(freq, h as number, min as number),
										});
								}}
								className="w-28 tabular"
							/>
						</>
					)}
					<span className="text-muted-foreground">{cleanup.timezone}</span>
				</div>
				{errors["cleanup.cron"] && (
					<p className="text-xs text-bad-text">{errors["cleanup.cron"]}</p>
				)}
			</fieldset>

			<Collapsible className="group/adv" defaultOpen={!!advancedErrors}>
				<CollapsibleTrigger className="flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
					Advanced options
					<ChevronDown
						className="size-4 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]/adv:rotate-180"
						aria-hidden
					/>
				</CollapsibleTrigger>
				<CollapsibleContent className="grid gap-6 pt-4">
					<div className="grid gap-2 sm:max-w-[16rem]">
						<label htmlFor="cleanup-tz" className="text-sm font-medium">
							Time zone
						</label>
						<TimezonePicker
							id="cleanup-tz"
							value={cleanup.timezone}
							onChange={(timezone) => onChange({ timezone })}
						/>
					</div>
					<fieldset className="grid gap-3">
						<legend className="mb-3 text-sm font-medium">What to delete</legend>
						{TARGETS.map((t) => (
							<label
								key={t.value}
								htmlFor={`cleanup-${t.value}`}
								className="flex items-start gap-3"
							>
								<Checkbox
									id={`cleanup-${t.value}`}
									className="mt-0.5"
									checked={cleanup.targets.includes(t.value)}
									onCheckedChange={(on) =>
										onChange({
											targets: on
												? [...cleanup.targets, t.value]
												: cleanup.targets.filter((x) => x !== t.value),
										})
									}
								/>
								<span className="grid gap-0.5">
									<span className="text-sm">{t.label}</span>
									<span className="text-xs text-muted-foreground">
										{t.hint}
									</span>
								</span>
							</label>
						))}
						{errors["cleanup.targets"] && (
							<p className="text-xs text-bad-text">
								{errors["cleanup.targets"]}
							</p>
						)}
					</fieldset>
					<div className="sm:max-w-[16rem]">
						<NumberField
							id="cleanup-age"
							label="Skip anything newer than"
							value={cleanup.untilHours}
							onChange={(untilHours) => onChange({ untilHours })}
							min={0}
							max={8_760}
							unit="hours"
							error={errors["cleanup.untilHours"]}
							hint="Keeps the last deploy's image, so a quick rollback needs no download."
						/>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}

function NumberField({
	id,
	label,
	value,
	onChange,
	min,
	max,
	unit,
	error,
	hint,
}: {
	id: string;
	label: string;
	value: number;
	onChange: (v: number) => void;
	min: number;
	max: number;
	unit: string;
	error?: string;
	hint: string;
}) {
	return (
		<div className="grid content-start gap-2">
			<label htmlFor={id} className="text-sm font-medium">
				{label}
			</label>
			<div className="relative">
				<Input
					id={id}
					type="number"
					inputMode="numeric"
					min={min}
					max={max}
					value={Number.isNaN(value) ? "" : value}
					onChange={(e) => onChange(e.target.valueAsNumber)}
					aria-invalid={error ? true : undefined}
					aria-describedby={`${id}-msg`}
					className="pr-14 tabular"
				/>
				<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
					{unit}
				</span>
			</div>
			<p
				id={`${id}-msg`}
				className={cn(
					"text-xs",
					error ? "text-bad-text" : "text-muted-foreground",
				)}
			>
				{error ? `${error} (${min} to ${max})` : hint}
			</p>
		</div>
	);
}

function Alerts() {
	const { data: settings } = useQuery(monitoringSettingsQuery);
	const { data: nodes = [] } = useQuery(nodesQuery);
	const save = useSaveMonitoring();
	const [draft, setDraft] = useState<Draft>();
	const [attempted, setAttempted] = useState(false);

	useEffect(() => {
		if (settings && !draft) setDraft(structuredClone(settings));
	}, [settings, draft]);

	if (!draft || !settings) {
		return (
			<MonitoringPage section="alerts">
				<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
					<SkeletonRows rows={4} />
				</div>
			</MonitoringPage>
		);
	}

	const errors = attempted ? validate(draft) : {};
	const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
	const setThreshold = (
		i: number,
		patch: Partial<Draft["thresholds"][number]>,
	) =>
		setDraft({
			...draft,
			thresholds: draft.thresholds.map((t, j) =>
				j === i ? { ...t, ...patch } : t,
			),
		});
	const setRetention = (patch: Partial<Draft["retention"]>) =>
		setDraft({ ...draft, retention: { ...draft.retention, ...patch } });
	const setCleanup = (patch: Partial<Draft["cleanup"]>) =>
		setDraft({ ...draft, cleanup: { ...draft.cleanup, ...patch } });
	const last = settings.lastCleanup;
	const lastFreed = last?.nodes.reduce((a, n) => a + n.reclaimedBytes, 0) ?? 0;
	const lastFailed = last?.nodes.filter((n) => n.error) ?? [];

	function onSave() {
		setAttempted(true);
		if (!draft || Object.keys(validate(draft)).length) return;
		save.mutate(draft, {
			onSuccess: (saved) => {
				setDraft(structuredClone(saved));
				setAttempted(false);
				toast.success("Monitoring settings saved");
			},
			onError: (e) =>
				toast.error("Couldn't save", {
					description: e instanceof Error ? e.message : String(e),
				}),
		});
	}

	return (
		<MonitoringPage section="alerts">
			<div className="grid max-w-4xl gap-10">
				<Panel
					id="thresholds"
					title="Thresholds"
					actions={
						<Button
							variant="ghost"
							size="sm"
							className="text-muted-foreground"
							onClick={() =>
								setDraft({
									...draft,
									thresholds: [
										...draft.thresholds,
										{
											metric: "cpu",
											nodeId: null,
											percent: 90,
											forSec: 300,
											enabled: true,
										},
									],
								})
							}
						>
							<Plus data-icon="inline-start" />
							Add threshold
						</Button>
					}
				>
					<p className="border-b px-4 py-3 text-sm text-muted-foreground">
						When a node's average over the window crosses the limit, LogiStack
						emits a{" "}
						<code className="font-mono text-xs text-foreground">
							metric.threshold
						</code>{" "}
						event, and again when it falls back under. Where it goes is up to
						your{" "}
						<Link
							to="/integrations/notifications"
							className="text-foreground underline decoration-border hover:decoration-foreground"
						>
							notification rules
						</Link>
						.
					</p>
					<ul className="divide-y">
						<li className="flex items-start gap-3 px-4 py-3.5">
							<ServerCrash
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								strokeWidth={1.75}
								aria-hidden
							/>
							<div className="min-w-0 flex-1">
								<p className="text-sm font-medium">Node down</p>
								<p className="mt-0.5 text-xs text-muted-foreground">
									Fires <code className="font-mono">node.down</code> when a
									node's agent misses heartbeats for 30 seconds. Always on, for
									every node.
								</p>
							</div>
							<span className="text-xs text-muted-foreground">Built in</span>
						</li>
						{draft.thresholds.map((t, i) => {
							const err = (k: string) => errors[`thresholds.${i}.${k}`];
							const key = t.id ?? `new-${i}`;
							return (
								<li
									key={key}
									className={cn(
										"grid gap-3 px-4 py-3.5 sm:grid-cols-[8rem_7rem_8rem_minmax(0,1fr)_auto] sm:items-center",
										!t.enabled && "[&_.dim]:opacity-55",
									)}
								>
									<Select
										value={t.metric}
										onValueChange={(v) =>
											setThreshold(i, { metric: v as ThresholdMetric })
										}
									>
										<SelectTrigger className="dim w-full" aria-label="Metric">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{(Object.keys(METRIC) as ThresholdMetric[]).map((m) => (
												<SelectItem key={m} value={m}>
													{METRIC[m]}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<div className="dim relative">
										<Input
											type="number"
											min={1}
											max={100}
											value={Number.isNaN(t.percent) ? "" : t.percent}
											onChange={(e) =>
												setThreshold(i, { percent: e.target.valueAsNumber })
											}
											aria-label="Limit in percent"
											aria-invalid={err("percent") ? true : undefined}
											className="pr-14 tabular"
										/>
										<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
											% over
										</span>
									</div>
									<Select
										value={String(t.forSec)}
										onValueChange={(v) =>
											setThreshold(i, { forSec: Number(v) })
										}
									>
										<SelectTrigger
											className="dim w-full"
											aria-label="Averaged over"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{(WINDOWS.includes(t.forSec)
												? WINDOWS
												: [...WINDOWS, t.forSec].sort((a, b) => a - b)
											).map((s) => (
												<SelectItem key={s} value={String(s)}>
													{minutes(s)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Select
										value={t.nodeId ?? ALL}
										onValueChange={(v) =>
											setThreshold(i, { nodeId: v === ALL ? null : v })
										}
									>
										<SelectTrigger
											className="dim w-full"
											aria-label="Applies to"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ALL}>Every node</SelectItem>
											{nodes.map((n) => (
												<SelectItem key={n.id} value={n.id}>
													{n.hostname}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<div className="flex items-center justify-end gap-2">
										<Switch
											checked={t.enabled}
											onCheckedChange={(enabled) =>
												setThreshold(i, { enabled })
											}
											aria-label={t.enabled ? "Enabled" : "Disabled"}
										/>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`Remove ${METRIC[t.metric]} threshold`}
											onClick={() =>
												setDraft({
													...draft,
													thresholds: draft.thresholds.filter(
														(_, j) => j !== i,
													),
												})
											}
										>
											<X />
										</Button>
									</div>
									{err("percent") && (
										<p className="text-xs text-bad-text sm:col-span-5">
											Limit: {err("percent")} (1 to 100)
										</p>
									)}
								</li>
							);
						})}
					</ul>
				</Panel>

				<Panel id="retention" title="Retention" bodyClassName="p-4 sm:p-5">
					<p className="mb-5 max-w-[62ch] text-sm text-muted-foreground">
						Agents sample every 10 seconds. Older samples roll up into 1-minute
						and 1-hour buckets, so long ranges stay fast; each tier is kept this
						long.
					</p>
					<div className="grid gap-5 sm:grid-cols-3">
						<NumberField
							id="ret-raw"
							label="Raw samples"
							value={draft.retention.rawHours}
							onChange={(rawHours) => setRetention({ rawHours })}
							min={1}
							max={168}
							unit="hours"
							error={errors["retention.rawHours"]}
							hint="Charts up to 1 hour read these."
						/>
						<NumberField
							id="ret-1m"
							label="1-minute rollups"
							value={draft.retention.minuteDays}
							onChange={(minuteDays) => setRetention({ minuteDays })}
							min={1}
							max={90}
							unit="days"
							error={errors["retention.minuteDays"]}
							hint="6 hours to 7 days."
						/>
						<NumberField
							id="ret-1h"
							label="1-hour rollups"
							value={draft.retention.hourDays}
							onChange={(hourDays) => setRetention({ hourDays })}
							min={1}
							max={3_650}
							unit="days"
							error={errors["retention.hourDays"]}
							hint="30 days and beyond."
						/>
					</div>
				</Panel>

				<Panel
					id="cleanup"
					title="Automatic cleanup"
					actions={
						<Switch
							checked={draft.cleanup.enabled}
							onCheckedChange={(enabled) => setCleanup({ enabled })}
							aria-label="Clean up nodes automatically"
						/>
					}
					bodyClassName="grid gap-5 p-4 sm:p-5"
				>
					<p className="max-w-[62ch] text-sm text-muted-foreground">
						Frees disk space by deleting what Docker leaves behind after deploys
						and builds. Running apps and their data are never touched.
					</p>
					{draft.cleanup.enabled && (
						<CleanupSchedule
							cleanup={draft.cleanup}
							onChange={setCleanup}
							errors={errors}
						/>
					)}
					{last && (
						<p className="text-xs text-muted-foreground tabular">
							Last run {relativeTime(new Date(last.at).toISOString())}:{" "}
							{last.nodes.length
								? `freed ${formatBytes(lastFreed)} on ${last.nodes.length} ${last.nodes.length === 1 ? "node" : "nodes"}`
								: "no node was connected"}
							{lastFailed.length > 0 && (
								<span className="text-bad-text">
									{" "}
									· failed on {lastFailed.map((n) => n.hostname).join(", ")}:{" "}
									{lastFailed[0]?.error}
								</span>
							)}
						</p>
					)}
				</Panel>

				<div className="sticky bottom-4 flex items-center justify-end gap-3">
					{dirty && (
						<span className="text-xs text-muted-foreground">
							Unsaved changes
						</span>
					)}
					<Button
						variant="ghost"
						disabled={!dirty || save.isPending}
						onClick={() => {
							setDraft(structuredClone(settings));
							setAttempted(false);
						}}
					>
						Discard
					</Button>
					<Button onClick={onSave} disabled={!dirty || save.isPending}>
						{save.isPending && <Loader2 className="animate-spin" />}
						Save changes
					</Button>
				</div>
			</div>
		</MonitoringPage>
	);
}
