import type {
	DesiredState,
	ObservedState,
	WorkHealth,
} from "@logistack/contracts";

/** What `serviceHealth` reads for one service of the default environment (section 6.1). */
export type ServiceHealthInput = {
	desiredState: DesiredState;
	/** Service maintenance switched on. */
	maintenance: boolean;
	/** `service_status`; null before the first report. */
	status: {
		observed: ObservedState;
		replicasRunning: number;
		replicasDesired: number;
		crashLoop: boolean;
		changedAt: Date;
	} | null;
	/** Uptime monitors linked to the service, with their confirmed status. */
	monitors: { status: "up" | "down" | "pending"; inMaintenance: boolean }[];
	/** A `service_threshold` alert is firing. */
	thresholdFiring: boolean;
	/** Start of a `started` deployment of this service, if any. */
	deployingSince: Date | null;
	now: Date;
};

const MIN = 60_000;

/** Section 6.2, first match wins. */
export function serviceHealth(s: ServiceHealthInput): WorkHealth {
	if (s.desiredState === "stopped") return "paused";
	if (s.maintenance || s.monitors.some((m) => m.inMaintenance))
		return "maintenance";
	const st = s.status;
	const monitorDown = s.monitors.some((m) => m.status === "down");
	if (!st) return monitorDown ? "down" : "unknown";
	if (
		st.observed === "failed" ||
		st.observed === "stopped" ||
		(st.replicasDesired > 0 && st.replicasRunning === 0) ||
		monitorDown
	)
		return "down";
	const now = s.now.getTime();
	// A rolling deploy briefly runs fewer replicas; not a degradation the PM should see.
	const deploying =
		s.deployingSince !== null && now - s.deployingSince.getTime() < 10 * MIN;
	if (
		(st.observed === "starting" && now - st.changedAt.getTime() > 5 * MIN) ||
		st.observed === "unhealthy" ||
		(st.replicasRunning > 0 &&
			st.replicasRunning < st.replicasDesired &&
			!deploying) ||
		st.crashLoop ||
		s.monitors.some((m) => m.status === "pending") ||
		s.thresholdFiring
	)
		return "degraded";
	if (st.observed === "running" && st.replicasRunning >= st.replicasDesired)
		return "operational";
	return "unknown";
}

const SEVERITY: Record<WorkHealth, number> = {
	down: 5,
	degraded: 4,
	maintenance: 3,
	operational: 2,
	unknown: 1,
	paused: 0,
};

/** Worst service result, paused ignored; all paused → paused; no services → unknown. */
export function projectHealth(services: readonly WorkHealth[]): WorkHealth {
	const live = services.filter((h) => h !== "paused");
	if (live.length === 0) return services.length ? "paused" : "unknown";
	return live.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
}

/** When the current state began: the first transition of the latest run of equal states. */
export function healthSince(
	transitions: readonly { at: Date | string; health: WorkHealth }[],
): string | null {
	const sorted = [...transitions].sort(
		(a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
	);
	const last = sorted.at(-1);
	if (!last) return null;
	let i = sorted.length - 1;
	while (i > 0 && sorted[i - 1]?.health === last.health) i--;
	return new Date((sorted[i] as { at: Date | string }).at).toISOString();
}
