import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	ArrowLeft,
	CircleAlert,
	CircleCheck,
	CopyPlus,
	History,
	Loader2,
	TriangleAlert,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { RunStatusLabel } from "@/components/backups/schedule-parts";
import {
	policyTitle,
	restorable,
	useServiceProject,
} from "@/components/backups/service-backups";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { Page, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoiceGroup } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
	type ServiceBackups,
	serviceBackupsQuery,
	useBackupRun,
	useRestore,
} from "@/lib/api/backups";
import { formatDuration, relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";
import { stepParam } from "@/lib/search";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/backups/$serviceId/restore")({
	validateSearch: z.object({
		step: stepParam,
		run: z.string().optional(),
		/** The restore run to follow once it is queued. */
		progress: z.string().optional(),
		target: z.string().optional(),
	}),
	staticData: { crumb: "Restore" },
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(serviceBackupsQuery(params.serviceId)),
	component: RestorePage,
});

type V = {
	runId: string;
	targetKind: "same" | "new";
	newName: string;
	confirm: string;
};

const shortDate = (iso: string) =>
	new Date(iso).toLocaleString("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

function buildSteps(data: ServiceBackups): WizardStep<V>[] {
	const runs = data.runs.filter((r) => restorable(r, data)).slice(0, 10);
	const policyOf = (runId: string) => {
		const run = data.runs.find((r) => r.id === runId);
		return data.policies.find((p) => p.id === run?.policyId);
	};
	const isVolume = (v: V) => policyOf(v.runId)?.target === "volume";
	const expected = (v: V) =>
		v.targetKind === "same" ? data.service.name : v.newName.trim();

	return [
		{
			id: "backup",
			title: "Pick a backup",
			description:
				"Only finished backups that retention hasn't deleted can be restored.",
			schema: z.object({ runId: z.string().min(1, "Choose a backup.") }),
			render: (w) => (
				<ChoiceGroup
					label="Backup"
					columns={1}
					value={w.values.runId || undefined}
					onChange={(id) => w.set("runId", id)}
					choices={runs.map((r) => {
						const p = data.policies.find((x) => x.id === r.policyId);
						return {
							value: r.id,
							title: `${shortDate(r.startedAt)}, ${relativeTime(r.startedAt)}`,
							description: [
								formatBytes(r.sizeBytes, true),
								p ? policyTitle(p, data) : null,
								r.checksum ? `sha256 ${r.checksum.slice(0, 12)}` : null,
							]
								.filter(Boolean)
								.join(" · "),
							icon: History,
						};
					})}
				/>
			),
		},
		{
			id: "target",
			title: "Restore into",
			description:
				"A copy is the safe default: compare it, then switch over or delete it.",
			schema: (v) =>
				v.targetKind === "new"
					? z.object({
							newName: z
								.string()
								.trim()
								.min(1, "Name the copy.")
								.max(100)
								.refine(
									(n) => n !== data.service.name,
									"Use a name that isn't the current service's.",
								),
						})
					: z.object({}),
			render: (w) => {
				const volume = isVolume(w.values);
				return (
					<div className="grid gap-5">
						<ChoiceGroup
							label="Restore into"
							columns={1}
							value={w.values.targetKind}
							onChange={(k) => {
								w.set("targetKind", k);
								w.set("confirm", "");
							}}
							choices={[
								{
									value: "new",
									title: volume ? "A new volume" : "A new service beside it",
									description: volume
										? "Restored into a fresh volume next to the current one. The service keeps running on its own data."
										: `Same engine, version and credentials as ${data.service.name}, in the same environment. Deployed, then restored.`,
									icon: CopyPlus,
									badge: "Safe",
								},
								{
									value: "same",
									title: `Overwrite ${data.service.name}`,
									description: volume
										? "The volume is emptied and filled from the archive. Anything written since the backup is lost."
										: "Objects are dropped and recreated from the dump. Anything written since the backup is lost.",
									icon: TriangleAlert,
								},
							]}
						/>
						{w.values.targetKind === "new" && (
							<Field
								id="wz-newName"
								label={volume ? "Name for the copy" : "Service name"}
								error={w.error("newName")}
								hint="Delete it when you're done; it's billed and backed up like any other service."
							>
								<Input
									{...w.bind("newName")}
									autoCapitalize="none"
									spellCheck={false}
									className="font-mono"
								/>
							</Field>
						)}
					</div>
				);
			},
		},
		{
			id: "confirm",
			title: "Confirm",
			schema: (v) =>
				z.object({
					confirm: z
						.string()
						.refine((c) => c === expected(v), `Type ${expected(v)} exactly.`),
				}),
			render: (w) => {
				const v = w.values;
				const run = data.runs.find((r) => r.id === v.runId);
				const same = v.targetKind === "same";
				return (
					<div className="grid gap-5">
						<div
							role="note"
							className={cn(
								"flex gap-3 rounded-lg p-4 text-sm ring-1",
								same
									? "bg-bad/8 ring-bad/25"
									: "bg-muted/60 ring-transparent dark:bg-muted/40",
							)}
						>
							{same ? (
								<TriangleAlert
									className="mt-0.5 size-4 shrink-0 text-bad-text"
									aria-hidden
								/>
							) : (
								<CopyPlus
									className="mt-0.5 size-4 shrink-0 text-muted-foreground"
									aria-hidden
								/>
							)}
							<div className="grid gap-1">
								<p className={cn("font-medium", same && "text-bad-text")}>
									{same
										? `${data.service.name} goes back to ${run ? shortDate(run.startedAt) : "the backup"}`
										: `${expected(v) || "The copy"} gets the data from ${run ? shortDate(run.startedAt) : "the backup"}`}
								</p>
								<p className="text-muted-foreground">
									{same
										? "Everything written after the backup is gone once this finishes, and there is no undo. Take a fresh backup first if you're unsure."
										: `${data.service.name} isn't touched. The copy appears in the same environment.`}
								</p>
							</div>
						</div>
						<Field
							id="wz-confirm"
							label={`Type ${expected(v)} to confirm`}
							error={w.error("confirm")}
						>
							<Input
								{...w.bind("confirm")}
								autoCapitalize="none"
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
								placeholder={expected(v)}
								autoFocus
							/>
						</Field>
					</div>
				);
			},
		},
	];
}

function Progress({
	runId,
	targetServiceId,
	data,
}: {
	runId: string;
	targetServiceId?: string;
	data: ServiceBackups;
}) {
	const { run, progress, error } = useBackupRun(runId);
	const project = useServiceProject(data.service.id);
	const running = !run || run.status === "running";
	const now = useNow(1000, running);
	const elapsed = run
		? ((run.finishedAt ? new Date(run.finishedAt).getTime() : now) -
				new Date(run.startedAt).getTime()) /
			1000
		: 0;
	const ratio =
		progress?.total && progress.total > 0
			? Math.min(1, progress.bytes / progress.total)
			: null;
	const copy = targetServiceId && targetServiceId !== data.service.id;
	const ok = run?.status === "succeeded";
	const failed = run?.status === "failed";

	return (
		<Panel
			title={copy ? "Restoring into a copy" : `Restoring ${data.service.name}`}
			actions={run && <RunStatusLabel status={run.status} />}
		>
			<div className="grid gap-5 p-5" aria-live="polite">
				<div className="flex items-start gap-3">
					<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
						{ok ? (
							<CircleCheck className="t-reveal size-5 text-ok-text" />
						) : failed ? (
							<CircleAlert className="t-reveal size-5 text-bad-text" />
						) : (
							<Loader2 className="size-4 animate-spin text-muted-foreground" />
						)}
					</span>
					<div className="min-w-0 flex-1">
						<p
							key={ok ? "ok" : failed ? "bad" : (progress?.phase ?? "start")}
							className="t-swap text-sm font-medium"
						>
							{ok
								? "Restore finished"
								: failed
									? "The restore failed"
									: (progress?.phase ?? "Queued, waiting for the worker")}
						</p>
						<p className="mt-0.5 text-sm text-muted-foreground tabular">
							{failed
								? (run?.error ?? error?.message ?? "No error was recorded.")
								: ok
									? `Took ${formatDuration(elapsed)}.${run?.detail ? ` ${run.detail}.` : ""}`
									: progress
										? `${formatBytes(progress.bytes, true)}${progress.total ? ` of ${formatBytes(progress.total, true)}` : ""} · ${formatDuration(elapsed)}`
										: `${formatDuration(elapsed)} so far`}
						</p>
					</div>
				</div>
				<div
					role="progressbar"
					aria-label="Restore progress"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={
						ok ? 100 : ratio === null ? undefined : Math.round(ratio * 100)
					}
					className="h-1.5 overflow-hidden rounded-full bg-muted"
				>
					<div
						className={cn(
							"h-full rounded-full transition-[width] duration-(--duration-slow) ease-(--ease-smooth-out)",
							ok ? "bg-ok" : failed ? "bg-bad" : "bg-foreground",
							!ok && !failed && ratio === null && "t-skel w-1/3",
						)}
						style={
							ok || failed || ratio !== null
								? { width: `${ok ? 100 : failed ? 100 : (ratio ?? 0) * 100}%` }
								: undefined
						}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{ok && copy && project && (
						<Button asChild>
							<Link
								to="/projects/$projectId"
								params={{ projectId: project.id }}
							>
								Open {project.name}
							</Link>
						</Button>
					)}
					<Button
						asChild
						variant={ok && copy && project ? "outline" : "default"}
					>
						<Link
							to="/backups/$serviceId"
							params={{ serviceId: data.service.id }}
						>
							<ArrowLeft data-icon="inline-start" />
							Back to backups
						</Link>
					</Button>
					{failed && (
						<Button asChild variant="outline">
							<Link
								to="/backups/$serviceId/restore"
								params={{ serviceId: data.service.id }}
								search={{ step: "target", run: run?.sourceRunId ?? undefined }}
							>
								Try again
							</Link>
						</Button>
					)}
				</div>
				{running && (
					<p className="text-xs text-muted-foreground">
						You can leave this page; the restore keeps going and shows under
						recent runs.
					</p>
				)}
			</div>
		</Panel>
	);
}

function RestorePage() {
	const { serviceId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data } = useQuery(serviceBackupsQuery(serviceId));
	const restore = useRestore();
	// Arriving from a run's Restore button starts fresh on that run, not on a stale draft.
	useState(() => {
		if (search.run && !search.step)
			try {
				sessionStorage.removeItem(`wizard:restore:${serviceId}`);
			} catch {}
	});
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	const steps = useMemo(() => (data ? buildSteps(data) : []), [data]);
	if (!data) return null;

	const header = (
		<PageHeader
			title={`Restore ${data.service.name}`}
			description="From a backup in S3, into the service itself or into a copy beside it."
		/>
	);

	if (search.progress)
		return (
			<Page className="max-w-3xl">
				{header}
				<Progress
					runId={search.progress}
					targetServiceId={search.target}
					data={data}
				/>
			</Page>
		);

	if (!data.runs.some((r) => restorable(r, data)))
		return (
			<Page className="max-w-3xl">
				{header}
				<EmptyState
					icon={History}
					title="No backup to restore yet"
					description="Restores start from a finished backup that retention still keeps. Run a backup first."
				>
					<Button asChild variant="outline">
						<Link to="/backups/$serviceId" params={{ serviceId }}>
							Back to backups
						</Link>
					</Button>
				</EmptyState>
			</Page>
		);

	const stamp = new Date()
		.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
		.toLowerCase()
		.replace(" ", "-");
	return (
		<Page className="max-w-5xl">
			{header}
			<Wizard<V>
				id={`restore:${serviceId}`}
				steps={steps}
				defaultValues={{
					runId: search.run ?? "",
					targetKind: "new",
					newName: `${data.service.name}-restore-${stamp}`,
					confirm: "",
				}}
				step={search.step}
				onStepChange={onStepChange}
				finishLabel="Restore now"
				onComplete={async (v) => {
					const target =
						v.targetKind === "same"
							? { kind: "same" as const }
							: { kind: "new" as const, name: v.newName.trim() };
					const res = await restore.mutateAsync({
						runId: v.runId,
						target,
						confirm: v.confirm,
					});
					await navigate({
						search: { progress: res.run.id, target: res.targetServiceId },
					});
				}}
			/>
		</Page>
	);
}
