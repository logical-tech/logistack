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

/** Technitium's per-client blocking app; its config is the JSON this compiler writes. */
export const ADVANCED_BLOCKING_APP = {
	name: "Advanced Blocking",
	classPath: "AdvancedBlocking.App",
} as const;

type Blocking = { listUrls: string[]; blocked: string[] };
type PersonRules = { id: string; blocking: Blocking };
type DeviceRules = {
	id: string;
	address: string;
	personId: string | null;
	blocking: Blocking;
};

/** The group every client without rules of its own falls in: it adds nothing to the house's lists. */
export const EVERYONE_GROUP = "everyone";

const merged = (...b: (Blocking | undefined)[]): Blocking => ({
	listUrls: [...new Set(b.flatMap((x) => x?.listUrls ?? []))].sort(),
	blocked: [...new Set(b.flatMap((x) => x?.blocked ?? []))].sort(),
});
const empty = (b: Blocking) => !b.listUrls.length && !b.blocked.length;

function group(name: string, b: Blocking) {
	return {
		name,
		enableBlocking: true,
		allowTxtBlockingReport: true,
		blockAsNxDomain: true,
		blockingAddresses: ["0.0.0.0", "::"],
		allowed: [] as string[],
		blocked: b.blocked,
		allowListUrls: [] as string[],
		blockListUrls: b.listUrls,
		allowedRegex: [] as string[],
		blockedRegex: [] as string[],
		regexAllowListUrls: [] as string[],
		regexBlockListUrls: [] as string[],
		adblockListUrls: [] as string[],
	};
}

/**
 * Pure: the Advanced Blocking config for people and devices. A device with rules of its own gets
 * its group (its rules plus its person's); a device with none shares its person's group; the rest
 * are `everyone`. The house's lists stay in Technitium's own blocking, which runs for everyone, so
 * these groups only add. `needed` is false when nobody blocks more: the app need not be installed.
 */
export function compileAdvancedBlocking(
	people: PersonRules[],
	devices: DeviceRules[],
) {
	const personOf = new Map(people.map((p) => [p.id, p]));
	const groups = new Map<string, Blocking>();
	const networkGroupMap: Record<string, string> = {};
	for (const d of [...devices].sort((a, b) =>
		a.address.localeCompare(b.address),
	)) {
		const person = d.personId ? personOf.get(d.personId) : undefined;
		const rules = merged(person?.blocking, d.blocking);
		if (empty(rules)) continue;
		const name =
			empty(d.blocking) && person ? `person-${person.id}` : `device-${d.id}`;
		groups.set(name, rules);
		networkGroupMap[d.address] = name;
	}
	networkGroupMap["0.0.0.0/0"] = EVERYONE_GROUP;
	networkGroupMap["[::]/0"] = EVERYONE_GROUP;
	return {
		needed: groups.size > 0,
		config: {
			enableBlocking: groups.size > 0,
			blockingAnswerTtl: 30,
			blockListUrlUpdateIntervalHours: 24,
			blockListUrlUpdateIntervalMinutes: 0,
			localEndPointGroupMap: {},
			networkGroupMap,
			groups: [
				group(EVERYONE_GROUP, { listUrls: [], blocked: [] }),
				...[...groups.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, b]) => group(name, b)),
			],
		},
	};
}
