import type {
	ApplicationSpec,
	AutoscaleBehavior,
	AutoscaleCheck,
} from "@logistack/contracts";

/** CPU target per preset; `custom` keeps the stored one. */
export const BEHAVIOR_CPU_TARGET: Record<
	Exclude<AutoscaleBehavior, "custom">,
	number
> = { responsive: 45, balanced: 60, economical: 75 };

/** The scale-up window and cooldown; scaling up reacts within about a minute. */
export const SCALE_UP_WINDOW_SEC = 60;
const SCALE_UP_COOLDOWN_MS = 60_000;
/** The scale-down window and cooldown; scaling down waits out short dips. */
export const SCALE_DOWN_WINDOW_SEC = 300;
const SCALE_DOWN_COOLDOWN_MS = 180_000;
/** Usage within this fraction of the target counts as on target, so replicas don't flap. */
const TOLERANCE = 0.1;
const MAX_STEP_UP = 4;

/** Average usage across running replicas, percent of the limit; null when there are no samples. */
export type Usage = { cpu: number | null; memory: number | null };

export type ScaleInput = {
	current: number;
	min: number;
	max: number;
	targetCpu: number;
	targetMemory: number | null;
	/** Over `SCALE_UP_WINDOW_SEC`. */
	recent: Usage;
	/** Over `SCALE_DOWN_WINDOW_SEC`. */
	sustained: Usage;
	lastScaledAt: Date | null;
	now: Date;
	/** Tasks of the service are not running yet: the cluster may be out of room. */
	pending: boolean;
};

export type ScaleDecision = { replicas: number; reason: string };

const clamp = (n: number, min: number, max: number) =>
	Math.min(max, Math.max(min, n));

/** Replicas needed to bring `usage` to `target`; null without a sample. */
const want = (current: number, usage: number | null, target: number | null) =>
	usage == null || target == null
		? null
		: Math.abs(usage / target - 1) <= TOLERANCE
			? current
			: Math.ceil((current * usage) / target);

const pct = (n: number) => `${Math.round(n)}%`;

/**
 * The replica count the autoscaler moves to, or undefined to hold. Pure.
 * Up fast: at most doubling (and +4) per step, a minute apart. Down slow: one replica per
 * step, three minutes apart, and only when every signal agrees. Holds while new tasks are
 * still pending, so a full cluster isn't asked for more.
 */
export function decideScale(i: ScaleInput): ScaleDecision | undefined {
	if (i.current < i.min)
		return { replicas: i.min, reason: `Raised to the minimum of ${i.min}` };
	if (i.current > i.max)
		return { replicas: i.max, reason: `Lowered to the maximum of ${i.max}` };
	if (i.pending) return undefined;
	const since = i.lastScaledAt
		? i.now.getTime() - i.lastScaledAt.getTime()
		: Number.POSITIVE_INFINITY;

	const upCpu = want(i.current, i.recent.cpu, i.targetCpu);
	const upMem = want(i.current, i.recent.memory, i.targetMemory);
	const up = Math.max(upCpu ?? 0, upMem ?? 0);
	if (up > i.current && i.current < i.max) {
		if (since < SCALE_UP_COOLDOWN_MS) return undefined;
		const step = Math.min(up, i.current * 2, i.current + MAX_STEP_UP);
		const byMem = (upMem ?? 0) > (upCpu ?? 0);
		const [usage, target] = byMem
			? [i.recent.memory as number, i.targetMemory as number]
			: [i.recent.cpu as number, i.targetCpu];
		return {
			replicas: clamp(step, i.min, i.max),
			reason: `${byMem ? "Memory" : "CPU"} ${pct(usage)} above target ${pct(target)}`,
		};
	}

	const downCpu = want(i.current, i.sustained.cpu, i.targetCpu);
	const downMem = want(i.current, i.sustained.memory, i.targetMemory);
	const memAgrees =
		i.targetMemory == null || (downMem ?? i.current) < i.current;
	if (
		downCpu != null &&
		downCpu < i.current &&
		memAgrees &&
		i.current > i.min &&
		since >= SCALE_DOWN_COOLDOWN_MS
	)
		return {
			replicas: i.current - 1,
			reason: `CPU ${pct(i.sustained.cpu as number)} below target ${pct(i.targetCpu)}`,
		};
	return undefined;
}

/** The autoscaler's replica count when it applies; undefined leaves `spec.replicas` in charge. */
export const scaledReplicas = (
	autoscale: { enabled: boolean; replicas: number | null } | null | undefined,
): number | undefined =>
	autoscale?.enabled && autoscale.replicas != null
		? autoscale.replicas
		: undefined;

/** The CPU target a behavior stands for; `custom` keeps the given one. */
export const targetCpuFor = (
	behavior: AutoscaleBehavior,
	custom: number | undefined,
): number =>
	behavior === "custom"
		? (custom ?? BEHAVIOR_CPU_TARGET.balanced)
		: BEHAVIOR_CPU_TARGET[behavior];

/**
 * Whether a service can scale out safely. Pure. Blockers refuse enabling: without a CPU limit
 * there is nothing to measure against, copies would share or split a volume, and two copies
 * can't bind the same host port on one node. Warnings only inform.
 */
export function autoscaleChecks(i: {
	spec: ApplicationSpec;
	/** Named volume mounts of the service. */
	volumes: number;
	/** Nodes in the organization. */
	nodes: number;
}): AutoscaleCheck[] {
	const hostPort = i.spec.ports.find(
		(p) => p.published && (p.mode ?? "host") === "host",
	);
	const binds = i.spec.mounts?.length ?? 0;
	return [
		{
			id: "cpu_limit",
			level: "blocker",
			ok: !!i.spec.resources.cpu,
			message: i.spec.resources.cpu
				? `Each copy gets ${i.spec.resources.cpu} CPU.`
				: "Pick a size first: usage is measured against each copy's CPU limit.",
		},
		{
			id: "volumes",
			level: "blocker",
			ok: i.volumes + binds === 0,
			message:
				i.volumes + binds === 0
					? "No volumes: every copy is the same."
					: "This service keeps data in a volume or host path. Copies would split or share that data, so it can't scale automatically.",
		},
		{
			id: "host_ports",
			level: "blocker",
			ok: !hostPort,
			message: hostPort
				? `Port ${hostPort.published} is published on the server itself, and two copies can't use it on one server. Use a domain or ingress mode instead.`
				: "No ports bound to a single server.",
		},
		{
			id: "healthcheck",
			level: "warning",
			ok: !!i.spec.healthcheck,
			message: i.spec.healthcheck
				? "New copies get traffic once their healthcheck passes."
				: "No healthcheck: new copies get traffic before they are ready. Add one to avoid errors while scaling up.",
		},
		{
			id: "nodes",
			level: "warning",
			ok: i.nodes > 1,
			message:
				i.nodes > 1
					? `Copies spread across ${i.nodes} servers.`
					: "All copies run on one server and share its CPU. Add a server to get more room.",
		},
	];
}

/** One minute of a service's history: CPU summed over its containers (percent of a core), average memory percent. */
export type LoadPoint = { at: Date; cpu: number; memory: number | null };

/**
 * Replays `decideScale` over past load. Pure. The total CPU is spread over the simulated count,
 * so more copies each run cooler; memory per copy is taken as it was, since it rarely spreads.
 */
export function previewScale(
	points: LoadPoint[],
	s: {
		min: number;
		max: number;
		targetCpu: number;
		targetMemory: number | null;
	},
	cpuLimit: number,
	start: number,
): { at: Date; replicas: number; cpu: number }[] {
	let replicas = clamp(start, s.min, s.max);
	let lastScaledAt: Date | null = null;
	const out: { at: Date; replicas: number; cpu: number }[] = [];
	const avg = (xs: number[]) =>
		xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
	for (let k = 0; k < points.length; k++) {
		const now = (points[k] as LoadPoint).at;
		const within = (sec: number) =>
			points
				.slice(Math.max(0, k - 10), k + 1)
				.filter((p) => now.getTime() - p.at.getTime() < sec * 1000);
		const usage = (sec: number): Usage => {
			const w = within(sec);
			const cpu = avg(w.map((p) => p.cpu));
			return {
				cpu: cpu == null ? null : cpu / replicas / cpuLimit,
				memory: avg(w.flatMap((p) => (p.memory == null ? [] : [p.memory]))),
			};
		};
		const recent = usage(SCALE_UP_WINDOW_SEC);
		const d = decideScale({
			current: replicas,
			min: s.min,
			max: s.max,
			targetCpu: s.targetCpu,
			targetMemory: s.targetMemory,
			recent,
			sustained: usage(SCALE_DOWN_WINDOW_SEC),
			lastScaledAt,
			now,
			pending: false,
		});
		if (d) {
			replicas = d.replicas;
			lastScaledAt = now;
		}
		out.push({
			at: now,
			replicas,
			cpu:
				Math.round(((points[k] as LoadPoint).cpu / replicas / cpuLimit) * 10) /
				10,
		});
	}
	return out;
}
