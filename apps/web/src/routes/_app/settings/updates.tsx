import type { ReleaseChannel } from "@logistack/contracts";
import {
	versionChannel,
	withoutBreakingChanges,
} from "@logistack/core/version";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	ArrowRight,
	ArrowUpRight,
	ExternalLink,
	Heart,
	Loader2,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { StatusDot, StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { meQuery } from "@/lib/api/access";
import { SPONSOR_URL, useIsSponsor } from "@/lib/api/sponsor";
import {
	type ChangelogEntry,
	isActive,
	type UpdateRun,
	type UpdateStatus,
	type UpdateStepId,
	useCheckNow,
	useSetAutoCheck,
	useSetChannel,
	useStartUpdate,
	useUpdateStatus,
} from "@/lib/api/updates";
import { relativeTime } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import {
	type StatusMeta,
	UPDATE_STATUS,
	UPDATE_STEP_STATUS,
} from "@/lib/status";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings/updates")({
	staticData: { crumb: "Updates" },
	component: Updates,
});

/** Releases read as tags (`v0.2.0`); a checkout's `dev` stays as it is. */
const tag = (v: string) => (/^\d/.test(v) ? `v${v}` : v);

const CHANNELS: Record<
	ReleaseChannel,
	{ label: string; latest: string; detail: string }
> = {
	stable: {
		label: "Stable",
		latest: "Latest release",
		detail:
			"Tagged releases only. Each one passes the full test suite and an install and update smoke test.",
	},
	beta: {
		label: "Beta",
		latest: "Latest beta",
		detail:
			"Builds of the staging branch, ahead of the stable release they lead to, plus every stable release.",
	},
	nightly: {
		label: "Nightly",
		latest: "Latest nightly",
		detail:
			"A build of the develop branch every night it changed, plus every beta and stable release.",
	},
};

const STEPS: { id: UpdateStepId; name: string; detail: string }[] = [
	{
		id: "pull",
		name: "Pull images",
		detail: "All four, before any service changes",
	},
	{
		id: "drain",
		name: "Finish running work",
		detail: "Deployments, backups and migration steps finish; new ones wait",
	},
	{
		id: "migrate",
		name: "Migrate the database",
		detail: "Once, before any new code serves",
	},
	{
		id: "logistack-api",
		name: "API",
		detail: "The old one serves until the new one is healthy",
	},
	{ id: "logistack-agent", name: "Agents", detail: "One on every server" },
	{
		id: "caddy",
		name: "Caddy",
		detail: "Ingress pauses for a few seconds",
	},
	{
		id: "logistack-worker",
		name: "Worker",
		detail: "Last, from an updater task that outlives it",
	},
];

function availability(s: UpdateStatus): StatusMeta {
	if (s.updateAvailable && s.latest)
		return { label: `${tag(s.latest.version)} is available`, tone: "info" };
	if (s.latestError && !s.latest)
		return { label: "Couldn't reach GitHub", tone: "warn" };
	if (!s.latest) return { label: "No release published yet", tone: "idle" };
	return { label: "Up to date", tone: "ok" };
}

function VersionCell({
	label,
	version,
	children,
}: {
	label: string;
	version: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="min-w-0 px-4 py-4 sm:px-5">
			<div className="text-[13px] text-muted-foreground">{label}</div>
			<div className="mt-1 font-mono text-lg font-medium tracking-tight">
				{version}
			</div>
			<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
				{children}
			</div>
		</div>
	);
}

function Updates() {
	const { data: s, isPending, error } = useUpdateStatus();
	const { data: me } = useQuery(meQuery);
	// Updates change the server every organization shares: an instance admin's call.
	const admin =
		!!me?.instanceAdmin &&
		!!me?.roles.some((r) => r === "owner" || r === "admin");
	const check = useCheckNow();
	const start = useStartUpdate();
	const autoCheck = useSetAutoCheck();
	const channel = useSetChannel();
	const [confirming, setConfirming] = useState(false);

	const busy = isActive(s?.run);
	// A finished update stays in the status forever; its reload prompt only matters to a tab opened before it ended.
	const run =
		s?.run &&
		(s.run.state !== "succeeded" ||
			Date.parse(s.run.updatedAt) > performance.timeOrigin)
			? s.run
			: null;
	const target = s?.latest && s.updateAvailable ? s.latest : null;

	const update = () => {
		if (!target) return;
		start.mutate(target.version, {
			onSuccess: () => setConfirming(false),
			onError: (err) => {
				setConfirming(false);
				toast.error("The update didn't start", { description: err.message });
			},
		});
	};

	return (
		<Page className="max-w-3xl">
			<PageHeader
				title="Updates"
				description="The release this instance runs, the newest one on GitHub, and the update between them."
				actions={
					<Button
						variant="outline"
						disabled={!s || check.isPending}
						onClick={() =>
							check.mutate(undefined, {
								onError: (err) =>
									toast.error("Couldn't check for updates", {
										description: err.message,
									}),
							})
						}
					>
						<RefreshCw className={cn(check.isPending && "animate-spin")} />
						Check now
					</Button>
				}
			/>
			<div className="grid gap-8">
				<Panel id="version" title="Version">
					{isPending ? (
						<SkeletonRows rows={3} />
					) : !s ? (
						<p className="p-4 text-sm text-bad-text">
							{error?.message ?? "The update status didn't load."}
						</p>
					) : (
						<>
							<div className="grid divide-y sm:grid-cols-[1fr_auto_1fr] sm:divide-y-0">
								<VersionCell
									label="This instance"
									version={tag(s.current.version)}
								>
									{s.current.commit ? (
										<span className="font-mono">
											{s.current.commit.slice(0, 7)}
										</span>
									) : (
										<span>Built without a commit</span>
									)}
								</VersionCell>
								<div
									aria-hidden
									className="hidden items-center text-muted-foreground/60 sm:flex"
								>
									<ArrowRight className="size-4" />
								</div>
								<VersionCell
									label={
										CHANNELS[
											s.latest ? versionChannel(s.latest.version) : "stable"
										].latest
									}
									version={s.latest ? tag(s.latest.version) : "None yet"}
								>
									{s.latest?.publishedAt && (
										<span>Published {relativeTime(s.latest.publishedAt)}</span>
									)}
									{s.latest && (
										<a
											href={s.latest.url}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
										>
											GitHub
											<ExternalLink className="size-3" aria-hidden />
										</a>
									)}
								</VersionCell>
							</div>
							<div className="flex flex-col gap-3 border-t bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
								<div className="min-w-0">
									<StatusLabel meta={availability(s)} />
									<p className="mt-0.5 text-[13px] text-muted-foreground">
										{s.latestError
											? s.latestError
											: s.checkedAt
												? `Checked ${relativeTime(s.checkedAt)}`
												: null}
									</p>
								</div>
								{target &&
									(admin ? (
										<Button disabled={busy} onClick={() => setConfirming(true)}>
											{busy && <Loader2 className="animate-spin" />}
											Update to {tag(target.version)}
										</Button>
									) : (
										<p className="text-[13px] text-muted-foreground">
											An instance admin can update this instance.
										</p>
									))}
							</div>
						</>
					)}
				</Panel>

				{run && <RunPanel run={run} />}

				{target && s?.changelog.length ? (
					<Changelog
						key={target.version}
						from={s.current.version}
						entries={s.changelog}
					/>
				) : (
					s?.latest?.notes && (
						<Panel
							id="notes"
							title={`Release notes for ${tag(s.latest.version)}`}
						>
							<Notes key={s.latest.version} source={s.latest.notes} />
						</Panel>
					)
				)}

				<Panel id="settings" title="Settings" bodyClassName="divide-y">
					<div className="flex items-start justify-between gap-6 p-4 sm:px-5">
						<div className="min-w-0">
							<label
								htmlFor="auto-check-switch"
								className="text-sm font-medium"
							>
								Check daily
							</label>
							<p
								id="auto-check-msg"
								className="mt-1 max-w-[60ch] text-sm text-pretty text-muted-foreground"
							>
								Once a day the worker asks GitHub for the latest release and,
								when it is newer, sends{" "}
								<span className="font-mono text-[13px] text-foreground">
									instance.update_available
								</span>{" "}
								to the notification rules that include it. Nothing updates until
								an instance admin chooses to.
							</p>
						</div>
						<Switch
							id="auto-check-switch"
							aria-describedby="auto-check-msg"
							checked={s?.autoCheck ?? true}
							disabled={!s || !admin || autoCheck.isPending}
							onCheckedChange={(on) =>
								autoCheck.mutate(on, {
									onSuccess: () =>
										toast(on ? "Daily checks on" : "Daily checks off"),
									onError: (err) =>
										toast.error("Couldn't change the setting", {
											description: err.message,
										}),
								})
							}
						/>
					</div>
					<div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:px-5">
						<div className="min-w-0">
							<div id="channel-label" className="text-sm font-medium">
								Release channel
							</div>
							<p
								key={s?.channel}
								className="t-swap mt-1 max-w-[60ch] text-sm text-pretty text-muted-foreground"
							>
								{CHANNELS[s?.channel ?? "stable"].detail} Switching to a
								steadier channel doesn't roll back: the instance stays where it
								is until that channel has a newer build.
							</p>
						</div>
						<div className="shrink-0">
							<Segmented
								label="Release channel"
								value={s?.channel ?? "stable"}
								disabled={!s || !admin || channel.isPending}
								options={(Object.keys(CHANNELS) as ReleaseChannel[]).map(
									(c) => ({ value: c, label: CHANNELS[c].label }),
								)}
								onChange={(c) =>
									channel.mutate(c, {
										onSuccess: () =>
											toast(`${CHANNELS[c].label} channel`, {
												description: "Checking for updates on this channel.",
											}),
										onError: (err) =>
											toast.error("Couldn't change the channel", {
												description: err.message,
											}),
									})
								}
							/>
						</div>
					</div>
					{s && s.channel !== "stable" && (
						<div className="border-t-0! px-4 pb-4 sm:px-5">
							<div className="t-reveal flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
								<TriangleAlert
									className="mt-0.5 size-4 shrink-0 text-warn-text"
									aria-hidden
								/>
								<p className="max-w-[68ch] text-pretty">
									<span className="font-medium">
										{s.channel === "beta" ? "Betas" : "Nightlies"} aren't ready
										for production.
									</span>{" "}
									<span className="text-muted-foreground">
										They pass the build but not the full test suite, and a
										migration they bring can't be undone. Keep this channel off
										servers that host anything you depend on.
									</span>
								</p>
							</div>
						</div>
					)}
				</Panel>

				<SponsorNote />
			</div>

			{target && (
				<ConfirmDialog
					open={confirming}
					onOpenChange={setConfirming}
					title={`Update to ${tag(target.version)}?`}
					description="LogiStack pulls every image first and changes nothing if one is missing. It waits for running deployments and backups to finish, migrates the database once, then updates the API, the agents, Caddy and the worker. A service that doesn't turn healthy rolls back, and so does every service updated before it."
					confirmLabel={`Update to ${tag(target.version)}`}
					destructive={false}
					pending={start.isPending}
					onConfirm={update}
				>
					<BreakingSummary entries={s?.changelog ?? []} />
					<p className="text-sm text-muted-foreground">
						The dashboard stays up while the API rolls over. New deployments
						wait in the queue until the update ends. Sites pause for a few
						seconds while Caddy restarts.
					</p>
				</ConfirmDialog>
			)}
		</Page>
	);
}

/** Every release the update crosses, newest first, breaking changes set apart above each one's notes. */
function Changelog({
	from,
	entries,
}: {
	from: string;
	entries: ChangelogEntry[];
}) {
	const breaking = entries.filter((e) => e.breaking).length;
	const [newest] = entries;
	if (!newest) return null;
	return (
		<Panel
			id="changelog"
			title={`What changes from ${tag(from)} to ${tag(newest.version)}`}
			actions={
				breaking > 0 && (
					<span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-warn-text">
						<TriangleAlert className="size-3.5" aria-hidden />
						{breaking === 1
							? "1 breaking change"
							: `${breaking} releases with breaking changes`}
					</span>
				)
			}
			bodyClassName="divide-y"
		>
			{entries.map((e) => (
				<section key={e.version} aria-labelledby={`release-${e.version}`}>
					<div className="flex items-baseline justify-between gap-4 px-4 pt-4 sm:px-5">
						<h3
							id={`release-${e.version}`}
							className="font-mono text-sm font-medium"
						>
							{tag(e.version)}
						</h3>
						<div className="flex items-center gap-3 text-[13px] text-muted-foreground">
							{e.publishedAt && <span>{relativeTime(e.publishedAt)}</span>}
							<a
								href={e.url}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
							>
								GitHub
								<ExternalLink className="size-3" aria-hidden />
							</a>
						</div>
					</div>
					{e.breaking && (
						<div className="mx-4 mt-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm sm:mx-5">
							<div className="mb-1.5 flex items-center gap-2 font-medium">
								<TriangleAlert
									className="size-4 shrink-0 text-warn-text"
									aria-hidden
								/>
								Breaking changes
							</div>
							<Markdown source={e.breaking} />
						</div>
					)}
					<Notes source={withoutBreakingChanges(e.notes)} />
				</section>
			))}
		</Panel>
	);
}

/** In the confirm dialog: the releases whose breaking changes need reading before updating. */
function BreakingSummary({ entries }: { entries: ChangelogEntry[] }) {
	const breaking = entries.filter((e) => e.breaking);
	if (!breaking.length) return null;
	return (
		<div className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
			<TriangleAlert
				className="mt-0.5 size-4 shrink-0 text-warn-text"
				aria-hidden
			/>
			<p className="text-pretty">
				<span className="font-medium">
					{breaking.map((e) => tag(e.version)).join(", ")}{" "}
					{breaking.length === 1 ? "has" : "have"} breaking changes.
				</span>{" "}
				<span className="text-muted-foreground">
					Read them in the changelog on this page before you update; some need a
					change on your side.
				</span>
			</p>
		</div>
	);
}

/** Release notes run long; show the top and let the reader open the rest. */
function Notes({ source }: { source: string }) {
	const [open, setOpen] = useState(false);
	const [long, setLong] = useState(false);
	return (
		<div>
			<div
				ref={(el) => {
					if (el) setLong(el.scrollHeight > 320);
				}}
				className={cn(
					"relative px-4 py-4 sm:px-5",
					!open &&
						long &&
						"max-h-80 overflow-hidden mask-b-from-60% mask-b-to-100%",
				)}
			>
				<Markdown source={source} />
			</div>
			{long && (
				<div className="border-t bg-muted/40 px-4 py-2.5 sm:px-5">
					<button
						type="button"
						aria-expanded={open}
						onClick={() => setOpen((o) => !o)}
						className="rounded-sm text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
					>
						{open ? "Show less" : "Show all notes"}
					</button>
				</div>
			)}
		</div>
	);
}

/** One quiet line under the release settings; sponsors never see it. */
function SponsorNote() {
	const { loaded, sponsor } = useIsSponsor();
	if (!loaded || sponsor) return null;
	return (
		<p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t pt-5 text-sm text-pretty text-muted-foreground">
			<Heart className="size-3.5 text-primary" aria-hidden />
			Every release is free and complete. Sponsors pay for the work behind it.
			<a
				href={SPONSOR_URL}
				target="_blank"
				rel="noreferrer"
				className="inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
			>
				Sponsor LogiStack
				<ArrowUpRight className="size-3.5" aria-hidden />
			</a>
		</p>
	);
}

function RunPanel({ run }: { run: UpdateRun }) {
	const meta = UPDATE_STATUS[run.state];
	const latest = run.log.at(-1);
	const waiting = run.log.findLast((l) => l.startsWith("Waiting for"));
	return (
		<Panel
			id="run"
			title={`${tag(run.fromVersion)} to ${tag(run.toVersion)}`}
			actions={<StatusLabel meta={meta} />}
			className="t-reveal"
		>
			<ol className="divide-y" aria-label="Update steps">
				{/* An updater from before a step existed never lists it; don't show it as waiting. */}
				{STEPS.filter(
					(s) => s.id in run.steps || !Object.keys(run.steps).length,
				).map((step) => {
					const state = run.steps[step.id] ?? "pending";
					const m = UPDATE_STEP_STATUS[state];
					const detail =
						step.id === "drain" && state === "running" && waiting
							? waiting
							: step.detail;
					return (
						<li
							key={step.id}
							className="flex items-center gap-3 px-4 py-3 sm:px-5"
						>
							<StatusDot meta={m} />
							<div className="min-w-0 flex-1">
								<div
									className={cn(
										"text-sm font-medium",
										state === "pending" && "text-muted-foreground",
									)}
								>
									{step.name}
								</div>
								<div
									key={detail}
									className="t-swap text-[13px] text-muted-foreground"
								>
									{detail}
								</div>
							</div>
							<span
								key={state}
								className={cn(
									"t-swap shrink-0 text-[13px]",
									state === "failed"
										? "text-bad-text"
										: state === "rolled_back"
											? "text-warn-text"
											: "text-muted-foreground",
								)}
							>
								{m.label}
							</span>
						</li>
					);
				})}
			</ol>
			<div className="border-t bg-muted/40 px-4 py-3 sm:px-5">
				{run.state === "failed" && run.error ? (
					<p className="text-sm text-bad-text">{run.error}</p>
				) : run.state === "succeeded" ? (
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<p className="text-sm">
							Every service runs {tag(run.toVersion)}. Reload to load the new
							dashboard.
						</p>
						<Button variant="outline" onClick={() => window.location.reload()}>
							Reload
						</Button>
					</div>
				) : (
					latest && (
						<p
							key={latest}
							className="t-swap truncate font-mono text-[13px] text-muted-foreground"
							aria-live="polite"
						>
							{latest}
						</p>
					)
				)}
				{run.log.length > 0 && (
					<details className="group mt-2">
						<summary className="w-fit cursor-pointer rounded-sm text-[13px] text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
							Full log, {run.log.length} lines
						</summary>
						<pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-background px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap ring-1 ring-border">
							{run.log.join("\n")}
						</pre>
					</details>
				)}
			</div>
		</Panel>
	);
}
