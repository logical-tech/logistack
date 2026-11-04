import { useQuery } from "@tanstack/react-query";
import { Eraser, RotateCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { diskQuery, usePruneNode } from "@/lib/api/monitoring";
import type { ClusterNode, DiskUsage } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { formatBytes } from "@/lib/metrics";
import { cn } from "@/lib/utils";

type Row = {
	key: string;
	label: string;
	detail: string;
	bytes: number;
	reclaimable: number;
};

// One ink in falling strength: the bar ranks the categories, colour stays for status.
const SHADES = [
	"bg-foreground/85",
	"bg-foreground/60",
	"bg-foreground/42",
	"bg-foreground/28",
	"bg-foreground/18",
	"bg-foreground/10",
];

const plural = (n: number, one: string) =>
	`${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;

/** Docker's categories, plus whatever else fills the filesystem holding the Docker root dir. */
export function diskRows(u: DiskUsage): Row[] {
	const rows: Row[] = [
		{
			key: "images",
			label: "Images",
			detail: plural(u.images.count, "image"),
			bytes: u.images.bytes,
			reclaimable: u.images.reclaimableBytes,
		},
		{
			key: "volumes",
			label: "Volumes",
			detail: `${plural(u.volumes.count, "volume")}, kept by cleanup`,
			bytes: u.volumes.bytes,
			reclaimable: 0,
		},
		{
			key: "buildCache",
			label: "Build cache",
			detail: plural(u.buildCache.count, "cache record"),
			bytes: u.buildCache.bytes,
			reclaimable: u.buildCache.reclaimableBytes,
		},
		{
			key: "containers",
			label: "Containers",
			detail: `${plural(u.containers.count, "container")}, writable layers`,
			bytes: u.containers.bytes,
			reclaimable: u.containers.reclaimableBytes,
		},
	];
	if (u.logs)
		rows.push({
			key: "logs",
			label: "Container logs",
			detail: `${plural(u.logs.count, "log file")}, shrink with log rotation`,
			bytes: u.logs.bytes,
			reclaimable: 0,
		});
	rows.sort((a, b) => b.bytes - a.bytes);
	const docker = rows.reduce((a, r) => a + r.bytes, 0);
	// Volumes on another filesystem can push Docker past this one's usage; then "other" is unknown.
	if (u.filesystem && u.filesystem.usedBytes > docker)
		rows.push({
			key: "other",
			label: "Everything else",
			detail: "System, packages and files outside Docker",
			bytes: u.filesystem.usedBytes - docker,
			reclaimable: 0,
		});
	return rows;
}

function Breakdown({ usage }: { usage: DiskUsage }) {
	const rows = diskRows(usage);
	const used =
		usage.filesystem?.usedBytes ?? rows.reduce((a, r) => a + r.bytes, 0);
	const total = usage.filesystem?.totalBytes ?? used;
	return (
		<>
			<div className="grid gap-3 border-b px-4 py-4">
				<p className="text-sm tabular">
					<span className="font-medium">{formatBytes(used)}</span>
					<span className="text-muted-foreground">
						{usage.filesystem
							? ` of ${formatBytes(total)} used on the disk holding `
							: " used by Docker in "}
					</span>
					<span className="font-mono text-xs">{usage.dockerRootDir}</span>
				</p>
				<div
					className="flex h-2 overflow-hidden rounded-full bg-muted"
					role="img"
					aria-label={rows
						.map((r) => `${r.label} ${formatBytes(r.bytes)}`)
						.join(", ")}
				>
					{rows.map((r, i) =>
						r.bytes > 0 ? (
							<span
								key={r.key}
								className={cn(
									"h-full border-r border-card last:border-r-0",
									SHADES[i],
								)}
								style={{ width: `${(100 * r.bytes) / Math.max(total, 1)}%` }}
							/>
						) : null,
					)}
				</div>
			</div>
			<ul className="divide-y">
				{rows.map((r, i) => (
					<li
						key={r.key}
						className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5"
					>
						<span className={cn("size-2.5 rounded-[3px]", SHADES[i])} />
						<div className="min-w-0">
							<p className="text-sm">{r.label}</p>
							<p className="truncate text-xs text-muted-foreground">
								{r.detail}
							</p>
						</div>
						<div className="text-right tabular">
							<p className="text-sm">{formatBytes(r.bytes)}</p>
							{r.reclaimable > 0 && (
								<p className="text-xs text-muted-foreground">
									{formatBytes(r.reclaimable)} reclaimable
								</p>
							)}
						</div>
					</li>
				))}
			</ul>
			{usage.topVolumes.length > 0 && (
				<div className="border-t px-4 py-3">
					<h3 className="mb-2 text-xs font-medium text-muted-foreground">
						Largest volumes
					</h3>
					<ul className="grid gap-1.5">
						{usage.topVolumes.slice(0, 8).map((v) => (
							<li
								key={v.name}
								className="flex items-baseline justify-between gap-3 text-xs"
							>
								<span className="flex min-w-0 items-baseline gap-2">
									<span className="truncate font-mono">{v.name}</span>
									{!v.inUse && (
										<span className="shrink-0 text-warn-text">unused</span>
									)}
								</span>
								<span className="shrink-0 tabular">{formatBytes(v.bytes)}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</>
	);
}

export function DiskPanel({ node }: { node: ClusterNode }) {
	const online = node.status === "ready" || node.status === "draining";
	const disk = useQuery({ ...diskQuery(node.id), enabled: online });
	const prune = usePruneNode(node.id);
	const [confirm, setConfirm] = useState(false);
	const usage = disk.data;
	const reclaimable = usage
		? usage.images.reclaimableBytes +
			usage.buildCache.reclaimableBytes +
			usage.containers.reclaimableBytes
		: 0;

	function onPrune() {
		prune.mutate(
			{ targets: ["containers", "images", "buildCache"], untilHours: 0 },
			{
				onSuccess: ({ report }) => {
					setConfirm(false);
					const freed = (report ?? []).reduce(
						(a, r) => a + r.reclaimedBytes,
						0,
					);
					toast.success(`Freed ${formatBytes(freed)} on ${node.hostname}`);
				},
				onError: (e) =>
					toast.error("Couldn't clean up", {
						description: e instanceof Error ? e.message : String(e),
					}),
			},
		);
	}

	return (
		<Panel
			id="node-disk"
			title="Disk"
			actions={
				online && (
					<div className="flex items-center gap-1">
						{usage && (
							<span className="mr-1 text-xs text-muted-foreground">
								{relativeTime(new Date(usage.at).toISOString())}
							</span>
						)}
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Measure again"
							disabled={disk.isFetching}
							onClick={() => void disk.refetch()}
						>
							<RotateCw className={cn(disk.isFetching && "animate-spin")} />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="text-muted-foreground"
							disabled={!usage}
							onClick={() => setConfirm(true)}
						>
							<Eraser data-icon="inline-start" />
							Clean up
						</Button>
					</div>
				)
			}
		>
			{!online ? (
				<p className="px-4 py-6 text-sm text-muted-foreground">
					The breakdown comes from the node's agent, which is not connected.
				</p>
			) : disk.error ? (
				<p className="px-4 py-6 text-sm text-bad-text">
					Couldn't measure the disk:{" "}
					{disk.error instanceof Error
						? disk.error.message
						: String(disk.error)}
				</p>
			) : usage ? (
				<Breakdown usage={usage} />
			) : (
				<SkeletonRows rows={5} />
			)}
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title={`Clean up ${node.hostname}?`}
				description={
					<>
						Removes every unused image, the build cache and stopped LogiStack
						containers
						{reclaimable > 0 && <>, about {formatBytes(reclaimable)}</>}.
						Running services keep everything, volumes are never touched, and an
						older image comes back with a pull if you roll back.
					</>
				}
				confirmLabel="Clean up"
				pending={prune.isPending}
				onConfirm={onPrune}
			/>
		</Panel>
	);
}
