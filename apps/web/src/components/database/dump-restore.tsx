import type { DatabaseEngine } from "@logistack/contracts";
import {
	ChevronDown,
	CircleAlert,
	CircleCheck,
	DatabaseBackup,
	Download,
	FileUp,
	Loader2,
	Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/adapter";
import {
	databaseApi,
	type RestoreHandle,
	reasonOf,
	useRestore,
} from "@/lib/api/database";
import { formatBytes } from "@/lib/metrics";

/** What each engine's dump is, in the words its users know. */
const FORMAT: Record<DatabaseEngine, { ext: string; tool: string }> = {
	postgres: { ext: ".dump", tool: "pg_dump custom format" },
	mysql: { ext: ".sql", tool: "mysqldump, all databases" },
	mariadb: { ext: ".sql", tool: "mariadb-dump, all databases" },
	mongo: { ext: ".archive", tool: "mongodump archive" },
	redis: { ext: ".rdb", tool: "RDB snapshot" },
	libsql: { ext: ".sql", tool: "SQL dump from sqld" },
};

const errorText = (e: unknown) =>
	e instanceof Error ? e.message : "Something went wrong.";

/**
 * The Database tab's dump and restore menu. Permissions are learned from the api's 403s, like
 * the rest of the explorer: a refused action stays visible, disabled, with the grant it needs.
 */
export function DumpRestore({
	serviceId,
	name,
	engine,
}: {
	serviceId: string;
	name: string;
	engine: DatabaseEngine;
}) {
	const [dumping, setDumping] = useState(false);
	const [dumpForbidden, setDumpForbidden] = useState(false);
	const [restoreForbidden, setRestoreForbidden] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const format = FORMAT[engine];

	const download = async () => {
		setDumping(true);
		try {
			await databaseApi.dump(serviceId);
			toast.success(`Downloading a dump of ${name}`, {
				description: `${format.ext} file, ${format.tool}. It streams straight to your downloads.`,
			});
		} catch (e) {
			if (e instanceof ApiError && e.status === 403) setDumpForbidden(true);
			toast.error("Couldn't start the dump", { description: errorText(e) });
		} finally {
			setDumping(false);
		}
	};

	const restoreBlocked =
		engine === "redis" || engine === "libsql"
			? `${engine === "redis" ? "Redis" : "libSQL"} restores go through a volume backup`
			: restoreForbidden
				? "Needs admin on this service"
				: null;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="sm">
						{dumping ? (
							<Loader2 className="animate-spin" data-icon="inline-start" />
						) : (
							<DatabaseBackup data-icon="inline-start" />
						)}
						Dump & restore
						<ChevronDown data-icon="inline-end" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-64">
					<DropdownMenuItem
						disabled={dumpForbidden || dumping}
						onSelect={() => void download()}
						className="items-start"
					>
						<Download className="mt-0.5" />
						<span className="grid gap-0.5">
							Download dump
							<span className="text-xs text-muted-foreground">
								{dumpForbidden
									? "Needs read:secrets on this service"
									: `${format.ext}, ${format.tool}`}
							</span>
						</span>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={restoreBlocked !== null}
						onSelect={() => setRestoring(true)}
						className="items-start"
					>
						<Upload className="mt-0.5" />
						<span className="grid gap-0.5">
							Restore from file…
							<span className="text-xs text-muted-foreground">
								{restoreBlocked ?? "Replaces everything the database holds"}
							</span>
						</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{restoring && (
				<RestoreDialog
					serviceId={serviceId}
					name={name}
					engine={engine}
					onForbidden={() => setRestoreForbidden(true)}
					onClose={() => setRestoring(false)}
				/>
			)}
		</>
	);
}

type Phase =
	| { kind: "choose" }
	| { kind: "uploading"; loaded: number }
	| { kind: "done"; bytes: number }
	| { kind: "failed"; error: unknown };

function RestoreDialog({
	serviceId,
	name,
	engine,
	onForbidden,
	onClose,
}: {
	serviceId: string;
	name: string;
	engine: DatabaseEngine;
	onForbidden: () => void;
	onClose: () => void;
}) {
	const restore = useRestore(serviceId);
	const [file, setFile] = useState<File | null>(null);
	const [confirm, setConfirm] = useState("");
	const [phase, setPhase] = useState<Phase>({ kind: "choose" });
	const handle = useRef<RestoreHandle | null>(null);
	const picker = useRef<HTMLInputElement>(null);
	const busy = phase.kind === "uploading";
	const ready = file !== null && confirm === name && !busy;

	const start = () => {
		if (!file) return;
		setPhase({ kind: "uploading", loaded: 0 });
		const h = restore(file, (loaded) =>
			setPhase({ kind: "uploading", loaded }),
		);
		handle.current = h;
		h.done.then(
			({ bytes }) => setPhase({ kind: "done", bytes }),
			(error) => {
				if (error instanceof DOMException && error.name === "AbortError")
					return setPhase({ kind: "choose" });
				if (error instanceof ApiError && error.status === 403) onForbidden();
				setPhase({ kind: "failed", error });
			},
		);
	};
	const close = () => {
		handle.current?.abort();
		onClose();
	};

	return (
		<Dialog open onOpenChange={(open) => !open && !busy && close()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Restore {name} from a file</DialogTitle>
					<DialogDescription>
						Everything {name} holds is replaced by the file's contents. This
						can't be undone, so download a dump first if you might need the
						current data.
					</DialogDescription>
				</DialogHeader>

				{phase.kind === "done" ? (
					<div className="t-reveal flex items-start gap-3 rounded-lg bg-muted/60 p-4">
						<CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-text" />
						<p className="text-sm">
							Restored {formatBytes(phase.bytes)} into{" "}
							<span className="font-medium">{name}</span>. The explorer shows
							the new data.
						</p>
					</div>
				) : (
					<div className="grid gap-4">
						<input
							ref={picker}
							type="file"
							accept={FORMAT[engine].ext}
							className="sr-only"
							tabIndex={-1}
							onChange={(e) => {
								setFile(e.target.files?.[0] ?? null);
								if (phase.kind === "failed") setPhase({ kind: "choose" });
							}}
						/>
						<button
							type="button"
							disabled={busy}
							onClick={() => picker.current?.click()}
							className="flex items-center gap-3 rounded-lg px-4 py-3 text-left ring-1 ring-border transition-[background-color,box-shadow] duration-150 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
						>
							<FileUp className="size-4 shrink-0 text-muted-foreground" />
							<span className="grid min-w-0 flex-1 gap-0.5">
								<span className="truncate text-sm font-medium">
									{file ? file.name : "Choose a dump file"}
								</span>
								<span className="text-xs text-muted-foreground tabular">
									{file
										? formatBytes(file.size)
										: `A ${FORMAT[engine].ext} file from Download dump, or the engine's own tool`}
								</span>
							</span>
							<span className="text-xs text-muted-foreground">
								{file ? "Change" : "Browse"}
							</span>
						</button>

						{busy && file ? (
							<Progress loaded={phase.loaded} total={file.size} />
						) : (
							<Field id="restore-confirm" label={`Type ${name} to confirm`}>
								<Input
									id="restore-confirm"
									value={confirm}
									onChange={(e) => setConfirm(e.target.value)}
									onKeyDown={(e) => e.key === "Enter" && ready && start()}
									placeholder={name}
									autoCapitalize="none"
									spellCheck={false}
									autoComplete="off"
									className="font-mono"
								/>
							</Field>
						)}

						{phase.kind === "failed" && <Failure error={phase.error} />}
					</div>
				)}

				<DialogFooter>
					{phase.kind === "done" ? (
						<Button onClick={onClose}>Done</Button>
					) : (
						<>
							<Button variant="ghost" onClick={close}>
								{busy ? "Stop upload" : "Cancel"}
							</Button>
							<Button variant="destructive" disabled={!ready} onClick={start}>
								{busy && <Loader2 className="animate-spin" />}
								{busy
									? "Restoring"
									: phase.kind === "failed"
										? "Try again"
										: `Replace ${name}`}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Progress({ loaded, total }: { loaded: number; total: number }) {
	const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 100;
	return (
		<div className="grid gap-2" aria-live="polite">
			<div
				role="progressbar"
				aria-label="Upload"
				aria-valuenow={pct}
				aria-valuemin={0}
				aria-valuemax={100}
				className="h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div
					className="h-full rounded-full bg-foreground transition-[width] duration-150 ease-out"
					style={{ width: `${pct}%` }}
				/>
			</div>
			<p className="flex justify-between text-xs text-muted-foreground tabular">
				<span>
					{pct < 100
						? `${formatBytes(loaded)} of ${formatBytes(total)}`
						: "Uploaded; waiting for the restore tool to finish"}
				</span>
				<span>{pct}%</span>
			</p>
		</div>
	);
}

function Failure({ error }: { error: unknown }) {
	const details =
		error instanceof ApiError && reasonOf(error) === "tool_failed"
			? (error.details as { exitCode: number | null; stderr: string })
			: null;
	return (
		<div
			role="alert"
			className="t-reveal grid gap-2 rounded-lg p-4 ring-1 ring-bad/30"
		>
			<p className="flex items-start gap-2 text-sm">
				<CircleAlert className="mt-0.5 size-4 shrink-0 text-bad-text" />
				<span>
					{details
						? `The restore tool stopped with exit code ${details.exitCode}. The database may hold part of the file; restore again from a good dump.`
						: errorText(error)}
				</span>
			</p>
			{details?.stderr && (
				<pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-3 text-xs whitespace-pre-wrap">
					{details.stderr}
				</pre>
			)}
		</div>
	);
}
