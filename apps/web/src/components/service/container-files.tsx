import { useQuery } from "@tanstack/react-query";
import {
	Download,
	FileSymlink,
	FileText,
	Folder,
	Lock,
	Upload as UploadIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Panel, SkeletonRows } from "@/components/panel";
import { UploadTray, useUploads } from "@/components/storage/uploads";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import {
	type ContainerEntry,
	containerDownloadUrl,
	containerKey,
	containerListQuery,
	filesApi,
} from "@/lib/api/files";
import type { ServiceTask } from "@/lib/api/service-ops";
import { relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";

/** Matches the server's per-file cap. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const errorText = (e: unknown) =>
	e instanceof Error ? e.message : "Something went wrong.";
export const join = (dir: string, name: string) =>
	dir === "/" ? `/${name}` : `${dir}/${name}`;
export const parentOf = (path: string) =>
	path.slice(0, path.lastIndexOf("/")) || "/";
const modified = (s: number) => relativeTime(new Date(s * 1000).toISOString());

const ICONS = {
	dir: Folder,
	file: FileText,
	symlink: FileSymlink,
	other: FileText,
} as const;

/** Each ancestor of `path` as a button; the last one is where you are. */
export function Breadcrumbs({
	path,
	onOpen,
}: {
	path: string;
	onOpen: (p: string) => void;
}) {
	const parts = path.split("/").filter(Boolean);
	const crumbs = [
		{ label: "/", to: "/" },
		...parts.map((p, i) => ({
			label: p,
			to: `/${parts.slice(0, i + 1).join("/")}`,
		})),
	];
	return (
		<nav aria-label="Path" className="min-w-0">
			<ol className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-xs">
				{crumbs.map((c, i) => {
					const last = i === crumbs.length - 1;
					return (
						<li key={c.to} className="flex min-w-0 items-center gap-0.5">
							{i > 1 && (
								<span className="text-muted-foreground/60" aria-hidden>
									/
								</span>
							)}
							{last ? (
								<span
									aria-current="page"
									className="truncate px-1 py-0.5 font-medium text-foreground"
								>
									{c.label}
								</span>
							) : (
								<button
									type="button"
									onClick={() => onOpen(c.to)}
									className="truncate rounded px-1 py-0.5 text-muted-foreground transition-colors duration-(--duration-quick) hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
								>
									{c.label}
								</button>
							)}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

function FileView({
	serviceId,
	taskId,
	path,
	size,
}: {
	serviceId: string;
	taskId: string;
	path: string;
	size: number;
}) {
	const file = useQuery({
		queryKey: [...containerKey(serviceId, taskId), path, "content"],
		queryFn: () => filesApi.container.read(serviceId, taskId, path),
		retry: false,
	});
	const download = (
		<Button size="sm" variant="outline" asChild>
			<a href={containerDownloadUrl(serviceId, taskId, path)} download>
				<Download data-icon="inline-start" />
				Download
			</a>
		</Button>
	);
	if (file.isPending) return <SkeletonRows rows={6} />;
	if (file.isError)
		return (
			<p role="alert" className="px-4 py-10 text-center text-sm text-bad-text">
				{errorText(file.error)}
			</p>
		);
	const { content, binary, truncated } = file.data;
	return (
		<>
			<div className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
				<span className="tabular">{formatBytes(size)}</span>
				{truncated && <span>Showing the first 1 MB</span>}
				<span className="ml-auto">{size <= MAX_FILE_BYTES && download}</span>
			</div>
			{binary || content === null ? (
				<p className="px-4 py-12 text-center text-sm text-muted-foreground">
					This looks like a binary file, so it is not shown.
					{size <= MAX_FILE_BYTES ? " Download it instead." : ""}
				</p>
			) : (
				<section
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the file scrolls by keyboard
					tabIndex={0}
					aria-label={`Contents of ${path}`}
					className="max-h-[min(64vh,40rem)] overflow-auto bg-[var(--log-bg)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
				>
					<pre className="w-max min-w-full p-4 font-mono text-xs leading-relaxed text-[var(--log-fg)] [font-size-adjust:0.47] selection:bg-[var(--log-selection)]">
						{content || " "}
					</pre>
				</section>
			)}
		</>
	);
}

/**
 * A running replica's filesystem: browse, view text, download, upload into the current folder.
 * Read through the Docker archive API on the replica's node, so images without a shell work too.
 */
export function ContainerFiles({
	serviceId,
	tasks,
}: {
	serviceId: string;
	tasks: ServiceTask[];
}) {
	const running = tasks.filter((t) => t.state === "running");
	const [picked, setPicked] = useState("");
	const taskId = running.some((t) => t.id === picked) ? picked : "";
	const [path, setPath] = useState("/");
	const listing = useQuery({
		...containerListQuery(serviceId, taskId, path),
		enabled: running.length > 0,
	});
	const { uploads, add, cancel, clear } = useUploads(
		serviceId,
		filesApi.container.upload,
		containerKey(serviceId, taskId),
	);
	const picker = useRef<HTMLInputElement>(null);

	const data = listing.data;
	const isDir = data?.entries != null;
	// Symlinks resolve on the server; the resolved path is where you are.
	const here = data?.path ?? path;
	const dir = data && !isDir ? parentOf(here) : here;

	const enqueue = (files: File[]) => {
		const ok = files.filter((f) => f.size <= MAX_FILE_BYTES);
		if (ok.length < files.length)
			toast.error(`${files.length - ok.length} skipped`, {
				description: "Files are limited to 50 MB each.",
			});
		if (ok.length) add(taskId, dir === "/" ? "/" : `${dir}/`, ok);
	};

	if (listing.error instanceof ApiError && listing.error.status === 403)
		return (
			<EmptyState
				icon={Lock}
				title="Browsing the container needs the Terminal permission"
				description="Files are read and written by the Docker daemon as root, so this is as powerful as a shell and is granted the same way. An admin can add Terminal to your role for this service or a scope above it."
			/>
		);

	return (
		<Panel
			id="container-files"
			title="Filesystem"
			actions={
				<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
					{running.length > 1 && (
						<Select
							value={taskId || "auto"}
							onValueChange={(v) => {
								setPicked(v === "auto" ? "" : v);
							}}
						>
							<SelectTrigger
								size="sm"
								aria-label="Replica"
								className="w-auto min-w-36"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto">First running replica</SelectItem>
								{running.map((t) => (
									<SelectItem key={t.id} value={t.id}>
										Replica #{t.slot ?? "?"}
										{t.hostname && (
											<span className="text-muted-foreground">
												{" "}
												on {t.hostname}
											</span>
										)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<Button
						size="sm"
						disabled={!running.length || !data}
						onClick={() => picker.current?.click()}
					>
						<UploadIcon data-icon="inline-start" />
						Upload here
					</Button>
					<input
						ref={picker}
						type="file"
						multiple
						hidden
						onChange={(e) => {
							enqueue([...(e.target.files ?? [])]);
							e.target.value = "";
						}}
					/>
				</div>
			}
		>
			{!running.length ? (
				<p className="px-4 py-10 text-center text-sm text-muted-foreground">
					The container&apos;s files show here while a replica is running.
				</p>
			) : (
				<>
					<div className="flex min-h-10 items-center gap-2 border-b px-3 py-1.5">
						<Breadcrumbs path={here} onOpen={setPath} />
					</div>
					{listing.isPending ? (
						<SkeletonRows rows={6} />
					) : listing.isError ? (
						<div className="grid justify-items-center gap-3 px-4 py-10 text-center">
							<p role="alert" className="text-sm text-bad-text">
								{errorText(listing.error)}
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									path === "/" ? listing.refetch() : setPath(parentOf(path))
								}
							>
								{path === "/" ? "Try again" : "Go up"}
							</Button>
						</div>
					) : !data ? null : !isDir ? (
						<FileView
							key={`${taskId}:${here}`}
							serviceId={serviceId}
							taskId={taskId}
							path={here}
							size={data.entry.size}
						/>
					) : (
						<Listing
							entries={data.entries ?? []}
							truncated={data.truncated}
							dir={here}
							downloadUrl={(p) => containerDownloadUrl(serviceId, taskId, p)}
							onOpen={setPath}
						/>
					)}
				</>
			)}
			<UploadTray uploads={uploads} onCancel={cancel} onClear={clear} />
		</Panel>
	);
}

function Listing({
	entries,
	truncated,
	dir,
	downloadUrl,
	onOpen,
}: {
	entries: ContainerEntry[];
	truncated: boolean;
	dir: string;
	downloadUrl: (path: string) => string;
	onOpen: (path: string) => void;
}) {
	if (!entries.length)
		return (
			<p className="px-4 py-12 text-center text-sm text-muted-foreground">
				This folder is empty.
			</p>
		);
	return (
		<>
			<table className="w-full text-sm">
				<caption className="sr-only">Contents of {dir}</caption>
				<thead className="text-xs text-muted-foreground">
					<tr className="border-b">
						<th scope="col" className="px-4 py-2 text-left font-medium">
							Name
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
					{entries.map((e) => {
						const Icon = ICONS[e.type];
						const path = join(dir, e.name);
						return (
							<tr key={e.name} className="group hover:bg-muted/40">
								<td className="max-w-0 px-2 py-1">
									<button
										type="button"
										onClick={() => onOpen(path)}
										disabled={e.type === "other"}
										className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
									>
										<Icon
											className={
												e.type === "dir"
													? "size-4 shrink-0 text-brand"
													: "size-4 shrink-0 text-muted-foreground"
											}
											strokeWidth={1.75}
											aria-hidden
										/>
										<span className="truncate font-mono text-xs" title={e.name}>
											{e.name}
										</span>
										{e.linkTarget && (
											<span className="truncate font-mono text-xs text-muted-foreground">
												→ {e.linkTarget}
											</span>
										)}
										{e.type === "dir" && (
											<span className="sr-only">folder</span>
										)}
									</button>
								</td>
								<td className="px-4 py-2 text-right text-xs text-muted-foreground tabular max-sm:hidden">
									{e.type === "file" ? formatBytes(e.size) : ""}
								</td>
								<td className="px-4 py-2 text-right text-xs whitespace-nowrap text-muted-foreground max-md:hidden">
									{modified(e.modifiedAt)}
								</td>
								<td className="px-2 py-1 text-right">
									{e.type === "file" && e.size <= MAX_FILE_BYTES && (
										<Button
											variant="ghost"
											size="icon-sm"
											asChild
											className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
										>
											<a
												href={downloadUrl(path)}
												download
												aria-label={`Download ${e.name}`}
											>
												<Download />
											</a>
										</Button>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			<p className="border-t px-4 py-2 text-xs text-muted-foreground tabular">
				{entries.length.toLocaleString()}{" "}
				{entries.length === 1 ? "item" : "items"}
				{truncated &&
					" · the listing was cut short; open a subfolder to see more"}
			</p>
		</>
	);
}
