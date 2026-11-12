import type { HomeDnsStatus } from "@logistack/contracts";

/** What one worker pass observed, in the order it observes them. */
export type HomeDnsEvent =
	/** The Swarm service was created or its spec changed. */
	| "deployed"
	/** Technitium's HTTP API answered. */
	| "api_up"
	/** Token, settings, zone and a real query on port 53 all succeeded. */
	| "configured"
	| "fail"
	| "stop";

const table: Record<
	HomeDnsStatus,
	Partial<Record<HomeDnsEvent, HomeDnsStatus>>
> = {
	stopped: { deployed: "starting" },
	starting: {
		deployed: "starting",
		api_up: "configuring",
		fail: "error",
		stop: "stopped",
	},
	configuring: {
		deployed: "starting",
		api_up: "configuring",
		configured: "ready",
		fail: "error",
		stop: "stopped",
	},
	ready: {
		deployed: "starting",
		api_up: "ready",
		configured: "ready",
		fail: "error",
		stop: "stopped",
	},
	// Only a full success or a stop leaves `error`, so every firing alert gets its resolution.
	error: { configured: "ready", fail: "error", stop: "stopped" },
};

/** The next status; an event the current status does not take leaves it unchanged. */
export const advanceHomeDns = (
	status: HomeDnsStatus,
	event: HomeDnsEvent,
): HomeDnsStatus => table[status][event] ?? status;

/** The `network.dns.unhealthy` state to announce for a status change, if any. */
export function homeDnsAlert(
	from: HomeDnsStatus,
	to: HomeDnsStatus,
): "firing" | "resolved" | null {
	if (from !== "error" && to === "error") return "firing";
	if (from === "error" && to !== "error") return "resolved";
	return null;
}
