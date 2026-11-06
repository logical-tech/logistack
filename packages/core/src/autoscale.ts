import type { AutoscaleBehavior } from "@logistack/contracts";

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
