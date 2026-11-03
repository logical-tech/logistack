import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import type { HostMetrics } from "@logistack/contracts";

export interface HostPaths {
	proc: string;
	sys: string;
	/** Host `/` as seen by the agent, for statfs on host mount points. */
	root: string;
}

export interface CpuSample {
	total: number;
	idle: number;
}

/** First `cpu` line of /proc/stat. iowait counts as idle. */
export function parseCpu(stat: string): CpuSample {
	const fields = (stat.split("\n", 1)[0] ?? "")
		.trim()
		.split(/\s+/)
		.slice(1, 9)
		.map(Number);
	const [
		user = 0,
		nice = 0,
		system = 0,
		idle = 0,
		iowait = 0,
		irq = 0,
		softirq = 0,
		steal = 0,
	] = fields;
	return {
		total: user + nice + system + idle + iowait + irq + softirq + steal,
		idle: idle + iowait,
	};
}

export function cpuPercent(prev: CpuSample, cur: CpuSample): number {
	const total = cur.total - prev.total;
	if (total <= 0) return 0;
	return Math.min(
		100,
		Math.max(0, (100 * (total - (cur.idle - prev.idle))) / total),
	);
}

/** /proc/meminfo values in bytes. */
export function parseMeminfo(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^(\w+):\s+(\d+)(?:\s+kB)?/);
		if (m)
			out[m[1] as string] = Number(m[2]) * (line.endsWith("kB") ? 1024 : 1);
	}
	return out;
}

export interface Mount {
	device: string;
	mount: string;
	fsType: string;
}

const SKIP_FS = new Set(["squashfs", "iso9660", "overlay", "tmpfs"]);

/** Block-device mounts from /proc/<pid>/mounts, one per device (its shortest mount point). */
export function parseMounts(text: string): Mount[] {
	const byDevice = new Map<string, Mount>();
	for (const line of text.split("\n")) {
		const [device, rawMount, fsType] = line.split(" ");
		if (!device?.startsWith("/dev/") || !rawMount || !fsType) continue;
		if (SKIP_FS.has(fsType)) continue;
		// The kernel escapes space, tab, newline and backslash as octal.
		const mount = rawMount.replace(/\\([0-7]{3})/g, (_, o: string) =>
			String.fromCharCode(Number.parseInt(o, 8)),
		);
		const seen = byDevice.get(device);
		if (!seen || mount.length < seen.mount.length)
			byDevice.set(device, { device, mount, fsType });
	}
	return [...byDevice.values()];
}

const read = (path: string) => readFileSync(path, "utf8");

function disks(paths: HostPaths): HostMetrics["disks"] {
	let mounts: Mount[];
	try {
		// PID 1's view: the agent's own /proc/mounts lists the container's mounts.
		mounts = parseMounts(read(join(paths.proc, "1/mounts")));
	} catch {
		return [];
	}
	const out: HostMetrics["disks"] = [];
	for (const m of mounts) {
		try {
			const s = statfsSync(join(paths.root, m.mount));
			const total = s.blocks * s.bsize;
			const free = s.bfree * s.bsize;
			out.push({
				...m,
				totalBytes: total,
				usedBytes: total - free,
				availableBytes: s.bavail * s.bsize,
			});
		} catch {
			// mount point not visible under the host root bind mount
		}
	}
	return out;
}

// Container plumbing would count the same bytes twice. A `device` link is no test: VM NICs such as OrbStack's eth0 lack one.
const VIRTUAL_NIC =
	/^(lo|veth|docker|br-|vx-|vxlan|virbr|cni|flannel|cali|tunl|kube)/;

/** Sums host interfaces, skipping loopback and container bridges, veths and overlays. */
function network(paths: HostPaths): HostMetrics["network"] {
	const dir = join(paths.sys, "class/net");
	let rxBytes = 0;
	let txBytes = 0;
	for (const iface of readdirSync(dir)) {
		if (VIRTUAL_NIC.test(iface)) continue;
		rxBytes += Number(read(join(dir, iface, "statistics/rx_bytes")));
		txBytes += Number(read(join(dir, iface, "statistics/tx_bytes")));
	}
	return { rxBytes, txBytes };
}

/** Reads host metrics; returns null when the host's /proc is unreadable (e.g. on macOS). */
export function readHost(
	paths: HostPaths,
	prev: CpuSample | undefined,
): { host: HostMetrics; cpu: CpuSample } | null {
	let stat: string;
	try {
		stat = read(join(paths.proc, "stat"));
	} catch {
		return null;
	}
	const cpu = parseCpu(stat);
	const mem = parseMeminfo(read(join(paths.proc, "meminfo")));
	const total = mem.MemTotal ?? 0;
	const available = mem.MemAvailable ?? mem.MemFree ?? 0;
	const swapTotal = mem.SwapTotal ?? 0;
	const [l1 = 0, l5 = 0, l15 = 0] = read(join(paths.proc, "loadavg"))
		.split(" ")
		.map(Number);
	let net: HostMetrics["network"];
	try {
		net = network(paths);
	} catch {
		net = { rxBytes: 0, txBytes: 0 };
	}
	return {
		cpu,
		host: {
			cpuPercent: prev ? cpuPercent(prev, cpu) : 0,
			load: [l1, l5, l15],
			memory: {
				totalBytes: total,
				availableBytes: available,
				usedBytes: total - available,
			},
			swap: {
				totalBytes: swapTotal,
				usedBytes: swapTotal - (mem.SwapFree ?? 0),
			},
			disks: disks(paths),
			network: net,
			uptimeSec: Number(read(join(paths.proc, "uptime")).split(" ")[0]),
		},
	};
}
