import type {
	PackageManager,
	PackageUpdate,
	PatchReboot,
	PatchRunNode,
	PatchStep,
} from "@logistack/contracts";

// Pure parts of node patching: which commands to run on a host (argv, never a shell string) and
// how to read what they print. The worker runs them through the agent (apps/worker/src/patching.ts).

/** apt and dpkg read these; LC_ALL keeps the output in the format parsed below. */
export const PATCH_ENV = [
	"DEBIAN_FRONTEND=noninteractive",
	"LC_ALL=C",
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
];

/** `ID` and `ID_LIKE` of /etc/os-release, plus `PRETTY_NAME`. */
export function parseOsRelease(text: string): {
	id: string;
	like: string[];
	pretty: string | null;
} {
	const kv: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^([A-Z_]+)=(.*)$/);
		if (m) kv[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, "");
	}
	return {
		id: kv.ID ?? "",
		like: (kv.ID_LIKE ?? "").split(/\s+/).filter(Boolean),
		pretty: kv.PRETTY_NAME ?? null,
	};
}

const APT = new Set(["debian", "ubuntu", "raspbian", "linuxmint", "pop"]);
const DNF = new Set([
	"fedora",
	"rhel",
	"centos",
	"rocky",
	"almalinux",
	"ol",
	"amzn",
]);

export function packageManagerFor(os: {
	id: string;
	like: string[];
}): PackageManager | null {
	for (const id of [os.id, ...os.like]) {
		if (APT.has(id)) return "apt";
		if (DNF.has(id)) return "dnf";
	}
	return null;
}

const APT_FLAGS = [
	"-y",
	"-q",
	"-o",
	"Dpkg::Options::=--force-confdef",
	"-o",
	"Dpkg::Options::=--force-confold",
];

/** Commands that refresh the package index and list what an upgrade would change. */
export function scanCommands(pm: PackageManager): {
	refresh: string[];
	list: string[];
	/** dnf only: the security advisories, matched by name against `list`. */
	security?: string[];
} {
	return pm === "apt"
		? {
				refresh: ["apt-get", "-q", "update"],
				list: ["apt-get", "-s", "upgrade", "--with-new-pkgs"],
			}
		: {
				refresh: ["dnf", "-q", "makecache"],
				list: ["dnf", "-q", "check-update"],
				security: [
					"dnf",
					"-q",
					"updateinfo",
					"list",
					"--updates",
					"--security",
				],
			};
}

/** Debian package names: they cannot start with `-`, so none reads as an option in argv. */
const PKG_NAME = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/;

/**
 * The upgrade, in order. apt has no security-only switch, so a security-only run upgrades the
 * scanned security packages by name.
 */
export function upgradeCommands(
	pm: PackageManager,
	o: { securityOnly: boolean; updates: PackageUpdate[] },
): string[][] {
	if (pm === "dnf")
		return [
			o.securityOnly
				? ["dnf", "-y", "-q", "upgrade", "--security"]
				: ["dnf", "-y", "-q", "upgrade"],
		];
	// A dpkg run cut short (a worker that died mid-upgrade) blocks every apt call until configured.
	const repair = ["dpkg", "--configure", "-a"];
	if (!o.securityOnly)
		return [repair, ["apt-get", ...APT_FLAGS, "upgrade", "--with-new-pkgs"]];
	const names = o.updates
		.filter((u) => u.security && PKG_NAME.test(u.name))
		.map((u) => u.name);
	if (!names.length) return [repair];
	return [
		repair,
		["apt-get", ...APT_FLAGS, "install", "--only-upgrade", ...names],
	];
}

/**
 * `apt-get -s upgrade` lines: `Inst name [from] (to Origin:ver/suite[, Origin:...] [arch])`; a
 * package the upgrade newly installs has no `[from]`.
 */
export function parseAptSimulate(out: string): PackageUpdate[] {
	const updates: PackageUpdate[] = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^Inst (\S+) (?:\[([^\]]+)\] )?\((\S+) ([^)]*)\)/);
		if (!m) continue;
		updates.push({
			name: m[1] as string,
			from: m[2] ?? null,
			to: m[3] as string,
			security: /-security|Security:/i.test(m[4] as string),
		});
	}
	return updates;
}

/** `name.arch` to `name`; arch has no dot, names may. */
const stripArch = (s: string) => s.replace(/\.[^.]+$/, "");

/** `dnf check-update`: `name.arch  version  repo` rows until the obsoletes section. */
export function parseDnfCheckUpdate(
	out: string,
	security: Set<string>,
): PackageUpdate[] {
	const updates: PackageUpdate[] = [];
	for (const line of out.split("\n")) {
		if (/^Obsoleting/i.test(line)) break;
		const f = line.trim().split(/\s+/);
		if (f.length !== 3 || !f[0]?.includes(".")) continue;
		if (!/\d/.test(f[1] as string)) continue;
		const name = stripArch(f[0]);
		updates.push({
			name,
			from: null,
			to: f[1] as string,
			security: security.has(name),
		});
	}
	return updates;
}

/** `dnf updateinfo list --security`: `ADVISORY  Severity/Sec.  name-[epoch:]version-release.arch`. */
export function parseDnfSecurity(out: string): Set<string> {
	const names = new Set<string>();
	for (const line of out.split("\n")) {
		const nevra = line.trim().split(/\s+/)[2];
		if (!nevra) continue;
		// Drop `.arch`, then `-release` and `-version`.
		const name = stripArch(nevra).replace(/-[^-]+-[^-]+$/, "");
		if (name) names.add(name);
	}
	return names;
}

/** Compares kernel release strings by their numeric runs: 6.8.0-49 < 6.8.0-51 < 6.11.0-9. */
export function compareKernels(a: string, b: string): number {
	const pa = a.match(/\d+/g)?.map(Number) ?? [];
	const pb = b.match(/\d+/g)?.map(Number) ?? [];
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? -1) - (pb[i] ?? -1);
		if (d) return d;
	}
	return 0;
}

/** True when /boot holds a newer kernel than the running one: it only runs after a reboot. */
export function newerKernelInstalled(running: string, bootListing: string) {
	const installed = bootListing
		.split("\n")
		.map((f) => f.trim().match(/^vmlinuz-(.+)$/)?.[1])
		.filter((v): v is string => Boolean(v));
	return installed.some((k) => compareKernels(k, running) > 0);
}

/** Boot identity: the kernel's boot id plus PID 1's start time; changes with every reboot. */
export const BOOT_ID_COMMAND = [
	"cat",
	"/proc/sys/kernel/random/boot_id",
	"/proc/1/stat",
];

export function parseBootId(out: string): string {
	const [bootId = "", stat = ""] = out.trim().split("\n");
	// Field 22 of /proc/1/stat, counted after the `(comm)` that may hold spaces.
	const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
	return `${bootId.trim()}:${start}`;
}

/**
 * The step after `step` for one node, or null when the node is done. The reboot and the wait for
 * the host to come back are skipped when no reboot is due.
 */
export function nextPatchStep(
	step: PatchStep,
	o: { reboot: PatchReboot; rebootRequired: boolean },
): PatchStep | null {
	switch (step) {
		case "scan":
			return "drain";
		case "drain":
			return "upgrade";
		case "upgrade":
			return o.reboot === "if_needed" && o.rebootRequired
				? "reboot"
				: "healthy";
		case "reboot":
			return "rejoin";
		case "rejoin":
			return "healthy";
		case "healthy":
			return "undrain";
		case "undrain":
			return null;
	}
}

/** The node a run works on now: the running one, else the first pending; undefined when done. */
export function currentPatchNode<T extends Pick<PatchRunNode, "state">>(
	nodes: T[],
): T | undefined {
	return (
		nodes.find((n) => n.state === "running") ??
		nodes.find((n) => n.state === "pending")
	);
}
