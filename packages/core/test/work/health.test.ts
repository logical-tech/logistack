import { describe, expect, test } from "bun:test";
import {
	healthSince,
	projectHealth,
	type ServiceHealthInput,
	serviceHealth,
} from "../../src/work/health.ts";

const now = new Date("2026-11-09T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const base: ServiceHealthInput = {
	desiredState: "running",
	maintenance: false,
	status: {
		observed: "running",
		replicasRunning: 2,
		replicasDesired: 2,
		crashLoop: false,
		changedAt: ago(60),
	},
	monitors: [],
	thresholdFiring: false,
	deployingSince: null,
	now,
};
const status = (s: Partial<NonNullable<ServiceHealthInput["status"]>>) => ({
	...base,
	status: {
		...(base.status as NonNullable<ServiceHealthInput["status"]>),
		...s,
	},
});

describe("serviceHealth", () => {
	test.each<[string, ServiceHealthInput, string]>([
		["operational", base, "operational"],
		[
			"paused beats everything",
			{ ...status({ observed: "failed" }), desiredState: "stopped" },
			"paused",
		],
		[
			"service maintenance",
			{ ...status({ observed: "failed" }), maintenance: true },
			"maintenance",
		],
		[
			"monitor maintenance window",
			{ ...base, monitors: [{ status: "down", inMaintenance: true }] },
			"maintenance",
		],
		["failed", status({ observed: "failed" }), "down"],
		["stopped while desired running", status({ observed: "stopped" }), "down"],
		["no replicas running", status({ replicasRunning: 0 }), "down"],
		[
			"monitor down",
			{ ...base, monitors: [{ status: "down", inMaintenance: false }] },
			"down",
		],
		[
			"starting > 5 min",
			status({ observed: "starting", changedAt: ago(6) }),
			"degraded",
		],
		[
			"starting < 5 min",
			status({ observed: "starting", changedAt: ago(2) }),
			"unknown",
		],
		["unhealthy", status({ observed: "unhealthy" }), "degraded"],
		["partial replicas", status({ replicasRunning: 1 }), "degraded"],
		["crash loop", status({ crashLoop: true }), "degraded"],
		[
			"monitor pending",
			{ ...base, monitors: [{ status: "pending", inMaintenance: false }] },
			"degraded",
		],
		["threshold firing", { ...base, thresholdFiring: true }, "degraded"],
		["no status row", { ...base, status: null }, "unknown"],
		[
			"no status row, monitor down",
			{
				...base,
				status: null,
				monitors: [{ status: "down", inMaintenance: false }],
			},
			"down",
		],
		[
			"monitors up",
			{ ...base, monitors: [{ status: "up", inMaintenance: false }] },
			"operational",
		],
	])("%s", (_, input, expected) => {
		expect(serviceHealth(input)).toBe(expected as never);
	});

	test("rolling deploy under 10 minutes isn't degraded", () => {
		expect(
			serviceHealth({
				...status({ replicasRunning: 1 }),
				deployingSince: ago(3),
			}),
		).toBe("unknown");
		expect(
			serviceHealth({
				...status({ replicasRunning: 1 }),
				deployingSince: ago(11),
			}),
		).toBe("degraded");
	});
});

describe("projectHealth", () => {
	test("precedence down > degraded > maintenance > operational > unknown", () => {
		expect(projectHealth(["operational", "down", "degraded"])).toBe("down");
		expect(projectHealth(["operational", "maintenance", "degraded"])).toBe(
			"degraded",
		);
		expect(projectHealth(["operational", "maintenance"])).toBe("maintenance");
		expect(projectHealth(["unknown", "operational"])).toBe("operational");
		expect(projectHealth(["unknown"])).toBe("unknown");
	});
	test("paused ignored; all paused → paused; empty → unknown", () => {
		expect(projectHealth(["paused", "operational"])).toBe("operational");
		expect(projectHealth(["paused", "paused"])).toBe("paused");
		expect(projectHealth([])).toBe("unknown");
	});
});

describe("healthSince", () => {
	test("start of the latest run", () => {
		expect(
			healthSince([
				{ at: "2026-11-09T10:00:00Z", health: "operational" },
				{ at: "2026-11-09T11:30:00Z", health: "degraded" },
				{ at: "2026-11-09T11:00:00Z", health: "degraded" },
			]),
		).toBe("2026-11-09T11:00:00.000Z");
		expect(healthSince([])).toBeNull();
	});
});
