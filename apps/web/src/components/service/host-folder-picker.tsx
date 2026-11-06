import { isSensitiveHostPath } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import {
	ChevronRight,
	Folder,
	FolderOpen,
	FolderSymlink,
	Lock,
	ShieldAlert,
} from "lucide-react";
import { useState } from "react";
import { SkeletonRows } from "@/components/panel";
import {
	Breadcrumbs,
	join,
	parentOf,
} from "@/components/service/container-files";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { InputGroupButton } from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { hostDirsQuery, nodesQuery } from "@/lib/api/monitoring";

/**
 * Picks a bind mount source by browsing a node's directories, like a "choose folder" sheet.
 * Opens on `value` when it is an absolute path, on the node the service is pinned to.
 */
export function HostFolderPicker({
	value,
	pinnedHost,
	label,
	onPick,
}: {
	value: string;
	pinnedHost?: string;
	/** Names the trigger, e.g. "Browse host folders for mount 1". */
	label: string;
	onPick: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<InputGroupButton
					size="icon-xs"
					aria-label={label}
					title="Browse folders on the server"
				>
					<FolderOpen />
				</InputGroupButton>
			</DialogTrigger>
			<DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
				{open && (
					<Browser
						start={value.startsWith("/") ? value : "/"}
						pinnedHost={pinnedHost}
						onPick={(p) => {
							onPick(p);
							setOpen(false);
						}}
						onCancel={() => setOpen(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function Browser({
	start,
	pinnedHost,
	onPick,
	onCancel,
}: {
	start: string;
	pinnedHost?: string;
	onPick: (path: string) => void;
	onCancel: () => void;
}) {
	const { data: nodes = [] } = useQuery(nodesQuery);
	const [pickedNode, setPickedNode] = useState<string>();
	const [path, setPath] = useState(start);
	const node =
		nodes.find((n) => n.id === pickedNode) ??
		nodes.find((n) => n.hostname === pinnedHost) ??
		nodes.find((n) => n.leader) ??
		nodes[0];
	const listing = useQuery({
		...hostDirsQuery(node?.id ?? "", path),
		enabled: Boolean(node),
	});
	const data = listing.data;
	// Symlinks resolve on the node; the resolved path is where you are.
	const here = data?.path ?? path;
	const sensitive = isSensitiveHostPath(here);

	return (
		<>
			<DialogHeader className="gap-1 px-5 pt-5 pb-4">
				<DialogTitle>Choose a host folder</DialogTitle>
				<DialogDescription className="text-pretty">
					{pinnedHost
						? `Folders on ${pinnedHost}, the node this service is pinned to.`
						: "Pin the service to the node you browse here: a bind mount only exists on that node."}
				</DialogDescription>
			</DialogHeader>
			<div className="flex min-h-10 items-center gap-2 border-y bg-muted/30 px-3 py-1.5">
				{nodes.length > 1 && !pinnedHost && (
					<Select value={node?.id} onValueChange={setPickedNode}>
						<SelectTrigger
							size="sm"
							aria-label="Node"
							className="w-auto max-w-40 shrink-0"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{nodes.map((n) => (
								<SelectItem key={n.id} value={n.id}>
									{n.hostname}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				<Breadcrumbs path={here} onOpen={setPath} />
			</div>
			<div className="h-[min(20rem,calc(100dvh-15rem))] overflow-y-auto overscroll-contain">
				{!node || listing.isPending ? (
					<SkeletonRows rows={7} />
				) : listing.isError ? (
					<ListingError
						error={listing.error}
						atRoot={path === "/"}
						onUp={() => setPath(parentOf(path))}
						onRetry={() => listing.refetch()}
					/>
				) : !data?.entries?.length ? (
					<p className="px-4 py-12 text-center text-sm text-muted-foreground">
						No folders inside {here}.
					</p>
				) : (
					<ul aria-label={`Folders in ${here}`} className="grid p-1.5">
						{data.entries.map((e) => {
							const to = join(here, e.name);
							const Icon = e.type === "symlink" ? FolderSymlink : Folder;
							return (
								<li key={e.name}>
									<button
										type="button"
										onClick={() => setPath(to)}
										className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-(--duration-quick) hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
									>
										<Icon
											className="size-4 shrink-0 text-brand"
											strokeWidth={1.75}
											aria-hidden
										/>
										<span className="truncate font-mono text-xs" title={to}>
											{e.name}
										</span>
										{e.linkTarget && (
											<span className="truncate font-mono text-xs text-muted-foreground">
												→ {e.linkTarget}
											</span>
										)}
										{isSensitiveHostPath(to) && (
											<ShieldAlert
												className="size-3.5 shrink-0 text-bad-text"
												aria-label="Sensitive path"
											/>
										)}
										<ChevronRight
											className="ml-auto size-4 shrink-0 text-muted-foreground/60 transition-colors duration-(--duration-quick) group-hover:text-foreground"
											aria-hidden
										/>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
			{data?.truncated && (
				<p className="border-t px-5 py-2 text-xs text-muted-foreground">
					Showing the first 1,000 folders.
				</p>
			)}
			<DialogFooter className="m-0 items-center px-5 py-3 sm:justify-between">
				<p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
					{sensitive && (
						<ShieldAlert
							className="size-3.5 shrink-0 text-bad-text"
							aria-hidden
						/>
					)}
					<span className="truncate">
						{sensitive
							? "Sensitive: an admin must confirm it."
							: "Read-only view of the server."}
					</span>
				</p>
				<div className="flex shrink-0 gap-2">
					<Button variant="ghost" size="sm" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						size="sm"
						disabled={!data || listing.isError}
						onClick={() => onPick(here)}
					>
						Choose <span className="max-w-48 truncate font-mono">{here}</span>
					</Button>
				</div>
			</DialogFooter>
		</>
	);
}

function ListingError({
	error,
	atRoot,
	onUp,
	onRetry,
}: {
	error: unknown;
	atRoot: boolean;
	onUp: () => void;
	onRetry: () => void;
}) {
	if (error instanceof ApiError && error.status === 403)
		return (
			<div className="grid justify-items-center gap-2 px-6 py-12 text-center">
				<Lock className="size-5 text-muted-foreground" aria-hidden />
				<p className="text-sm font-medium">Only admins can browse the server</p>
				<p className="max-w-[44ch] text-pretty text-xs text-muted-foreground">
					Bind mounts reach the host, so saving and browsing them is limited to
					admins. You can still type a path.
				</p>
			</div>
		);
	return (
		<div className="grid justify-items-center gap-3 px-4 py-12 text-center">
			<p role="alert" className="text-sm text-bad-text">
				{error instanceof Error ? error.message : "Something went wrong."}
			</p>
			<Button variant="outline" size="sm" onClick={atRoot ? onRetry : onUp}>
				{atRoot ? "Try again" : "Go up"}
			</Button>
		</div>
	);
}
