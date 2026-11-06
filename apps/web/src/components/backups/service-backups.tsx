import { type DatabaseEngine, dumpOnlyEngines } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import {
	ChevronRight,
	DatabaseBackup,
	HardDrive,
	Loader2,
	Lock,
	Play,
	Plus,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { KindTile } from "@/components/integration-kinds";
import { ConfirmDelete } from "@/components/integrations/parts";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
	type BackupPolicy,
	type BackupRun,
	type ServiceBackups as Backups,
	type PolicyWithKey,
	serviceBackupsQuery,
	useBackupRun,
	useDeletePolicy,
	useRunPolicy,
	useUpdatePolicy,
} from "@/lib/api/backups";
import { projectsQuery } from "@/lib/api/projects";
import { describeCron } from "@/lib/cron";
import { formatDuration, relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { BackupKeyReveal, DecryptHelp, useDecryptCommand } from "./backup-key";
import { RunStatusLabel } from "./schedule-parts";

const ENGINE_DUMP: Record<string, string> = {
	postgres: "pg_dump",
	mysql: "mysqldump",
	mariadb: "mariadb-dump",
	mongo: "mongodump",
	redis: "RDB snapshot",
	libsql: "sqld /dump",
};

export function policyTitle(p: BackupPolicy, data: Backups) {
	if (p.target === "database") {
		const tool = data.service.engine ? ENGINE_DUMP[data.service.engine] : null;
		return tool ? `Database dump (${tool})` : "Database dump";
	}
	const v = data.volumes.find((x) => x.id === p.volumeName);
	return `Volume ${v?.label ?? p.volumeName ?? ""}`.trim();
}

export function retentionText(r: BackupPolicy["retention"]) {
	const parts = [
		r.count && `newest ${r.count}`,
		r.days && `up to ${r.days} ${r.days === 1 ? "day" : "days"} old`,
	].filter(Boolean);
	// A backup survives if either rule keeps it (selectForDeletion in @logistack/providers).
	return parts.length
		? `Keeps ${parts.join(", plus any ")}`
		: "Keeps everything";
}

export const restorable = (r: BackupRun, data: Backups) => {
	const policy = data.policies.find((p) => p.id === r.policyId);
	return (
		r.kind === "backup" &&
		r.status === "succeeded" &&
		!r.prunedAt &&
		!!r.objectKey &&
		// These dumps come back by copying the volume; the server refuses a database restore.
		!(
			policy?.target === "database" &&
			dumpOnlyEngines.includes(data.service.engine as DatabaseEngine)
		)
	);
};

/** The project a service lives in, from the cached project list. */
export function useServiceProject(serviceId: string) {
	const { data } = useQuery(projectsQuery);
	return data?.find((p) => p.services.some((s) => s.id === serviceId));
}

const runDuration = (r: BackupRun) =>
	r.finishedAt
		? formatDuration(
				(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) /
					1000,
			)
		: null;

const KIND_LABEL: Record<BackupRun["kind"], string> = {
	backup: "Backup",
	verify: "Verify",
	restore: "Restore",
};

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
			<dd className="mt-0.5 truncate text-sm">{children}</dd>
		</div>
	);
}

function RunButton({
	policy,
	kind,
}: {
	policy: BackupPolicy;
	kind: "backup" | "verify";
}) {
	const run = useRunPolicy();
	const Icon = kind === "backup" ? Play : ShieldCheck;
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			disabled={run.isPending}
			onClick={() =>
				run.mutate(
					{ id: policy.id, kind },
					{
						onSuccess: () =>
							toast.success(
								kind === "backup" ? "Backup started" : "Verify started",
								{
									description:
										kind === "backup"
											? `Writing to ${policy.destinationName}. It shows under recent runs.`
											: "The newest backup is restored into a scratch container and checked.",
								},
							),
						onError: (e) =>
							toast.error(
								`Couldn't start the ${kind === "backup" ? "backup" : "verify"}`,
								{ description: e.message },
							),
					},
				)
			}
		>
			{run.isPending ? (
				<Loader2 className="animate-spin" />
			) : (
				<Icon data-icon="inline-start" />
			)}
			{kind === "backup" ? "Run now" : "Verify now"}
		</Button>
	);
}

/** Turns encryption on for later backups, then shows the new key once. */
function EncryptDialog({
	policy,
	open,
	onOpenChange,
}: {
	policy: BackupPolicy;
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const update = useUpdatePolicy();
	const [done, setDone] = useState<PolicyWithKey | null>(null);
	// The key leaves memory with the dialog.
	const close = (o: boolean) => {
		onOpenChange(o);
		if (!o) setDone(null);
	};
	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-lg">
				{done?.encryptionKey ? (
					<>
						<DialogHeader>
							<DialogTitle>Save the backup key</DialogTitle>
							<DialogDescription>
								Backups from now on are encrypted with this key.
							</DialogDescription>
						</DialogHeader>
						<BackupKeyReveal policy={done} encryptionKey={done.encryptionKey} />
						<DialogFooter>
							<Button onClick={() => close(false)}>I've saved the key</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Encrypt these backups?</DialogTitle>
							<DialogDescription className="text-pretty">
								Later backups are encrypted with age before they leave this
								server; earlier ones stay as they are and still restore.
								LogiStack shows the new key once. Encryption cannot be turned
								off afterwards.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="outline" onClick={() => close(false)}>
								Cancel
							</Button>
							<Button
								disabled={update.isPending}
								onClick={() =>
									update.mutate(
										{ id: policy.id, encrypt: true },
										{
											onSuccess: setDone,
											onError: (e) =>
												toast.error("Couldn't turn on encryption", {
													description: e.message,
												}),
										},
									)
								}
							>
								{update.isPending && <Loader2 className="animate-spin" />}
								Encrypt and show the key
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function EncryptionLine({ policy }: { policy: BackupPolicy }) {
	const [encrypting, setEncrypting] = useState(false);
	const last = policy.lastRun?.objectKey;
	const command = useDecryptCommand(
		policy,
		last?.endsWith(".age") ? last : undefined,
	);
	return (
		<>
			{policy.encrypted ? (
				<Collapsible className="sm:pl-11">
					<CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
						<Lock className="size-3.5" aria-hidden />
						Encrypted with age
						<span aria-hidden>·</span>
						<span className="text-foreground">Decrypt without LogiStack</span>
						<ChevronRight
							className="size-3.5 transition-transform duration-(--duration-fast) group-data-[state=open]:rotate-90"
							aria-hidden
						/>
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-3">
						<DecryptHelp command={command} />
					</CollapsibleContent>
				</Collapsible>
			) : (
				<p className="text-xs text-muted-foreground sm:pl-11">
					Stored unencrypted in the bucket.{" "}
					<button
						type="button"
						className="font-medium text-foreground underline-offset-2 hover:underline"
						onClick={() => setEncrypting(true)}
					>
						Encrypt backups
					</button>
				</p>
			)}
			{/* Stays mounted while the policy flips to encrypted, so the key stays on screen. */}
			<EncryptDialog
				policy={policy}
				open={encrypting}
				onOpenChange={setEncrypting}
			/>
		</>
	);
}

function PolicyRow({ policy, data }: { policy: BackupPolicy; data: Backups }) {
	const update = useUpdatePolicy();
	const remove = useDeletePolicy();
	const [deleting, setDeleting] = useState(false);
	const now = useNow(30_000);
	const title = policyTitle(policy, data);
	const when = describeCron(policy.cron) ?? policy.cron;
	const verify = policy.verifyCron
		? (describeCron(policy.verifyCron) ?? policy.verifyCron)
		: null;
	const last = policy.lastRun;
	return (
		<li className="grid gap-4 px-4 py-4">
			<div className="flex flex-wrap items-start gap-x-4 gap-y-3">
				<div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
					<KindTile
						icon={policy.target === "database" ? DatabaseBackup : HardDrive}
					/>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium">{title}</p>
						<p className="text-xs text-muted-foreground">
							{when}
							{policy.timezone !== "UTC" &&
								` · ${policy.timezone.replaceAll("_", " ")}`}{" "}
							to{" "}
							<span className="text-foreground">{policy.destinationName}</span>
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2 max-sm:w-full max-sm:pl-11">
					{policy.target === "database" && (
						<RunButton policy={policy} kind="verify" />
					)}
					<RunButton policy={policy} kind="backup" />
					<Switch
						checked={
							update.isPending
								? (update.variables?.enabled ?? policy.enabled)
								: policy.enabled
						}
						disabled={update.isPending}
						aria-label={`${policy.enabled ? "Pause" : "Resume"} ${title}`}
						className="ml-2"
						onCheckedChange={(enabled) =>
							update.mutate(
								{ id: policy.id, enabled },
								{
									onError: (e) =>
										toast.error("Couldn't change the policy", {
											description: e.message,
										}),
								},
							)
						}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={`Stop backing up ${title}`}
						onClick={() => setDeleting(true)}
					>
						<Trash2 />
					</Button>
				</div>
			</div>
			<dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 sm:pl-11">
				<Fact label="Next run">
					<span className="tabular">
						{policy.enabled && policy.nextRunAt
							? relativeTime(policy.nextRunAt, now)
							: "Paused"}
					</span>
				</Fact>
				<Fact label="Retention">
					{retentionText(policy.retention).replace("Keeps ", "")}
				</Fact>
				<Fact label={policy.target === "volume" ? "While archiving" : "Verify"}>
					{policy.target === "volume" ? (
						<span className="text-muted-foreground">
							{policy.pauseService ? "Pauses the service" : "Live copy"}
						</span>
					) : verify ? (
						verify
					) : (
						<span className="text-muted-foreground">Off</span>
					)}
				</Fact>
				<Fact label="Last run">
					{last ? (
						<RunStatusLabel status={last.status} />
					) : (
						<span className="text-muted-foreground">Not yet</span>
					)}
				</Fact>
			</dl>
			<EncryptionLine policy={policy} />
			<ConfirmDelete
				open={deleting}
				onOpenChange={setDeleting}
				title={`Stop backing up ${title.toLowerCase()}?`}
				description="The policy and its run history are removed. Backups already in the bucket stay there and can be restored by hand."
				action="Delete policy"
				onConfirm={() => remove.mutateAsync(policy.id)}
			/>
		</li>
	);
}

/** "Uploading · 640 MiB of 1.3 GiB" for a run in flight, from its live frames. */
function Running({ run }: { run: BackupRun }) {
	const { progress } = useBackupRun(run.id);
	return (
		<div className="min-w-0">
			<RunStatusLabel status="running" />
			<span className="block truncate text-xs text-muted-foreground tabular">
				{progress
					? `${progress.phase} · ${formatBytes(progress.bytes, true)}${progress.total ? ` of ${formatBytes(progress.total, true)}` : ""}`
					: "Starting"}
			</span>
		</div>
	);
}

const col = createColumnHelper<BaseFeatures, BackupRun>();

function runColumns(data: Backups) {
	return col.columns([
		col.display({
			id: "kind",
			header: "Run",
			meta: { className: "w-[22%] max-sm:w-[38%]" },
			cell: ({ row: { original: r } }) => {
				const p = data.policies.find((x) => x.id === r.policyId);
				return (
					<div className="min-w-0">
						<span className="block truncate font-medium">
							{KIND_LABEL[r.kind]}
							<span className="font-normal text-muted-foreground max-sm:hidden">
								{" "}
								· {p?.target === "volume" ? "volume" : "database"}
							</span>
						</span>
						<span
							className="block truncate text-xs text-muted-foreground tabular"
							title={new Date(r.startedAt).toLocaleString("en-GB")}
						>
							{relativeTime(r.startedAt)}
						</span>
					</div>
				);
			},
		}),
		col.display({
			id: "status",
			header: "Status",
			meta: { className: "w-[26%] max-sm:w-auto" },
			cell: ({ row: { original: r } }) =>
				r.status === "running" ? (
					<Running run={r} />
				) : (
					<div className="min-w-0">
						<RunStatusLabel status={r.status} />
						{(r.error || r.detail || r.prunedAt) && (
							<span
								className={cn(
									"block truncate text-xs",
									r.error ? "text-bad-text" : "text-muted-foreground",
								)}
								title={r.error ?? r.detail ?? undefined}
							>
								{r.error ?? (r.prunedAt ? "Pruned by retention" : r.detail)}
							</span>
						)}
					</div>
				),
		}),
		col.display({
			id: "size",
			header: "Size",
			meta: { className: "w-[12%] max-md:hidden" },
			cell: ({ row: { original: r } }) => (
				<span className="tabular">{formatBytes(r.sizeBytes, true)}</span>
			),
		}),
		col.display({
			id: "duration",
			header: "Took",
			meta: { className: "w-[11%] max-md:hidden" },
			cell: ({ row: { original: r } }) => (
				<span className="text-muted-foreground tabular">
					{runDuration(r) ?? "–"}
				</span>
			),
		}),
		col.display({
			id: "checksum",
			header: "SHA-256",
			meta: { className: "max-lg:hidden" },
			cell: ({ row: { original: r } }) =>
				r.checksum ? (
					<span
						className="font-mono text-xs text-muted-foreground"
						title={r.checksum}
					>
						{r.checksum.slice(0, 12)}
					</span>
				) : (
					<span className="text-muted-foreground">–</span>
				),
		}),
		col.display({
			id: "restore",
			header: () => <span className="sr-only">Restore</span>,
			meta: { className: "w-24 text-right max-sm:w-[5.5rem] max-sm:pl-0" },
			cell: ({ row: { original: r } }) =>
				restorable(r, data) ? (
					<Button variant="ghost" size="sm" asChild>
						<Link
							to="/backups/$serviceId/restore"
							params={{ serviceId: data.service.id }}
							search={{ run: r.id }}
						>
							Restore
						</Link>
					</Button>
				) : null,
		}),
	]);
}

/** Backup policies, recent runs and restore for one service. Mount it on a service page. */
export function ServiceBackups({ serviceId }: { serviceId: string }) {
	const { data, error } = useQuery(serviceBackupsQuery(serviceId));

	if (error)
		return (
			<p className="rounded-lg bg-muted/60 p-4 text-sm text-bad-text dark:bg-muted/40">
				Couldn't load backups: {error.message}
			</p>
		);
	if (!data)
		return (
			<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				<SkeletonRows rows={3} />
			</div>
		);

	const add = (label: string, variant: "default" | "outline" = "default") => (
		<Button
			asChild
			variant={variant}
			size={variant === "outline" ? "sm" : "default"}
		>
			<Link to="/backups/$serviceId/new" params={{ serviceId }}>
				<Plus data-icon="inline-start" />
				{label}
			</Link>
		</Button>
	);

	if (!data.policies.length)
		return (
			<EmptyState
				icon={DatabaseBackup}
				title={`Nothing backs up ${data.service.name} yet`}
				description={
					data.service.kind === "database"
						? "Dump the database to an S3 bucket on a cron, keep as many copies as you need, and test them with a scheduled restore."
						: "Archive the service's volumes to an S3 bucket on a cron and keep as many copies as you need."
				}
			>
				{add("Set up backups")}
			</EmptyState>
		);

	const columns = runColumns(data);
	return (
		<div className="grid gap-8">
			<Panel title="Policies" actions={add("Add policy", "outline")}>
				<ul className="divide-y">
					{data.policies.map((p) => (
						<PolicyRow key={p.id} policy={p} data={data} />
					))}
				</ul>
			</Panel>
			<Panel
				title="Recent runs"
				actions={
					<span className="text-xs text-muted-foreground">
						Backups, verifies and restores, newest first
					</span>
				}
			>
				<DataTable
					label="Recent backup runs"
					columns={columns}
					data={data.runs}
					getRowId={(r) => r.id}
					empty={
						<span className="text-sm text-muted-foreground">
							The first run starts on schedule, or press Run now.
						</span>
					}
				/>
			</Panel>
		</div>
	);
}
