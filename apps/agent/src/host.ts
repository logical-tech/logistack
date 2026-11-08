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
	iowait: number;
	steal: number;
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
		iowait,
		steal,
	};
}

/** Share of CPU time between two samples spent on `field` (iowait or steal), 0..100. */
export function cpuShare(
	prev: CpuSample,
	cur: CpuSample,
	field: "iowait" | "steal",
): number {
	const total = cur.total - prev.total;
	if (total <= 0) return 0;
	return Math.min(100, Math.max(0, (100 * (cur[field] - prev[field])) / total));
}

// Whole disks only: partitions (sda1, nvme0n1p1) and device-mapper/loop would count bytes twice.
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/** Cumulative bytes read and written across whole disks, from /proc/diskstats (512-byte sectors). */
export function parseDiskstats(text: string): {
	readBytes: number;
	writeBytes: number;
} {
	let readBytes = 0;
	let writeBytes = 0;
	for (const line of text.split("\n")) {
		const f = line.trim().split(/\s+/);
		if (f.length < 10 || !WHOLE_DISK.test(f[2] ?? "")) continue;
		readBytes += Number(f[5]) * 512;
		writeBytes += Number(f[9]) * 512;
	}
	return { readBytes, writeBytes };
}

/** Every hwmon temperature input in °C, named `<chip>/<label or input>`; empty where there are none (most VMs). */
export function temperatures(sys: string): { sensor: string; celsius: number }[] {
	const out: { sensor: string; celsius: number }[] = [];
	const root = join(sys, "class/hwmon");
	let chips: string[];
	try {
		chips = readdirSync(root);
	} catch {
		return out;
	}
	for (const chip of chips) {
		const dir = join(root, chip);
		let name = chip;
		try {
			name = read(join(dir, "name")).trim() || chip;
		} catch {}
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => /^temp\d+_input$/.test(f));
		} catch {}
		for (const f of files) {
			try {
				const milli = Number(read(join(dir, f)).trim());
				if (!Number.isFinite(milli) || milli <= -40_000 || milli >= 150_000) continue;
				let label = f.replace("_input", "");
				try {
					label = read(join(dir, f.replace("_input", "_label"))).trim() || label;
				} catch {}
				out.push({ sensor: `${name}/${label}`.slice(0, 64), celsius: milli / 1000 });
			} catch {}
		}
		if (out.length >= 64) break;
	}
	return out.slice(0, 64);
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
			cpuIowaitPercent: prev ? cpuShare(prev, cpu, "iowait") : 0,
			cpuStealPercent: prev ? cpuShare(prev, cpu, "steal") : 0,
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
			diskIo: (() => {
				try {
					return parseDiskstats(read(join(paths.proc, "diskstats")));
				} catch {
					return undefined;
				}
			})(),
			temperatures: temperatures(paths.sys),
		},
	};
}
