/*
 * Monitoring fixtures: five nodes with believable host series, service metrics, alert
 * settings, SSH keys and an Add-server run that advances on a timer. Series are a pure
 * function of time, so a chart and the node card it sits beside always agree.
 */
import { type ApiAdapter, ApiError } from "../adapter";
import type {
	ClusterNode,
	ContainerPoint,
	HostPoint,
	MetricRange,
	MonitoringSettings,
	NodeJoin,
	PreflightCheck,
} from "../types";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const STEP: Record<MetricRange, number> = {
	"1h": 10,
	"6h": 60,
	"24h": 300,
	"7d": 1_800,
	"30d": 7_200,
};
const SPAN: Record<MetricRange, number> = {
	"1h": HOUR,
	"6h": 6 * HOUR,
	"24h": DAY,
	"7d": 7 * DAY,
	"30d": 30 * DAY,
};
const SOURCE: Record<MetricRange, "raw" | "1m" | "1h"> = {
	"1h": "raw",
	"6h": "1m",
	"24h": "1m",
	"7d": "1m",
	"30d": "1h",
};

type Profile = {
	cpu: number;
	mem: number;
	disk: number;
	net: number;
	seed: number;
	/** Reporting window: before `from` the node didn't exist, after `until` its agent went quiet. */
	from?: number;
	until?: number;
	/** A burst centred this many ms ago. */
	burstAgo?: number;
};

const boot = Date.now();
const ago = (ms: number) => new Date(boot - ms).toISOString();

type MockNode = ClusterNode & { profile: Profile };

function baseNode(
	n: Pick<ClusterNode, "id" | "hostname" | "address" | "role" | "labels"> &
		Partial<ClusterNode> & { profile: Profile },
): MockNode {
	return {
		swarmNodeId: `swn${n.id.slice(5)}x7k2q`,
		desired: "active",
		status: "ready",
		agentVersion: "0.4.2",
		lastSeenAt: ago(4_000),
		cpus: 8,
		memoryBytes: 32 * GiB,
		engineVersion: "28.3.1",
		leader: false,
		live: null,
		createdAt: ago(64 * DAY),
		...n,
	};
}

export const nodes: MockNode[] = [
	baseNode({
		id: "node_fra1",
		hostname: "fra-1",
		address: "49.12.88.7",
		role: "manager",
		leader: true,
		labels: { ingress: "true" },
		profile: { cpu: 34, mem: 0.62, disk: 0.47, net: 2.4 * MiB, seed: 1 },
	}),
	baseNode({
		id: "node_fra2",
		hostname: "fra-2",
		address: "49.12.88.19",
		role: "worker",
		labels: { ingress: "true" },
		profile: {
			cpu: 52,
			mem: 0.55,
			disk: 0.31,
			net: 5.1 * MiB,
			seed: 2,
			burstAgo: 2.5 * HOUR,
		},
	}),
	baseNode({
		id: "node_fra3",
		hostname: "fra-3-build",
		address: "49.12.88.33",
		role: "worker",
		desired: "drain",
		status: "draining",
		agentVersion: "0.4.1",
		cpus: 16,
		memoryBytes: 64 * GiB,
		labels: { build: "true" },
		profile: { cpu: 21, mem: 0.3, disk: 0.81, net: 0.6 * MiB, seed: 3 },
	}),
	baseNode({
		id: "node_fra4",
		hostname: "fra-4-data",
		address: "49.12.88.41",
		role: "worker",
		cpus: 4,
		memoryBytes: 16 * GiB,
		createdAt: ago(9 * DAY),
		labels: { data: "true", zone: "fsn1-dc14" },
		profile: {
			cpu: 17,
			mem: 0.74,
			disk: 0.66,
			net: 1.2 * MiB,
			seed: 4,
			from: boot - 9 * DAY,
		},
	}),
	baseNode({
		id: "node_hel1",
		hostname: "hel-1",
		address: "65.21.140.4",
		role: "worker",
		status: "down",
		lastSeenAt: ago(17 * 60_000),
		labels: {},
		profile: {
			cpu: 41,
			mem: 0.5,
			disk: 0.4,
			net: 1.8 * MiB,
			seed: 5,
			until: boot - 17 * 60_000,
		},
	}),
];

/** Deterministic sample-to-sample noise in -1..1. */
function jitter(seed: number, t: number) {
	const v = Math.sin((t / 10_000) * 12.9898 + seed * 78.233) * 43_758.5453;
	return (v - Math.floor(v)) * 2 - 1;
}

/** Smooth, deterministic wobble in -1..1 from a few incommensurate sines. */
function wobble(seed: number, t: number) {
	const x = t / 60_000;
	return (
		0.5 * Math.sin(x / (7.3 + seed) + seed) +
		0.3 * Math.sin(x / (2.1 + seed * 0.37) + seed * 2.1) +
		0.12 * Math.sin(x / 9.1 + seed * 5.7) +
		0.08 * jitter(seed, t)
	);
}

/** 0..1, peaking mid-afternoon. */
const daily = (t: number) =>
	0.5 + 0.5 * Math.sin(((t % DAY) / DAY) * 2 * Math.PI - Math.PI / 1.6);

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

function reports(n: MockNode, t: number) {
	const { from = -Infinity, until = Infinity } = n.profile;
	return t >= from && t <= until;
}

function sample(n: MockNode, t: number): HostPoint {
	const p = n.profile;
	const d = daily(t);
	const w = wobble(p.seed, t);
	const burst = p.burstAgo
		? 38 * Math.exp(-(((boot - p.burstAgo - t) / (14 * 60_000)) ** 2))
		: 0;
	const cpu = clamp(p.cpu * (0.7 + 0.6 * d) + 6 * w + burst, 1, 97);
	const memTotal = n.memoryBytes ?? 8 * GiB;
	const diskTotal = 480 * GiB;
	const growth = (t - (boot - 30 * DAY)) / (30 * DAY);
	const rx = Math.max(0, p.net * (0.5 + 0.9 * d) * (1 + 0.18 * w));
	return {
		t,
		cpu,
		load1: (cpu / 100) * (n.cpus ?? 4) * 1.1,
		memUsed: memTotal * clamp(p.mem + 0.05 * d + 0.015 * w, 0.05, 0.97),
		memTotal,
		diskUsed: diskTotal * clamp(p.disk - 0.03 + 0.03 * growth, 0.02, 0.99),
		diskTotal,
		rx,
		tx: rx * (0.35 + 0.1 * w),
	};
}

function window(range: MetricRange) {
	const stepMs = STEP[range] * 1000;
	const to = Math.ceil(Date.now() / stepMs) * stepMs;
	const from = to - SPAN[range];
	const ts: number[] = [];
	for (let t = from + stepMs; t <= to; t += stepMs) ts.push(t);
	return { range, source: SOURCE[range], stepSec: STEP[range], from, to, ts };
}

function hostSeries(n: MockNode, ts: number[]) {
	return ts.filter((t) => reports(n, t)).map((t) => sample(n, t));
}

/** Cluster bucket: CPU averaged over reporting nodes, bytes and rates summed. */
function clusterSeries(ns: MockNode[], ts: number[]): HostPoint[] {
	const out: HostPoint[] = [];
	for (const t of ts) {
		const ps = ns.filter((n) => reports(n, t)).map((n) => sample(n, t));
		if (!ps.length) continue;
		const total = (k: keyof HostPoint) =>
			ps.reduce((a, p) => a + (p[k] ?? 0), 0);
		out.push({
			t,
			cpu: total("cpu") / ps.length,
			load1: total("load1") / ps.length,
			memUsed: total("memUsed"),
			memTotal: total("memTotal"),
			diskUsed: total("diskUsed"),
			diskTotal: total("diskTotal"),
			rx: total("rx"),
			tx: total("tx"),
		});
	}
	return out;
}

function view(n: MockNode): ClusterNode {
	const { profile: _, ...rest } = n;
	const now = Date.now();
	if (n.status === "down" || n.status === "pending")
		return { ...rest, live: null };
	const s = sample(n, now);
	return {
		...rest,
		lastSeenAt: new Date(now - 3_000).toISOString(),
		live: {
			nodeId: n.id,
			at: now - 3_000,
			cpu: s.cpu ?? 0,
			load1: s.load1 ?? 0,
			memUsed: s.memUsed ?? 0,
			memTotal: s.memTotal ?? 0,
			diskUsed: s.diskUsed ?? 0,
			diskTotal: s.diskTotal ?? 0,
			containers: 6 + (n.profile.seed % 4) * 3,
		},
	};
}

function containerPoint(seed: number, t: number): ContainerPoint {
	const d = daily(t);
	const w = wobble(seed + 10, t);
	// A deploy 5 hours ago: one replica for ten minutes while the new task started.
	const deploying = Math.abs(boot - 5 * HOUR - t) < 5 * 60_000;
	const replicas = deploying ? 1 : 2;
	const rx = (180 + 420 * d) * 1024 * (1 + 0.3 * w);
	return {
		t,
		cpu: clamp((18 + 46 * d + 9 * w) * (replicas / 2), 0.5, 190),
		memUsed: (2 * 360 + 90 * d + 25 * w) * MiB * (replicas / 2),
		memLimit: replicas * 1024 * MiB,
		rx,
		tx: rx * 2.6,
		read: Math.max(0, (40 + 60 * w) * 1024),
		write: Math.max(0, (120 + 260 * d + 80 * w) * 1024),
		containers: replicas,
	};
}

let settings: MonitoringSettings = {
	retention: { rawHours: 24, minuteDays: 7, hourDays: 90 },
	thresholds: [
		{
			id: "thr_cpu",
			metric: "cpu",
			nodeId: null,
			percent: 90,
			forSec: 300,
			enabled: true,
		},
		{
			id: "thr_disk",
			metric: "disk",
			nodeId: null,
			percent: 85,
			forSec: 600,
			enabled: true,
		},
		{
			id: "thr_mem_fra4",
			metric: "memory",
			nodeId: "node_fra4",
			percent: 90,
			forSec: 300,
			enabled: false,
		},
	],
};

// ---- Add-server runs ----

type JoinRun = NodeJoin & { startedAt: number };
const joins = new Map<string, JoinRun>();

const QUEUED_MS = 500;
const DURATION: Record<NodeJoin["step"], number> = {
	test: 1_600,
	preflight: 2_200,
	bootstrap: 7_000,
};

const BOOTSTRAP_LOG = [
	"Connected to {host}:{port} as {user}",
	"Detected Ubuntu 24.04.1 LTS (x86_64), kernel 6.8.0-48-generic",
	"Installing Docker Engine 28.3.1 from download.docker.com",
	"docker.service is active",
	"Opening firewall: 2377/tcp, 7946/tcp+udp, 4789/udp",
	"Joining swarm 9qk2… as {role} via 49.12.88.7:2377",
	"Node {name} joined (swarm id w3n8c1r6p0yq)",
	"Applying labels",
	"Scheduling logistack-agent 0.4.2 (global service)",
	"Waiting for the agent's first report",
	"Agent reported. {name} is ready.",
];

function preflightChecks(j: NodeJoin): PreflightCheck[] {
	const unsupported = j.host.startsWith("192.0.2.");
	return [
		{
			id: "os",
			label: "Operating system",
			status: unsupported ? "fail" : "ok",
			detail: unsupported
				? "CentOS 7 reached end of life; Docker Engine 28 does not support it"
				: "Ubuntu 24.04.1 LTS, x86_64",
		},
		{
			id: "sudo",
			label: "Root or passwordless sudo",
			status: "ok",
			detail: `${j.sshUser} can run sudo without a password`,
		},
		{
			id: "resources",
			label: "CPU and memory",
			status: "ok",
			detail: "4 cores, 7.8 GiB",
		},
		{
			id: "disk",
			label: "Free disk",
			status: "ok",
			detail: "71 GiB free on /var/lib/docker",
		},
		{
			id: "ports",
			label: "Swarm ports",
			status: "ok",
			detail: "2377, 7946 and 4789 reachable from fra-1",
		},
		{
			id: "swap",
			label: "Swap",
			status: "warn",
			detail: "No swap configured. Memory spikes will OOM-kill containers.",
		},
		{
			id: "clock",
			label: "Clock sync",
			status: "ok",
			detail: "systemd-timesyncd active, offset 3 ms",
		},
	];
}

function fill(line: string, j: NodeJoin) {
	return line
		.replaceAll("{host}", j.host)
		.replaceAll("{port}", String(j.port))
		.replaceAll("{user}", j.sshUser)
		.replaceAll("{role}", j.role)
		.replaceAll("{name}", j.name);
}

/** Advances a run to where its timer says it is; the node appears when bootstrap ends. */
function advance(run: JoinRun): NodeJoin {
	const elapsed = Date.now() - run.startedAt;
	const { startedAt: _, ...j } = run;
	if (j.state === "succeeded" || j.state === "failed") return j;
	if (elapsed < QUEUED_MS) return { ...j, state: "queued" };
	const running = elapsed < QUEUED_MS + DURATION[j.step];
	const progress = Math.min(1, (elapsed - QUEUED_MS) / DURATION[j.step]);

	if (j.step === "test") {
		if (running) return { ...j, state: "running" };
		const unreachable = j.host.endsWith(".invalid") || j.host === "203.0.113.9";
		Object.assign(run, {
			state: unreachable ? "failed" : "succeeded",
			error: unreachable
				? `ssh: connect to host ${j.host} port ${j.port}: Connection timed out`
				: null,
			log: unreachable
				? []
				: [
						`Connected to ${j.host}:${j.port} as ${j.sshUser}`,
						"Host key ED25519 SHA256:Xr2pJ8nQ4cV7tL1mW9sK3fD6hB0gY5aZ trusted on first use",
					],
		});
		return advance(run);
	}
	if (j.step === "preflight") {
		const checks = preflightChecks(j);
		if (running)
			return {
				...j,
				state: "running",
				checks: checks.slice(0, Math.floor(progress * checks.length)),
			};
		const failed = checks.some((c) => c.status === "fail");
		Object.assign(run, {
			checks,
			state: failed ? "failed" : "succeeded",
			error: failed ? "1 check failed" : null,
		});
		return advance(run);
	}
	const lines = BOOTSTRAP_LOG.map((l) => fill(l, j));
	if (running)
		return {
			...j,
			state: "running",
			log: lines.slice(0, Math.max(1, Math.ceil(progress * lines.length))),
		};
	const id = `node_${j.name.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
	if (!nodes.some((n) => n.id === id)) {
		nodes.push(
			baseNode({
				id,
				hostname: j.name,
				address: j.host,
				role: j.role,
				labels: j.labels,
				cpus: 4,
				memoryBytes: 8 * GiB,
				createdAt: new Date().toISOString(),
				profile: {
					cpu: 6,
					mem: 0.18,
					disk: 0.12,
					net: 0.1 * MiB,
					seed: 6,
					from: Date.now(),
				},
			}),
		);
	}
	Object.assign(run, {
		state: "succeeded",
		log: lines,
		nodeId: id,
		swarmNodeId: "w3n8c1r6p0yq",
	});
	return advance(run);
}

const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;

function delay<T>(value: T, ms = 160 + Math.random() * 240): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

const fail = (status: number, message: string) =>
	Promise.reject(new ApiError(status, message));

function findNode(id: string) {
	return nodes.find((n) => n.id === id);
}

export const monitoringAdapter: Pick<
	ApiAdapter,
	"nodes" | "joins" | "metrics" | "monitoring"
> = {
	nodes: {
		list: () => delay(nodes.filter((n) => n.desired !== "remove").map(view)),
		get: (id) => {
			const n = findNode(id);
			return n ? delay(view(n)) : fail(404, "node not found");
		},
		update: (id, input) => {
			const n = findNode(id);
			if (!n) return fail(404, "node not found");
			if (input.labels) n.labels = input.labels;
			if (input.desired) {
				n.desired = input.desired;
				n.status =
					input.desired === "drain"
						? "draining"
						: n.status === "draining"
							? "ready"
							: n.status;
			}
			return delay(view(n), 420);
		},
		remove: (id) => {
			const n = findNode(id);
			if (!n) return fail(404, "node not found");
			if (n.leader)
				return fail(
					400,
					"the leader manager runs LogiStack and cannot be removed",
				);
			n.desired = "remove";
			n.status = "draining";
			return delay(view(n), 500);
		},
	},
	joins: {
		create: (input) => {
			const at = new Date().toISOString();
			const run: JoinRun = {
				id: rid("nj"),
				name: input.name,
				host: input.host,
				port: input.port ?? 22,
				sshUser: input.sshUser,
				sshKeyId: input.sshKeyId,
				role: input.role ?? "worker",
				labels: input.labels ?? {},
				step: "test",
				state: "queued",
				error: null,
				checks: [],
				log: [],
				swarmNodeId: null,
				nodeId: null,
				createdAt: at,
				updatedAt: at,
				startedAt: Date.now(),
			};
			joins.set(run.id, run);
			return delay(advance(run), 300);
		},
		get: (id) => {
			const run = joins.get(id);
			return run ? delay(advance(run), 80) : fail(404, "server join not found");
		},
		update: (id, input) => {
			const run = joins.get(id);
			if (!run) return fail(404, "server join not found");
			const now = advance(run);
			if (now.state === "queued" || now.state === "running")
				return fail(409, `the ${now.step} step is still ${now.state}`);
			if (now.step === "bootstrap" && now.state === "succeeded")
				return fail(409, "this server has already joined");
			Object.assign(run, {
				...input,
				port: input.port ?? 22,
				role: input.role ?? "worker",
				labels: input.labels ?? {},
				step: "test",
				state: "queued",
				error: null,
				checks: [],
				log: [],
				startedAt: Date.now(),
			});
			return delay(advance(run), 300);
		},
		run: (id, step) => {
			const run = joins.get(id);
			if (!run) return fail(404, "server join not found");
			const now = advance(run);
			if (now.state === "queued" || now.state === "running")
				return fail(409, `the ${now.step} step is still ${now.state}`);
			Object.assign(run, {
				step,
				state: "queued",
				error: null,
				...(step === "bootstrap" && { log: [] }),
				startedAt: Date.now(),
			});
			return delay(advance(run), 300);
		},
	},
	metrics: {
		hosts: ({ range, nodeId, perNode }) => {
			const { ts, ...w } = window(range);
			const live = nodes.filter((n) => n.desired !== "remove");
			if (nodeId) {
				const n = findNode(nodeId);
				if (!n) return fail(404, "node not found");
				return delay({ ...w, series: [{ nodeId, points: hostSeries(n, ts) }] });
			}
			return delay({
				...w,
				series: perNode
					? live.map((n) => ({ nodeId: n.id, points: hostSeries(n, ts) }))
					: [{ nodeId: null, points: clusterSeries(live, ts) }],
			});
		},
		service: (id, range) => {
			const { ts, ...w } = window(range);
			const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 7;
			// A service created minutes ago has no samples yet: the empty state is the real one.
			if (id.startsWith("svc_") && !/_production_|_staging_/.test(id))
				return delay({ ...w, points: [] });
			return delay({ ...w, points: ts.map((t) => containerPoint(seed, t)) });
		},
	},
	monitoring: {
		settings: () => delay(settings),
		save: (input) => {
			for (const t of input.thresholds) {
				if (t.nodeId && !findNode(t.nodeId)) return fail(404, "node not found");
			}
			settings = {
				retention: input.retention,
				thresholds: input.thresholds.map((t) => ({
					...t,
					id: t.id ?? rid("thr"),
				})),
			};
			return delay(settings, 500);
		},
	},
};
