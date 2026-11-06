import { StreamLanguage } from "@codemirror/language";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	FileCode2,
	FolderUp,
	HardDrive,
	Rocket,
	Trash2,
	Upload as UploadIcon,
} from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ScriptEditor } from "@/components/backups/script-editor";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Panel, SkeletonRows } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { ContainerFiles } from "@/components/service/container-files";
import {
	LoadBalancerForm,
	targetSuggestions,
} from "@/components/service/load-balancer-form";
import { UploadTray, useUploads } from "@/components/storage/uploads";
import { Button } from "@/components/ui/button";
import {
	type ConfigFile,
	filesApi,
	filesQuery,
	type ServiceFiles as ServiceFilesData,
	useDeleteVolumeFile,
	useSaveConfig,
	volumeKey,
	volumeQuery,
} from "@/lib/api/files";
import type { ServiceOverview } from "@/lib/api/service-ops";
import { useServices } from "@/lib/api/services";
import type { EnvironmentId } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";
import { cn } from "@/lib/utils";
import {
	LB_DEFAULTS,
	type LbSettings,
	lbIssue,
	loadBalancerConfig,
	readLoadBalancer,
	WEBSERVERS,
	webserverKind,
} from "@/lib/webservers";

const languages = {
	nginx: StreamLanguage.define(nginx),
	shell: StreamLanguage.define(shell),
};

/** Matches the server's per-file cap. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const errorText = (e: unknown) =>
	e instanceof Error ? e.message : "Something went wrong.";

type Source = "volumes" | "container";

/**
 * The Files tab. Volumes: each config file in an editor, then each volume's files. Container:
 * the running replica's whole filesystem.
 */
export function ServiceFiles({
	service,
	projectId,
}: {
	service: ServiceOverview;
	projectId: string;
}) {
	const files = useQuery(filesQuery(service.id));
	const [picked, setPicked] = useState<Source | null>(null);
	const mounts = files.data
		? files.data.files.length + files.data.volumes.length
		: 1;
	const source = picked ?? (mounts ? "volumes" : "container");
	return (
		<div className="grid gap-6">
			<div>
				<Segmented
					label="Files from"
					value={source}
					onChange={setPicked}
					options={[
						{ value: "volumes", label: "Volumes" },
						{ value: "container", label: "Container" },
					]}
				/>
			</div>
			{source === "container" ? (
				<ContainerFiles serviceId={service.id} tasks={service.status.tasks} />
			) : (
				<MountFiles files={files} service={service} projectId={projectId} />
			)}
		</div>
	);
}

function MountFiles({
	files,
	service,
	projectId,
}: {
	files: UseQueryResult<ServiceFilesData>;
	service: ServiceOverview;
	projectId: string;
}) {
	if (files.isPending)
		return (
			<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				<SkeletonRows rows={6} />
			</div>
		);
	if (files.isError)
		return (
			<EmptyState
				icon={FileCode2}
				title="Couldn't load the files"
				description={errorText(files.error)}
			>
				<Button variant="outline" onClick={() => files.refetch()}>
					Try again
				</Button>
			</EmptyState>
		);
	const { files: configs, volumes } = files.data;
	if (!configs.length && !volumes.length)
		return (
			<EmptyState
				icon={FileCode2}
				title="No files"
				description="This service mounts no config files or volumes. Switch to Container to browse the running replica's filesystem."
			/>
		);
	return (
		<div className="grid gap-10">
			{configs.map((f) => (
				<ConfigEditor
					key={f.id}
					file={f}
					service={service}
					projectId={projectId}
				/>
			))}
			{volumes.map((v) => (
				<VolumeFiles
					key={v.id}
					serviceId={service.id}
					mountId={v.id}
					root={v.target}
					running={service.status.replicasRunning > 0}
				/>
			))}
		</div>
	);
}

function ConfigEditor({
	file,
	service,
	projectId,
}: {
	file: ConfigFile;
	service: ServiceOverview;
	projectId: string;
}) {
	const navigate = useNavigate();
	const kind = webserverKind(service.importedFrom);
	const def = kind ? WEBSERVERS[kind] : undefined;
	const isLb = kind === "haproxy";
	const [draft, setDraft] = useState(file.content);
	const [mode, setMode] = useState<"form" | "raw">(() =>
		isLb && readLoadBalancer(file.content) ? "form" : "raw",
	);
	const [lb, setLb] = useState<LbSettings>(
		() => readLoadBalancer(file.content) ?? LB_DEFAULTS,
	);
	const [tried, setTried] = useState(false);
	const save = useSaveConfig(service.id);
	const siblings = useServices(service.environmentId as EnvironmentId);

	// A save elsewhere (another tab, the API) replaces an untouched draft.
	const saved = useRef(file.content);
	useEffect(() => {
		setDraft((d) => (d === saved.current ? file.content : d));
		saved.current = file.content;
	}, [file.content]);

	const content = mode === "form" ? loadBalancerConfig(lb) : draft;
	const dirty = content !== file.content;
	const issue =
		mode === "form"
			? lbIssue(lb)
			: draft.trim()
				? undefined
				: "The file is empty. Write a config, or discard the changes.";
	const handEdited = isLb && !readLoadBalancer(file.content);

	const submit = () => {
		setTried(true);
		if (issue || !dirty || save.isPending) return;
		save.mutate(
			{ mountId: file.id, content },
			{
				onSuccess: ({ deployment }) => {
					setTried(false);
					setDraft(content);
					toast.success(`Deploying ${service.name}`, {
						description:
							"The new config rolls out with a fresh replica; Swarm rolls back if it fails to start.",
						action: {
							label: "Follow",
							onClick: () =>
								navigate({
									to: "/projects/$projectId/services/$serviceId/deployments",
									params: { projectId, serviceId: service.id },
									search: { d: deployment.id },
								}),
						},
					});
				},
				onError: (e) =>
					toast.error("Couldn't save", { description: errorText(e) }),
			},
		);
	};
	const discard = () => {
		setDraft(file.content);
		setLb(readLoadBalancer(file.content) ?? LB_DEFAULTS);
		setTried(false);
	};

	const id = `cfg-${file.id}`;
	return (
		<section
			aria-labelledby={`${id}-title`}
			className="grid gap-3"
			onKeyDown={(e) => {
				if ((e.metaKey || e.ctrlKey) && e.key === "s") {
					e.preventDefault();
					submit();
				}
			}}
		>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<h2 id={`${id}-title`} className="text-sm font-semibold">
						{isLb ? "Load balancer" : "Configuration"}
					</h2>
					<p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
						{file.target}
						<span className="font-sans">
							{" "}
							· saved {relativeTime(file.updatedAt)}
						</span>
					</p>
				</div>
				{isLb && (
					<Segmented
						label="Edit as"
						value={mode}
						onChange={(m) => {
							if (m === "raw") setDraft(content);
							setMode(m);
							setTried(false);
						}}
						options={[
							{ value: "form", label: "Form" },
							{ value: "raw", label: "Raw config" },
						]}
					/>
				)}
			</div>

			{mode === "form" ? (
				<div className="rounded-xl bg-card p-5 shadow-card ring-1 ring-border">
					{handEdited && (
						<p className="mb-5 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn-text">
							The saved config was edited by hand. Saving from the form replaces
							it with a generated one.
						</p>
					)}
					<LoadBalancerForm
						idPrefix={`${id}-`}
						value={lb}
						onChange={setLb}
						suggestions={targetSuggestions(siblings.data ?? [], service.id)}
						error={tried ? issue : undefined}
					/>
				</div>
			) : (
				<div className="grid gap-1.5">
					<ScriptEditor
						id={id}
						label={`Contents of ${file.target}`}
						value={draft}
						onChange={setDraft}
						language={languages[def?.syntax ?? "shell"]}
						hint=""
						invalid={tried && Boolean(issue)}
						describedBy={`${id}-msg`}
						className="h-[min(60vh,560px)] [&_.cm-editor]:h-full"
					/>
					<p
						id={`${id}-msg`}
						aria-live="polite"
						className={cn(
							"text-xs",
							tried && issue ? "text-bad-text" : "text-muted-foreground",
						)}
					>
						{tried && issue
							? issue
							: "Saving deploys the service with this file. A config the server rejects fails the deployment and the running replica stays."}
					</p>
				</div>
			)}

			<div className="flex items-center justify-end gap-2">
				{dirty && (
					<Button variant="ghost" onClick={discard} disabled={save.isPending}>
						Discard changes
					</Button>
				)}
				<Button
					onClick={submit}
					disabled={!dirty || save.isPending}
					title="Save and deploy (⌘S)"
				>
					<Rocket data-icon="inline-start" />
					{save.isPending ? "Saving…" : "Save and deploy"}
				</Button>
			</div>
		</section>
	);
}

type Picked = { file: File; path: string };

const readEntries = (r: FileSystemDirectoryReader) =>
	new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej));

/** Every file under a dropped entry, with its path from the drop. */
async function entryFiles(
	entry: FileSystemEntry,
	prefix = "",
): Promise<Picked[]> {
	if (entry.isFile) {
		const file = await new Promise<File>((res, rej) =>
			(entry as FileSystemFileEntry).file(res, rej),
		);
		return [{ file, path: prefix + entry.name }];
	}
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	const children: FileSystemEntry[] = [];
	// readEntries returns at most 100 at a time.
	for (let batch = await readEntries(reader); batch.length; ) {
		children.push(...batch);
		batch = await readEntries(reader);
	}
	const nested = await Promise.all(
		children.map((c) => entryFiles(c, `${prefix}${entry.name}/`)),
	);
	return nested.flat();
}

/** A single dropped or picked folder uploads its contents, not the folder itself. */
function stripSingleRoot(picked: Picked[]): Picked[] {
	const roots = new Set(picked.map((p) => p.path.split("/")[0]));
	if (roots.size !== 1 || picked.some((p) => !p.path.includes("/")))
		return picked;
	return picked.map((p) => ({
		...p,
		path: p.path.slice(p.path.indexOf("/") + 1),
	}));
}

function VolumeFiles({
	serviceId,
	mountId,
	root,
	running,
}: {
	serviceId: string;
	mountId: string;
	root: string;
	running: boolean;
}) {
	const listing = useQuery({
		...volumeQuery(serviceId, mountId),
		enabled: running,
	});
	const { uploads, add, cancel, clear } = useUploads(
		serviceId,
		filesApi.upload,
		volumeKey(serviceId, mountId),
	);
	const remove = useDeleteVolumeFile(serviceId, mountId);
	const [confirm, setConfirm] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);
	const depth = useRef(0);
	const filePicker = useRef<HTMLInputElement>(null);
	const folderPicker = useRef<HTMLInputElement>(null);

	const enqueue = (picked: Picked[]) => {
		const tooBig = picked.filter((p) => p.file.size > MAX_FILE_BYTES);
		if (tooBig.length)
			toast.error(
				`${tooBig.length === 1 ? (tooBig[0]?.path ?? "A file") : `${tooBig.length} files`} skipped`,
				{ description: "Files are limited to 50 MB each." },
			);
		// Grouped by folder, since the queue names each file by prefix + name.
		const byDir = new Map<string, File[]>();
		for (const p of picked) {
			if (p.file.size > MAX_FILE_BYTES) continue;
			const dir = p.path.slice(0, p.path.lastIndexOf("/") + 1);
			byDir.set(dir, [...(byDir.get(dir) ?? []), p.file]);
		}
		for (const [dir, files] of byDir) add(mountId, dir, files);
	};

	const onDrop = async (e: DragEvent) => {
		e.preventDefault();
		depth.current = 0;
		setDragging(false);
		const entries = [...e.dataTransfer.items]
			.map((i) => i.webkitGetAsEntry())
			.filter((x): x is FileSystemEntry => x !== null);
		const picked = entries.length
			? (await Promise.all(entries.map((en) => entryFiles(en)))).flat()
			: [...e.dataTransfer.files].map((file) => ({ file, path: file.name }));
		enqueue(stripSingleRoot(picked));
	};

	const files = listing.data?.files ?? [];
	const total = files.reduce((n, f) => n + f.size, 0);
	const titleId = `vol-${mountId}`;

	return (
		<Panel
			id={titleId}
			title={
				<>
					Static files{" "}
					<span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
						{root}
					</span>
				</>
			}
			actions={
				<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={!running}
						onClick={() => folderPicker.current?.click()}
					>
						<FolderUp data-icon="inline-start" />
						Upload folder
					</Button>
					<Button
						size="sm"
						disabled={!running}
						onClick={() => filePicker.current?.click()}
					>
						<UploadIcon data-icon="inline-start" />
						Upload files
					</Button>
					<input
						ref={filePicker}
						type="file"
						multiple
						hidden
						onChange={(e) => {
							enqueue(
								[...(e.target.files ?? [])].map((file) => ({
									file,
									path: file.name,
								})),
							);
							e.target.value = "";
						}}
					/>
					<input
						ref={folderPicker}
						type="file"
						hidden
						// @ts-expect-error: non-standard but supported by every current browser
						webkitdirectory=""
						onChange={(e) => {
							enqueue(
								stripSingleRoot(
									[...(e.target.files ?? [])].map((file) => ({
										file,
										path: file.webkitRelativePath || file.name,
									})),
								),
							);
							e.target.value = "";
						}}
					/>
				</div>
			}
			bodyClassName={cn(
				"relative transition-shadow duration-(--duration-quick)",
				dragging && "ring-2 ring-brand",
			)}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the upload buttons are the keyboard path */}
			<div
				onDragEnter={(e) => {
					if (!running || !e.dataTransfer.types.includes("Files")) return;
					e.preventDefault();
					depth.current += 1;
					setDragging(true);
				}}
				onDragOver={(e) => {
					if (running && e.dataTransfer.types.includes("Files"))
						e.preventDefault();
				}}
				onDragLeave={() => {
					depth.current -= 1;
					if (depth.current <= 0) setDragging(false);
				}}
				onDrop={(e) => {
					if (running) void onDrop(e);
				}}
			>
				{!running ? (
					<p className="px-4 py-10 text-center text-sm text-muted-foreground">
						Files show here once a replica is running; they are read and written
						through it.
					</p>
				) : listing.isPending ? (
					<SkeletonRows rows={5} />
				) : listing.isError ? (
					<div className="grid justify-items-center gap-3 px-4 py-10 text-center">
						<p role="alert" className="text-sm text-bad-text">
							{errorText(listing.error)}
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => listing.refetch()}
						>
							Try again
						</Button>
					</div>
				) : files.length === 0 ? (
					<div className="grid justify-items-center gap-2 px-4 py-14 text-center">
						<HardDrive
							className="size-5 text-muted-foreground"
							strokeWidth={1.75}
							aria-hidden
						/>
						<p className="text-sm font-medium">No files yet</p>
						<p className="max-w-[44ch] text-sm text-muted-foreground">
							Drop files or a build folder here. A dropped folder uploads what
							is inside it, and files are served as soon as they land.
						</p>
					</div>
				) : (
					<>
						<table className="w-full text-sm">
							<caption className="sr-only">Files in {root}</caption>
							<thead className="text-xs text-muted-foreground">
								<tr className="border-b">
									<th scope="col" className="px-4 py-2 text-left font-medium">
										Path
									</th>
									<th
										scope="col"
										className="px-4 py-2 text-right font-medium max-sm:hidden"
									>
										Size
									</th>
									<th
										scope="col"
										className="px-4 py-2 text-right font-medium max-md:hidden"
									>
										Modified
									</th>
									<th scope="col" className="w-12">
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody className="divide-y">
								{files.slice(0, 1000).map((f) => (
									<tr key={f.path} className="group hover:bg-muted/40">
										<td className="max-w-0 px-4 py-2">
											<span
												className="block truncate font-mono text-xs"
												title={f.path}
											>
												{f.path}
											</span>
										</td>
										<td className="px-4 py-2 text-right text-xs text-muted-foreground tabular max-sm:hidden">
											{formatBytes(f.size)}
										</td>
										<td className="px-4 py-2 text-right text-xs whitespace-nowrap text-muted-foreground max-md:hidden">
											{relativeTime(f.modifiedAt)}
										</td>
										<td className="px-2 py-1 text-right">
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={`Delete ${f.path}`}
												className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
												onClick={() => setConfirm(f.path)}
											>
												<Trash2 />
											</Button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
						<p className="border-t px-4 py-2 text-xs text-muted-foreground tabular">
							{files.length.toLocaleString()}{" "}
							{files.length === 1 ? "file" : "files"}, {formatBytes(total)}
							{files.length > 1000 && " · showing the first 1,000"}
							{listing.data.truncated && " · the listing was cut at 2 MB"}
						</p>
					</>
				)}
			</div>

			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(open) => !open && setConfirm(null)}
				title="Delete this file?"
				description={
					<>
						<span className="font-mono text-xs">{confirm}</span> is removed from
						the volume right away. There is no undo.
					</>
				}
				confirmLabel="Delete file"
				pending={remove.isPending}
				onConfirm={() =>
					confirm &&
					remove.mutate(confirm, {
						onSuccess: () => setConfirm(null),
						onError: (e) =>
							toast.error("Couldn't delete", { description: errorText(e) }),
					})
				}
			/>
			<UploadTray uploads={uploads} onCancel={cancel} onClear={clear} />
		</Panel>
	);
}
