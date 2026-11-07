import type { AutoscaleBehavior } from "@logistack/contracts";
import { ApiError } from "../adapter";
import type { AutoscaleApi, AutoscaleView } from "../autoscale";

const delay = <T>(v: T) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 250));

const TARGET: Record<Exclude<AutoscaleBehavior, "custom">, number> = {
	responsive: 45,
	balanced: 60,
	economical: 75,
};

const checks: AutoscaleView["checks"] = [
	{
		id: "cpu_limit",
		level: "blocker",
		ok: true,
		message: "Each copy gets 1 CPU.",
	},
	{
		id: "volumes",
		level: "blocker",
		ok: true,
		message: "No volumes: every copy is the same.",
	},
	{
		id: "host_ports",
		level: "blocker",
		ok: true,
		message: "No ports bound to a single server.",
	},
	{
		id: "healthcheck",
		level: "warning",
		ok: false,
		message:
			"No healthcheck: new copies get traffic before they are ready. Add one to avoid errors while scaling up.",
	},
	{
		id: "nodes",
		level: "warning",
		ok: true,
		message: "Copies spread across 3 servers.",
	},
];

const fresh = (): AutoscaleView => ({
	configured: false,
	enabled: false,
	minReplicas: 1,
	maxReplicas: 3,
	behavior: "balanced",
	targetCpu: 60,
	targetMemory: null,
	replicas: null,
	lastScaledAt: null,
	lastReason: null,
	checks,
});

/** The storefront web service already scales, so the card and the badge show in screenshots. */
const state = new Map<string, AutoscaleView>([
	[
		"svc_storefront_production_web",
		{
			...fresh(),
			configured: true,
			enabled: true,
			minReplicas: 2,
			maxReplicas: 6,
			replicas: 3,
			lastScaledAt: new Date(Date.now() - 18 * 60_000).toISOString(),
			lastReason: "CPU 74% above target 60%",
		},
	],
]);

/** A working day of traffic: quiet night, a morning ramp, a lunch spike, an evening tail. */
function load(minute: number) {
	const h = minute / 60;
	const day = Math.max(0, Math.sin(((h - 6) / 18) * Math.PI));
	const lunch = Math.exp(-((h - 13) ** 2) / 0.6);
	return 0.25 + 1.6 * day + 1.4 * lunch + 0.12 * Math.sin(minute / 7);
}

export const mockAutoscale: AutoscaleApi = {
	get: (id) => delay(state.get(id) ?? fresh()),
	save: (id, input) => {
		if (input.targetMemory !== null)
			return Promise.reject(
				new ApiError(
					400,
					"Set a memory limit to scale on memory",
					"bad_request",
				),
			);
		const before = state.get(id);
		const targetCpu =
			input.behavior === "custom"
				? (input.targetCpu ?? 60)
				: TARGET[input.behavior];
		const current = before?.enabled ? (before.replicas ?? 1) : 1;
		const next: AutoscaleView = {
			...(before ?? fresh()),
			configured: true,
			enabled: input.enabled,
			minReplicas: input.minReplicas,
			maxReplicas: input.maxReplicas,
			behavior: input.behavior,
			targetCpu,
			targetMemory: null,
			replicas: Math.min(
				input.maxReplicas,
				Math.max(input.minReplicas, current),
			),
		};
		state.set(id, next);
		return delay(next);
	},
	preview: (_id, q) => {
		const target =
			q.behavior === "custom" ? (q.targetCpu ?? 60) : TARGET[q.behavior];
		const start = Date.now() - 24 * 3_600_000;
		let replicas = q.minReplicas;
		const points = Array.from({ length: 24 * 60 }, (_, m) => {
			// Total demand in copies at 100% of the limit; scale up at once, down after a margin.
			const demand = load(m);
			const want = Math.ceil((demand * 100) / target);
			if (want > replicas) replicas = Math.min(q.maxReplicas, want);
			else if (want < replicas - 1 && m % 3 === 0)
				replicas = Math.max(q.minReplicas, replicas - 1);
			return {
				at: new Date(start + m * 60_000).toISOString(),
				replicas,
				cpu: Math.round(((demand * 100) / replicas) * 10) / 10,
			};
		});
		return delay({ points, enoughData: true });
	},
};
