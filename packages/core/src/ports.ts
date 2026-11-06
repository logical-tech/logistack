import {
	type GameKind,
	gamePorts,
	type PortMapping,
	primaryPort,
} from "@logistack/contracts";

/** A service's published ports and the node it is pinned to (null: Swarm may place it anywhere). */
export type PortHolder = {
	id: string;
	nodeId: string | null;
	ports: PortMapping[];
};

export type PortConflict = {
	port: number;
	protocol: PortMapping["protocol"];
	/** Id of the other holder; equal to the candidate's for a duplicate inside one service. */
	holderId: string;
};

const clash = (
	a: PortHolder,
	b: PortHolder,
	pa: PortMapping,
	pb: PortMapping,
) =>
	pa.published === pb.published &&
	pa.protocol === pb.protocol &&
	// The routing mesh binds an ingress port on every node; host ports clash only on a shared node.
	((pa.mode ?? "host") === "ingress" ||
		(pb.mode ?? "host") === "ingress" ||
		a.nodeId === null ||
		b.nodeId === null ||
		a.nodeId === b.nodeId);

/** Published ports of `candidate` that another holder (or the candidate itself) already binds. */
export function publishedPortConflicts(
	candidate: PortHolder,
	others: PortHolder[],
): PortConflict[] {
	const mine = candidate.ports.filter((p) => p.published);
	const conflicts: PortConflict[] = [];
	mine.forEach((p, i) => {
		const dupe = mine
			.slice(0, i)
			.some((q) => q.published === p.published && q.protocol === p.protocol);
		const other = others.find(
			(o) =>
				o.id !== candidate.id &&
				o.ports.some((q) => q.published && clash(candidate, o, p, q)),
		);
		const holderId = dupe ? candidate.id : other?.id;
		if (holderId)
			conflicts.push({
				port: p.published as number,
				protocol: p.protocol,
				holderId,
			});
	});
	return conflicts;
}

/** Caddy holds these on every ingress node (install/stack.yml). */
export const ingressPortHolder: PortHolder = {
	id: "ingress",
	nodeId: null,
	ports: [
		{ target: 80, published: 80, protocol: "tcp" },
		{ target: 443, published: 443, protocol: "tcp" },
		{ target: 443, published: 443, protocol: "udp" },
	],
};

/**
 * The first primary port from the game's default upward whose derived ports (`gamePorts`) no
 * holder publishes on `nodeId`; null when the range runs out.
 */
export function suggestGamePort(
	settings: { game: GameKind; geyser?: boolean },
	nodeId: string | null,
	holders: PortHolder[],
	serviceId = "",
): number | null {
	const start = primaryPort(settings.game);
	for (let port = start; port < start + 1000; port++) {
		const ports = gamePorts(settings, port);
		if (ports.some((p) => p.published > 65535)) return null;
		const candidate = { id: serviceId, nodeId, ports };
		if (!publishedPortConflicts(candidate, holders).length) return port;
	}
	return null;
}
