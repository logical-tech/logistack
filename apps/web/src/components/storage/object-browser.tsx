import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
	ChevronRight,
	Database,
	Download,
	Folder,
	FolderPlus,
	Globe,
	Link2,
	Loader2,
	MoreHorizontal,
	Pencil,
	Plus,
	Settings2,
	Trash2,
	Upload as UploadIcon,
} from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	type Bucket,
	bucketsQuery,
	objectsQuery,
	type StorageCapabilities,
	storageApi,
	useStorageMutation,
} from "@/lib/api/storage";
import { relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";
import { cn } from "@/lib/utils";
import { BucketSettingsDialog, CreateBucketDialog } from "./bucket-dialogs";
import {
	download,
	errorText,
	NewFolderDialog,
	ObjectSheet,
	RenameDialog,
	ShareDialog,
} from "./object-actions";
import { baseName, fileKind } from "./objects";
import { UploadTray, useUploads } from "./uploads";

type Target = { bucket: string; key: string };

function BucketMeta({ b }: { b: Bucket }) {
	if (b.size === null) return null;
	return (
		<span className="block truncate text-xs text-muted-foreground tabular">
			{b.objects?.toLocaleString("en")} objects · {formatBytes(b.size)}
		</span>
	);
}

function BucketList({
	buckets,
	selected,
	onSelect,
	onSettings,
	onCreate,
}: {
	buckets: Bucket[];
	selected: string | undefined;
	onSelect: (name: string) => void;
	onSettings: (name: string) => void;
	onCreate: () => void;
}) {
	return (
		<nav
			aria-label="Buckets"
			className="hidden w-60 shrink-0 flex-col border-r md:flex"
		>
			<div className="flex h-12 items-center justify-between border-b pr-2 pl-4">
				<h2 className="text-sm font-semibold [font-stretch:100%]">Buckets</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={onCreate}
					aria-label="New bucket"
				>
					<Plus />
				</Button>
			</div>
			<ul className="grid gap-px p-1.5">
				{buckets.map((b) => {
					const active = b.name === selected;
					return (
						<li key={b.name} className="group/bucket relative">
							<button
								type="button"
								onClick={() => onSelect(b.name)}
								aria-current={active ? "true" : undefined}
								className={cn(
									"grid w-full gap-0.5 rounded-md py-2 pr-9 pl-2.5 text-left outline-none transition-colors duration-(--duration-quick) focus-visible:ring-2 focus-visible:ring-ring",
									active ? "bg-muted" : "hover:bg-muted/60",
								)}
							>
								<span className="flex min-w-0 items-center gap-1.5">
									<span
										className={cn(
											"truncate font-mono text-[13px]",
											active ? "font-medium" : "text-foreground/85",
										)}
									>
										{b.name}
									</span>
									{b.access === "public-read" && (
										<Globe
											className="size-3 shrink-0 text-warn-text"
											aria-label="Public read"
										/>
									)}
								</span>
								<BucketMeta b={b} />
							</button>
							<Button
								variant="ghost"
								size="icon-xs"
								onClick={() => onSettings(b.name)}
								aria-label={`Settings for ${b.name}`}
								className={cn(
									"absolute top-2 right-1.5 text-muted-foreground",
									!active &&
										"opacity-0 group-hover/bucket:opacity-100 focus-visible:opacity-100",
								)}
							>
								<Settings2 />
							</Button>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

function Crumbs({
	bucket,
	prefix,
	onGo,
}: {
	bucket: string;
	prefix: string;
	onGo: (prefix: string) => void;
}) {
	const parts = prefix.split("/").filter(Boolean);
	return (
		<nav aria-label="Folder" className="min-w-0">
			<ol className="flex min-w-0 items-center gap-0.5 text-sm">
				<li className="min-w-0 max-w-32 shrink sm:max-w-none">
					<button
						type="button"
						onClick={() => onGo("")}
						className={cn(
							"block max-w-full truncate rounded px-1 font-mono text-[13px] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
							parts.length ? "text-muted-foreground" : "font-medium",
						)}
						aria-current={parts.length ? undefined : "page"}
					>
						{bucket}
					</button>
				</li>
				{parts.map((p, i) => {
					const to = `${parts.slice(0, i + 1).join("/")}/`;
					const last = i === parts.length - 1;
					return (
						<li
							key={to}
							className={cn(
								"flex min-w-0 items-center gap-0.5",
								last && "shrink-0 max-w-[60%]",
							)}
						>
							<ChevronRight
								className="size-3.5 shrink-0 text-muted-foreground/60"
								aria-hidden
							/>
							<button
								type="button"
								onClick={() => onGo(to)}
								aria-current={last ? "page" : undefined}
								className={cn(
									"min-w-0 truncate rounded px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
									last ? "font-medium" : "text-muted-foreground",
								)}
							>
								{p}
							</button>
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

type Row =
	| { kind: "folder"; key: string }
	| {
			kind: "object";
			key: string;
			size: number;
			lastModified: string;
	  };

function RowMenu({
	row,
	onShare,
	onRename,
	onDelete,
	onDownload,
}: {
	row: Row;
	onShare: () => void;
	onRename: () => void;
	onDelete: () => void;
	onDownload: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Actions for ${baseName(row.key)}`}
					className="text-muted-foreground"
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-44">
				{row.kind === "object" && (
					<>
						<DropdownMenuItem onSelect={onDownload}>
							<Download />
							Download
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={onShare}>
							<Link2 />
							Share link
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={onRename}>
							<Pencil />
							Rename
						</DropdownMenuItem>
						<DropdownMenuSeparator />
					</>
				)}
				<DropdownMenuItem variant="destructive" onSelect={onDelete}>
					<Trash2 />
					{row.kind === "folder" ? "Delete folder" : "Delete"}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Buckets on the left, one folder level on the right; drop files anywhere on it to upload. */
export function ObjectBrowser({
	serviceId,
	capabilities,
	engineLabel,
	hasPublicEndpoint,
	bucket: requested,
	prefix,
	onNavigate,
}: {
	serviceId: string;
	capabilities: StorageCapabilities | undefined;
	engineLabel: string;
	hasPublicEndpoint: boolean;
	bucket: string | undefined;
	prefix: string;
	onNavigate: (bucket: string | undefined, prefix: string) => void;
}) {
	const buckets = useQuery(bucketsQuery(serviceId));
	const list = buckets.data ?? [];
	const bucket = list.find((b) => b.name === requested)?.name ?? list[0]?.name;
	const objects = useInfiniteQuery({
		...objectsQuery(serviceId, bucket ?? "", prefix),
		enabled: !!bucket,
	});
	const { uploads, add, cancel, clear } = useUploads(serviceId);

	const [creating, setCreating] = useState(false);
	const [settingsFor, setSettingsFor] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [open, setOpen] = useState<Target | null>(null);
	const [sharing, setSharing] = useState<Target | null>(null);
	const [renaming, setRenaming] = useState<Target | null>(null);
	const [makingFolder, setMakingFolder] = useState(false);
	const [deleting, setDeleting] = useState<string[] | null>(null);
	const [dragging, setDragging] = useState(false);
	const drag = useRef(0);
	const picker = useRef<HTMLInputElement>(null);

	// A new folder is a new selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on location change only
	useEffect(() => setSelected(new Set()), [bucket, prefix]);

	const remove = useStorageMutation(serviceId, (keys: string[]) =>
		storageApi.objects.remove(serviceId, bucket ?? "", keys),
	);

	const rows: Row[] = (objects.data?.pages ?? []).flatMap((p) => [
		...p.folders.map((key): Row => ({ kind: "folder", key })),
		...p.objects.map((o): Row => ({ kind: "object", ...o })),
	]);
	const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.key));
	const go = (p: string) => onNavigate(bucket, p);
	const toggle = (key: string, on: boolean) =>
		setSelected((s) => {
			const n = new Set(s);
			if (on) n.add(key);
			else n.delete(key);
			return n;
		});

	const onFiles = (files: File[]) => {
		if (!bucket || !files.length) return;
		add(bucket, prefix, files);
	};
	const dragProps = bucket
		? {
				onDragEnter: (e: DragEvent) => {
					if (!e.dataTransfer.types.includes("Files")) return;
					e.preventDefault();
					drag.current += 1;
					setDragging(true);
				},
				onDragOver: (e: DragEvent) => {
					if (e.dataTransfer.types.includes("Files")) e.preventDefault();
				},
				onDragLeave: () => {
					drag.current -= 1;
					if (drag.current <= 0) setDragging(false);
				},
				onDrop: (e: DragEvent) => {
					e.preventDefault();
					drag.current = 0;
					setDragging(false);
					onFiles([...e.dataTransfer.files]);
				},
			}
		: {};

	if (buckets.isPending)
		return (
			<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				<SkeletonRows rows={7} />
			</div>
		);
	if (buckets.isError)
		return (
			<EmptyState
				icon={Database}
				title="Couldn't list buckets"
				description={errorText(buckets.error)}
			>
				<Button variant="outline" onClick={() => buckets.refetch()}>
					Try again
				</Button>
			</EmptyState>
		);

	const createDialog = (
		<CreateBucketDialog
			serviceId={serviceId}
			open={creating}
			onOpenChange={setCreating}
			onCreated={(name) => onNavigate(name, "")}
		/>
	);
	if (!list.length)
		return (
			<>
				<EmptyState
					icon={Database}
					title="No buckets yet"
					description="A bucket holds objects under one name, like product-images or backups. Create one, then drop files on it."
				>
					<Button onClick={() => setCreating(true)}>
						<Plus data-icon="inline-start" />
						New bucket
					</Button>
				</EmptyState>
				{createDialog}
			</>
		);

	const count = selected.size;

	return (
		<>
			<div className="flex min-h-[32rem] overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				<BucketList
					buckets={list}
					selected={bucket}
					onSelect={(name) => onNavigate(name, "")}
					onSettings={setSettingsFor}
					onCreate={() => setCreating(true)}
				/>
				<section
					aria-label={bucket ? `Objects in ${bucket}` : "Objects"}
					className="relative flex min-w-0 flex-1 flex-col"
					{...dragProps}
				>
					<div className="flex items-center gap-2 border-b px-3 md:hidden">
						<Select
							value={bucket}
							onValueChange={(name) => onNavigate(name, "")}
						>
							<SelectTrigger
								className="my-2 min-w-0 flex-1 font-mono"
								aria-label="Bucket"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{list.map((b) => (
									<SelectItem key={b.name} value={b.name} className="font-mono">
										{b.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							variant="ghost"
							size="icon"
							aria-label={`Settings for ${bucket}`}
							onClick={() => bucket && setSettingsFor(bucket)}
						>
							<Settings2 />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							aria-label="New bucket"
							onClick={() => setCreating(true)}
						>
							<Plus />
						</Button>
					</div>
					<div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 sm:px-4">
						{count > 0 ? (
							<div className="t-swap flex min-w-0 flex-1 items-center gap-2">
								<span
									className="text-sm font-medium tabular"
									aria-live="polite"
								>
									{count} selected
								</span>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setSelected(new Set())}
								>
									Clear
								</Button>
							</div>
						) : (
							<div className="min-w-0 flex-1">
								{bucket && <Crumbs bucket={bucket} prefix={prefix} onGo={go} />}
							</div>
						)}
						{count > 0 ? (
							<Button
								size="sm"
								variant="destructive"
								onClick={() => setDeleting([...selected])}
							>
								<Trash2 data-icon="inline-start" />
								Delete {count}
							</Button>
						) : (
							<>
								<Button
									size="sm"
									variant="outline"
									disabled={!bucket}
									onClick={() => setMakingFolder(true)}
								>
									<FolderPlus data-icon="inline-start" />
									New folder
								</Button>
								<Button size="sm" onClick={() => picker.current?.click()}>
									<UploadIcon data-icon="inline-start" />
									Upload
								</Button>
							</>
						)}
						<input
							ref={picker}
							type="file"
							multiple
							hidden
							onChange={(e) => {
								onFiles([...(e.target.files ?? [])]);
								e.target.value = "";
							}}
						/>
					</div>

					{objects.isPending ? (
						<SkeletonRows rows={6} />
					) : objects.isError ? (
						<p
							role="alert"
							className="px-4 py-10 text-center text-sm text-bad-text"
						>
							{errorText(objects.error)}
						</p>
					) : !rows.length ? (
						<div className="grid flex-1 place-items-center px-6 py-14 text-center">
							<div className="t-reveal grid justify-items-center gap-1.5">
								<span className="mb-2 grid size-11 place-items-center rounded-lg bg-muted text-muted-foreground">
									<UploadIcon
										className="size-5"
										strokeWidth={1.75}
										aria-hidden
									/>
								</span>
								<p className="text-md font-semibold">
									{prefix ? "This folder is empty" : `${bucket} is empty`}
								</p>
								<p className="max-w-[40ch] text-sm text-muted-foreground">
									Drop files here, or choose them with Upload. They stream
									through LogiStack, so the bucket stays private.
								</p>
							</div>
						</div>
					) : (
						<div className="flex-1">
							<table className="w-full table-fixed text-sm">
								<caption className="sr-only">
									{prefix || bucket}: folders and objects
								</caption>
								<thead>
									<tr className="border-b">
										<th scope="col" className="w-10 pl-4">
											<Checkbox
												checked={
													allSelected
														? true
														: count > 0
															? "indeterminate"
															: false
												}
												onCheckedChange={(c) =>
													setSelected(
														c === true
															? new Set(rows.map((r) => r.key))
															: new Set(),
													)
												}
												aria-label="Select all"
											/>
										</th>
										<th
											scope="col"
											className="h-9 px-2 text-left text-xs font-medium text-muted-foreground"
										>
											Name
										</th>
										<th
											scope="col"
											className="hidden h-9 w-24 px-2 text-left text-xs font-medium text-muted-foreground lg:table-cell"
										>
											Type
										</th>
										<th
											scope="col"
											className="h-9 w-20 px-2 text-right text-xs font-medium text-muted-foreground sm:w-24"
										>
											Size
										</th>
										<th
											scope="col"
											className="hidden h-9 w-32 px-2 text-left text-xs font-medium text-muted-foreground sm:table-cell"
										>
											Modified
										</th>
										<th scope="col" className="w-12 pr-2">
											<span className="sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((r) => {
										const name = baseName(r.key);
										const kind = r.kind === "object" ? fileKind(r.key) : null;
										const Icon = kind?.icon ?? Folder;
										const isSel = selected.has(r.key);
										return (
											<tr
												key={r.key}
												data-selected={isSel || undefined}
												className="group/row border-b transition-colors duration-(--duration-quick) last:border-0 hover:bg-muted/50 data-selected:bg-muted/70"
											>
												<td className="pl-4">
													<Checkbox
														checked={isSel}
														onCheckedChange={(c) => toggle(r.key, c === true)}
														aria-label={`Select ${name}`}
													/>
												</td>
												<td className="h-11 px-2">
													<button
														type="button"
														onClick={() =>
															r.kind === "folder"
																? go(r.key)
																: bucket && setOpen({ bucket, key: r.key })
														}
														className="flex max-w-full items-center gap-2.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
													>
														<Icon
															className={cn(
																"size-4 shrink-0",
																r.kind === "folder"
																	? "fill-muted-foreground/15 text-muted-foreground"
																	: "text-muted-foreground",
															)}
															strokeWidth={1.75}
															aria-hidden
														/>
														<span
															className="line-clamp-2 decoration-muted-foreground/40 [overflow-wrap:anywhere] group-hover/row:underline sm:line-clamp-1"
															title={r.key}
														>
															{name}
															{r.kind === "folder" && (
																<span className="text-muted-foreground">/</span>
															)}
														</span>
													</button>
												</td>
												<td className="hidden px-2 text-muted-foreground lg:table-cell">
													{kind?.label ?? "Folder"}
												</td>
												<td className="px-2 text-right text-muted-foreground tabular">
													{r.kind === "object" ? formatBytes(r.size) : "–"}
												</td>
												<td className="hidden truncate px-2 text-muted-foreground sm:table-cell">
													{r.kind === "object" ? (
														<time
															dateTime={r.lastModified}
															title={new Date(r.lastModified).toLocaleString(
																"en-GB",
															)}
														>
															{relativeTime(r.lastModified)}
														</time>
													) : null}
												</td>
												<td className="pr-2 text-right">
													<RowMenu
														row={r}
														onDownload={() =>
															bucket && download(serviceId, bucket, r.key)
														}
														onShare={() =>
															bucket && setSharing({ bucket, key: r.key })
														}
														onRename={() =>
															bucket && setRenaming({ bucket, key: r.key })
														}
														onDelete={() => setDeleting([r.key])}
													/>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
							{objects.hasNextPage && (
								<div className="flex items-center justify-center gap-3 border-t px-4 py-3">
									<span className="text-xs text-muted-foreground tabular">
										Showing {rows.length.toLocaleString("en")}
									</span>
									<Button
										variant="outline"
										size="sm"
										onClick={() => objects.fetchNextPage()}
										disabled={objects.isFetchingNextPage}
									>
										{objects.isFetchingNextPage && (
											<Loader2 className="animate-spin" />
										)}
										Load more
									</Button>
								</div>
							)}
						</div>
					)}

					{dragging && (
						<div
							aria-hidden
							className="t-reveal pointer-events-none absolute inset-2 grid place-items-center rounded-lg bg-background/85 ring-2 ring-brand ring-dashed"
						>
							<p className="grid justify-items-center gap-2 text-center text-sm">
								<UploadIcon className="size-5 text-brand" aria-hidden />
								<span className="font-medium">Drop to upload</span>
								<span className="font-mono text-xs text-muted-foreground">
									{bucket}/{prefix}
								</span>
							</p>
						</div>
					)}
				</section>
			</div>

			{createDialog}
			<BucketSettingsDialog
				serviceId={serviceId}
				bucket={list.find((b) => b.name === settingsFor) ?? null}
				capabilities={capabilities}
				engineLabel={engineLabel}
				hasPublicEndpoint={hasPublicEndpoint}
				onClose={() => setSettingsFor(null)}
				onDeleted={() => {
					setSettingsFor(null);
					onNavigate(undefined, "");
				}}
			/>
			<ObjectSheet
				serviceId={serviceId}
				target={open}
				onClose={() => setOpen(null)}
				onShare={setSharing}
				onRename={setRenaming}
				onDelete={(t) => setDeleting([t.key])}
			/>
			<ShareDialog
				serviceId={serviceId}
				target={sharing}
				onClose={() => setSharing(null)}
			/>
			{bucket && (
				<NewFolderDialog
					serviceId={serviceId}
					bucket={bucket}
					prefix={prefix}
					open={makingFolder}
					onClose={() => setMakingFolder(false)}
				/>
			)}
			<RenameDialog
				serviceId={serviceId}
				target={renaming}
				onClose={() => setRenaming(null)}
				onRenamed={(t) => {
					setRenaming(null);
					if (open) setOpen(t);
				}}
			/>
			<ConfirmDialog
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={
					deleting?.length === 1
						? `Delete ${baseName(deleting[0] ?? "")}${deleting[0]?.endsWith("/") ? "/" : ""}?`
						: `Delete ${deleting?.length} items?`
				}
				description={
					deleting?.some((k) => k.endsWith("/"))
						? "Folders are deleted with everything inside them. This can't be undone."
						: "This can't be undone."
				}
				confirmLabel="Delete"
				pending={remove.isPending}
				onConfirm={() => {
					const keys = deleting ?? [];
					remove.mutate(keys, {
						onSuccess: () => {
							toast.success(
								keys.length === 1
									? `Deleted ${baseName(keys[0] ?? "")}`
									: `Deleted ${keys.length} items`,
							);
							setDeleting(null);
							setSelected(new Set());
							if (open && keys.includes(open.key)) setOpen(null);
						},
						onError: (e) =>
							toast.error("Couldn't delete", { description: errorText(e) }),
					});
				}}
			/>
			<UploadTray uploads={uploads} onCancel={cancel} onClear={clear} />
		</>
	);
}
