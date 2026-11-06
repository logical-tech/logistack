import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	ArrowRight,
	ExternalLink,
	Loader2,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusDot, StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { meQuery } from "@/lib/api/access";
import {
	isActive,
	type UpdateRun,
	type UpdateStatus,
	type UpdateStepId,
	useCheckNow,
	useSetAutoCheck,
	useSetBeta,
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
	const admin = !!me?.roles.some((r) => r === "owner" || r === "admin");
	const check = useCheckNow();
	const start = useStartUpdate();
	const autoCheck = useSetAutoCheck();
	const beta = useSetBeta();
	const [confirming, setConfirming] = useState(false);

	const busy = isActive(s?.run);
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
										s.latest?.version.includes("-")
											? "Latest beta"
											: "Latest release"
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
											An admin can update this instance.
										</p>
									))}
							</div>
						</>
					)}
				</Panel>

				{s?.run && <RunPanel run={s.run} />}

				{s?.latest?.notes && (
					<Panel id="notes" title={`What's new in ${tag(s.latest.version)}`}>
						<div className="px-4 py-4 sm:px-5">
							<Markdown source={s.latest.notes} />
						</div>
					</Panel>
				)}

				<Panel id="auto-check" title="Automatic checks">
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
								an admin chooses to.
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
				</Panel>

				<Panel id="channel" title="Release channel">
					<div className="flex items-start justify-between gap-6 p-4 sm:px-5">
						<div className="min-w-0">
							<label htmlFor="beta-switch" className="text-sm font-medium">
								Beta updates
							</label>
							<p
								id="beta-msg"
								className="mt-1 max-w-[60ch] text-sm text-pretty text-muted-foreground"
							>
								Offer the builds of the staging branch as updates, ahead of the
								stable release they lead to. Turning this off doesn't roll back:
								the instance stays on its beta until a newer stable release is
								out.
							</p>
						</div>
						<Switch
							id="beta-switch"
							aria-describedby="beta-msg"
							checked={s?.beta ?? false}
							disabled={!s || !admin || beta.isPending}
							onCheckedChange={(on) =>
								beta.mutate(on, {
									onSuccess: () =>
										toast(on ? "Beta updates on" : "Beta updates off"),
									onError: (err) =>
										toast.error("Couldn't change the setting", {
											description: err.message,
										}),
								})
							}
						/>
					</div>
					{s?.beta && (
						<div className="px-4 pb-4 sm:px-5">
							<div className="t-reveal flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
								<TriangleAlert
									className="mt-0.5 size-4 shrink-0 text-warn-text"
									aria-hidden
								/>
								<p className="max-w-[68ch] text-pretty">
									<span className="font-medium">
										Betas aren't ready for production.
									</span>{" "}
									<span className="text-muted-foreground">
										They pass the build but not the full test suite, and a
										migration they bring can't be undone. Keep this off on
										servers that host anything you depend on.
									</span>
								</p>
							</div>
						</div>
					)}
				</Panel>
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
