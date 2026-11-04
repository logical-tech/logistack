import { readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	DiskRequest,
	DiskUsage,
	PruneReport,
	PruneTarget,
} from "@logistack/contracts";
import {
	type DockerClient,
	type Filters,
	LABEL_MANAGED,
	LABEL_RESOURCE,
	type SystemDf,
} from "@logistack/docker";

type Logs = DiskUsage["logs"];

/** Pure: the breakdown from `/system/df`. The engine reports -1 for sizes it did not measure. */
export function summarizeDf(
	df: SystemDf,
	extra: {
		at: number;
		dockerRootDir: string;
		filesystem: DiskUsage["filesystem"];
		logs: Logs;
	},
): DiskUsage {
	const n = (v: number | undefined) => Math.max(0, v ?? 0);
	const images = df.Images ?? [];
	const containers = df.Containers ?? [];
	const volumes = df.Volumes ?? [];
	const cache = (df.BuildCache ?? []).filter((c) => !c.Shared);
	const volumeSizes = volumes.map((v) => ({
		name: v.Name,
		bytes: n(v.UsageData?.Size),
		inUse: (v.UsageData?.RefCount ?? 0) > 0,
		resourceId: v.Labels?.[LABEL_RESOURCE],
	}));
	const sum = <T>(xs: T[], f: (x: T) => number) =>
		xs.reduce((a, x) => a + f(x), 0);
	return {
		...extra,
		images: {
			count: images.length,
			bytes: n(df.LayersSize),
			// Layers shared with an image still in use stay on disk.
			reclaimableBytes: sum(
				images.filter((i) => i.Containers === 0),
				(i) => n(i.Size - n(i.SharedSize)),
			),
		},
		containers: {
			count: containers.length,
			bytes: sum(containers, (c) => n(c.SizeRw)),
			reclaimableBytes: sum(
				containers.filter((c) => c.State !== "running"),
				(c) => n(c.SizeRw),
			),
		},
		volumes: {
			count: volumes.length,
			bytes: sum(volumeSizes, (v) => v.bytes),
			reclaimableBytes: 0,
		},
		buildCache: {
			count: cache.length,
			bytes: sum(cache, (c) => n(c.Size)),
			reclaimableBytes: sum(
				cache.filter((c) => !c.InUse),
				(c) => n(c.Size),
			),
		},
		topVolumes: volumeSizes.sort((a, b) => b.bytes - a.bytes).slice(0, 20),
	};
}

/** json-file logs (current and rotated) under `<root>/containers/<id>/`. */
export function containerLogs(containersDir: string): Logs {
	try {
		let count = 0;
		let bytes = 0;
		for (const id of readdirSync(containersDir)) {
			let files: string[];
			try {
				files = readdirSync(join(containersDir, id));
			} catch {
				continue; // removed while walking
			}
			for (const f of files)
				if (/-json\.log(\.\d+)?$/.test(f)) {
					try {
						bytes += statSync(join(containersDir, id, f)).size;
						count++;
					} catch {}
				}
		}
		return { count, bytes, reclaimableBytes: 0 };
	} catch {
		return null;
	}
}

function filesystem(path: string): DiskUsage["filesystem"] {
	try {
		const s = statfsSync(path);
		return {
			totalBytes: s.blocks * s.bsize,
			usedBytes: (s.blocks - s.bfree) * s.bsize,
		};
	} catch {
		return null;
	}
}

/** `hostRoot` is host `/` as mounted in the agent; the root dir path is the host's. */
export async function diskUsage(
	docker: DockerClient,
	hostRoot: string,
): Promise<DiskUsage> {
	const [info, df] = await Promise.all([docker.info(), docker.df()]);
	const root = join(hostRoot, info.DockerRootDir);
	return summarizeDf(df, {
		at: Date.now(),
		dockerRootDir: info.DockerRootDir,
		filesystem: filesystem(root),
		logs: containerLogs(join(root, "containers")),
	});
}

/**
 * Containers: only stopped LogiStack ones (Swarm task leftovers), never a user's own.
 * Images and build cache: everything unused, like `docker system prune -a`. No running container
 * loses anything and both come back with a pull or a rebuild.
 */
export async function prune(
	docker: DockerClient,
	targets: PruneTarget[],
	untilHours: number,
): Promise<PruneReport> {
	const until: Filters = untilHours > 0 ? { until: [`${untilHours}h`] } : {};
	const report: PruneReport = [];
	// Containers first, so the images they held become unused.
	if (targets.includes("containers")) {
		const r = await docker.prune.containers({
			label: [`${LABEL_MANAGED}=true`],
			...until,
		});
		report.push({
			target: "containers",
			deleted: r.ContainersDeleted?.length ?? 0,
			reclaimedBytes: r.SpaceReclaimed,
		});
	}
	if (targets.includes("images")) {
		const r = await docker.prune.images({ dangling: ["false"], ...until });
		report.push({
			target: "images",
			deleted: (r.ImagesDeleted ?? []).filter((d) => d.Deleted).length,
			reclaimedBytes: r.SpaceReclaimed,
		});
	}
	if (targets.includes("buildCache")) {
		const r = await docker.prune.build({ all: true, filters: until });
		report.push({
			target: "buildCache",
			deleted: r.CachesDeleted?.length ?? 0,
			reclaimedBytes: r.SpaceReclaimed,
		});
	}
	return report;
}

export async function runDisk(
	docker: DockerClient,
	hostRoot: string,
	req: DiskRequest,
) {
	const report =
		req.op === "prune"
			? await prune(docker, req.targets, req.untilHours)
			: null;
	return { usage: await diskUsage(docker, hostRoot), report };
}
