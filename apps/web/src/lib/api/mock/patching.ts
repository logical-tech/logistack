import type {
	NodePatchStatus,
	PackageUpdate,
	PatchingApi,
	PatchPolicy,
	PatchRun,
} from "../patching";

const delay = <T>(v: T, ms = 250) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const u = (
	name: string,
	from: string,
	to: string,
	security = false,
): PackageUpdate => ({
	name,
	from,
	to,
	security,
});

const ubuntu = [
	u("linux-image-6.8.0-51-generic", "6.8.0-49.49", "6.8.0-51.52", true),
	u("openssl", "3.0.13-0ubuntu3.4", "3.0.13-0ubuntu3.5", true),
	u("libssl3t64", "3.0.13-0ubuntu3.4", "3.0.13-0ubuntu3.5", true),
	u("sudo", "1.9.15p5-3ubuntu5", "1.9.15p5-3ubuntu5.24.04.1", true),
	u("curl", "8.5.0-2ubuntu10.4", "8.5.0-2ubuntu10.6"),
	u("libcurl4t64", "8.5.0-2ubuntu10.4", "8.5.0-2ubuntu10.6"),
	u("tzdata", "2024a-3ubuntu1.1", "2025b-0ubuntu0.24.04"),
	u("python3.12", "3.12.3-1ubuntu0.3", "3.12.3-1ubuntu0.5"),
];

const status: Record<string, NodePatchStatus> = {
	node_fra1: {
		nodeId: "node_fra1",
		packageManager: "apt",
		os: "Ubuntu 24.04.1 LTS",
		kernel: "6.8.0-49-generic",
		rebootRequired: false,
		updates: ubuntu,
		securityCount: 4,
		scannedAt: ago(42),
		error: null,
	},
	node_fra2: {
		nodeId: "node_fra2",
		packageManager: "apt",
		os: "Ubuntu 24.04.1 LTS",
		kernel: "6.8.0-49-generic",
		rebootRequired: true,
		updates: ubuntu.slice(4),
		securityCount: 0,
		scannedAt: ago(41),
		error: null,
	},
	node_fra3: {
		nodeId: "node_fra3",
		packageManager: "apt",
		os: "Debian GNU/Linux 12 (bookworm)",
		kernel: "6.1.0-28-amd64",
		rebootRequired: false,
		updates: [],
		securityCount: 0,
		scannedAt: ago(40),
		error: null,
	},
	node_fra4: {
		nodeId: "node_fra4",
		packageManager: "dnf",
		os: "Rocky Linux 9.4 (Blue Onyx)",
		kernel: "5.14.0-427.13.1.el9_4.x86_64",
		rebootRequired: false,
		updates: [
			u("kernel", "", "5.14.0-503.14.1.el9_5", true),
			u("openssh-server", "", "8.7p1-43.el9", true),
		],
		securityCount: 2,
		scannedAt: ago(39),
		error: null,
	},
	node_hel1: {
		nodeId: "node_hel1",
		packageManager: null,
		os: null,
		kernel: null,
		rebootRequired: false,
		updates: [],
		securityCount: 0,
		scannedAt: null,
		error: "node hel-1 is offline: no api replica holds its agent connection",
	},
};

const node = (
	nodeId: string,
	hostname: string,
	over: Partial<PatchRun["nodes"][number]> = {},
): PatchRun["nodes"][number] => ({
	nodeId,
	hostname,
	state: "succeeded",
	step: "undrain",
	error: null,
	upgraded: 0,
	rebooted: false,
	wasDrained: false,
	bootId: null,
	rebootAt: null,
	startedAt: ago(60 * 24 * 6),
	finishedAt: ago(60 * 24 * 6 - 4),
	...over,
});

const runs: PatchRun[] = [
	{
		id: "pat_window1",
		state: "succeeded",
		trigger: "window",
		securityOnly: true,
		reboot: "if_needed",
		nodes: [
			node("node_fra3", "fra-3-build", { upgraded: 6, rebooted: true }),
			node("node_fra4", "fra-4-data", { upgraded: 3 }),
		],
		log: [
			"04:00:02 fra-3-build: Debian GNU/Linux 12 (bookworm), kernel 6.1.0-27-amd64, 6 security updates",
			"04:00:03 fra-3-build: draining",
			"04:00:31 fra-3-build: drained",
			"04:00:31 fra-3-build: dpkg --configure -a",
			"04:00:32 fra-3-build: apt-get -y -q install --only-upgrade linux-image-amd64 openssl libssl3 sudo curl libcurl4",
			"04:01:40 fra-3-build: 6 packages upgraded, reboot required",
			"04:01:41 fra-3-build: rebooting",
			"04:02:58 fra-3-build: back after the reboot, kernel 6.1.0-28-amd64",
			"04:03:20 fra-3-build: every service runs its tasks",
			"04:03:21 fra-3-build: active again",
			"04:03:21 fra-3-build: patched",
		],
		error: null,
		createdAt: ago(60 * 24 * 6),
		finishedAt: ago(60 * 24 * 6 - 9),
	},
];

let policy: PatchPolicy = {
	enabled: true,
	cron: "0 4 * * 0",
	timezone: "Europe/Rome",
	securityOnly: true,
	reboot: "if_needed",
};

const HOSTNAMES: Record<string, string> = {
	node_fra1: "fra-1",
	node_fra2: "fra-2",
	node_fra3: "fra-3-build",
	node_fra4: "fra-4-data",
	node_hel1: "hel-1",
};

const empty = (nodeId: string): NodePatchStatus => ({
	nodeId,
	packageManager: null,
	os: null,
	kernel: null,
	rebootRequired: false,
	updates: [],
	securityCount: 0,
	scannedAt: null,
	error: null,
});

export const mockPatching: PatchingApi = {
	fleet: () => delay(Object.values(status)),
	node: (id) => delay(status[id] ?? empty(id)),
	async scan(id) {
		const s = status[id] ?? empty(id);
		status[id] = { ...s, scannedAt: new Date().toISOString() };
		return delay(status[id], 1_200);
	},
	runs: () => delay(runs),
	async start(input) {
		const run: PatchRun = {
			id: `pat_${Math.random().toString(36).slice(2, 10)}`,
			state: "queued",
			trigger: "manual",
			securityOnly: input.securityOnly ?? false,
			reboot: input.reboot ?? "if_needed",
			nodes: input.nodeIds.map((id) =>
				node(id, HOSTNAMES[id] ?? id, {
					state: "pending",
					step: null,
					startedAt: null,
					finishedAt: null,
				}),
			),
			log: [],
			error: null,
			createdAt: new Date().toISOString(),
			finishedAt: null,
		};
		runs.unshift(run);
		return delay(run);
	},
	async cancel(id) {
		const run = runs.find((r) => r.id === id);
		if (!run) throw new Error("patch run not found");
		run.state = "cancelled";
		run.error = "cancelled";
		run.finishedAt = new Date().toISOString();
		for (const n of run.nodes)
			if (n.state === "pending" || n.state === "running") n.state = "skipped";
		return delay(run);
	},
	policy: () => delay(policy),
	async savePolicy(input) {
		policy = input;
		return delay(policy);
	},
};
