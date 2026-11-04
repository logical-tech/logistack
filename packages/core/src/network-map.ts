import type {
	DomainStatus,
	MapEdge,
	MapNode,
	NetworkMap,
	ObservedState,
	ServiceKind,
	ServiceSpec,
	TlsMode,
} from "@logistack/contracts";

type Scope = {
	projectId: string;
	projectName: string;
	environmentId: string;
	environmentName: string;
};

export type NetworkMapInput = {
	services: (Scope & {
		id: string;
		name: string;
		kind: ServiceKind;
		icon: string | null;
		spec: ServiceSpec;
		status: {
			observed: ObservedState;
			replicasRunning: number;
			replicasDesired: number;
		} | null;
		tasks: {
			id: string;
			slot: number | null;
			/** Swarm node id. */
			nodeId: string | null;
			state: string;
			error: string | null;
		}[];
	})[];
	domains: {
		id: string;
		serviceId: string;
		hostname: string;
		pathPrefix: string | null;
		tls: TlsMode;
		tunnel: boolean;
		dnsProviderId: string | null;
		status: DomainStatus;
	}[];
	/** DNS provider id to name, for tunnel labels. */
	providers: Map<string, string>;
	nodes: { id: string; swarmNodeId: string; hostname: string }[];
};

export const INTERNET = "internet";
export const PROXY = "proxy";

/** Internet → proxy or tunnel → domain → service → task, plus published ports straight to the service. */
export function networkMap(input: NetworkMapInput): NetworkMap {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const edge = (source: string, target: string, via: MapEdge["via"]) =>
		edges.push({ id: `${source}->${target}`, source, target, via });
	const services = [...input.services].sort(
		(a, b) =>
			a.projectName.localeCompare(b.projectName) ||
			a.environmentName.localeCompare(b.environmentName) ||
			a.name.localeCompare(b.name),
	);
	const byId = new Map(services.map((s) => [s.id, s]));
	const hosts = new Map(input.nodes.map((n) => [n.swarmNodeId, n]));
	let proxied = false;
	const tunnels = new Set<string>();
	const exposed = new Set<string>();

	for (const s of services) {
		const scope = {
			projectId: s.projectId,
			projectName: s.projectName,
			environmentId: s.environmentId,
			environmentName: s.environmentName,
		};
		const ports =
			s.spec.kind === "application"
				? s.spec.ports.flatMap((p) =>
						p.published
							? [
									{
										published: p.published,
										target: p.target,
										protocol: p.protocol,
									},
								]
							: [],
					)
				: [];
		nodes.push({
			type: "service",
			id: `service:${s.id}`,
			serviceId: s.id,
			name: s.name,
			kind: s.kind,
			icon: s.icon,
			status: s.status?.observed ?? "unknown",
			replicasRunning: s.status?.replicasRunning ?? 0,
			replicasDesired: s.status?.replicasDesired ?? 0,
			ports,
			mounts: s.spec.kind === "application" ? (s.spec.mounts?.length ?? 0) : 0,
			...scope,
		});
		if (ports.length) {
			exposed.add(s.id);
			edge(INTERNET, `service:${s.id}`, "port");
		}
		for (const t of s.tasks) {
			const host = t.nodeId ? hosts.get(t.nodeId) : undefined;
			nodes.push({
				type: "task",
				id: `task:${t.id}`,
				serviceId: s.id,
				slot: t.slot,
				state: t.state,
				error: t.error,
				nodeId: host?.id ?? null,
				hostname: host?.hostname ?? null,
				...scope,
			});
			edge(`service:${s.id}`, `task:${t.id}`, "internal");
		}
	}

	for (const d of [...input.domains].sort((a, b) =>
		a.hostname.localeCompare(b.hostname),
	)) {
		const s = byId.get(d.serviceId);
		if (!s) continue;
		const id = `domain:${d.id}`;
		nodes.push({
			type: "domain",
			id,
			domainId: d.id,
			serviceId: d.serviceId,
			hostname: d.hostname,
			pathPrefix: d.pathPrefix,
			tls: d.tls,
			tunnel: d.tunnel,
			status: d.status,
			projectId: s.projectId,
			projectName: s.projectName,
			environmentId: s.environmentId,
			environmentName: s.environmentName,
		});
		const via = d.tunnel ? "tunnel" : "proxy";
		if (d.tunnel) {
			const t = `tunnel:${d.dnsProviderId ?? "unknown"}`;
			tunnels.add(d.dnsProviderId ?? "unknown");
			edge(t, id, via);
		} else {
			proxied = true;
			edge(PROXY, id, via);
		}
		edge(id, `service:${s.id}`, via);
	}

	const edgeNodes: MapNode[] = [];
	if (proxied || tunnels.size || exposed.size)
		edgeNodes.push({ type: "internet", id: INTERNET });
	if (proxied) {
		edgeNodes.push({ type: "proxy", id: PROXY });
		edges.unshift({
			id: `${INTERNET}->${PROXY}`,
			source: INTERNET,
			target: PROXY,
			via: "proxy",
		});
	}
	for (const p of tunnels) {
		const id = `tunnel:${p}`;
		edgeNodes.push({
			type: "tunnel",
			id,
			dnsProviderId: p,
			name: input.providers.get(p) ?? "Cloudflare Tunnel",
		});
		edges.unshift({
			id: `${INTERNET}->${id}`,
			source: INTERNET,
			target: id,
			via: "tunnel",
		});
	}
	return { nodes: [...edgeNodes, ...nodes], edges };
}

export type MapFilter = {
	projectId?: string;
	environmentId?: string;
	/** Matches service, project and environment names, domain hostnames and node hostnames. */
	query?: string;
};

/** The part of the map a filter keeps: matching services with everything that reaches or runs them. */
export function filterNetworkMap(map: NetworkMap, f: MapFilter): NetworkMap {
	const q = f.query?.trim().toLowerCase();
	const inScope = (n: MapNode) =>
		"projectId" in n &&
		(!f.projectId || n.projectId === f.projectId) &&
		(!f.environmentId || n.environmentId === f.environmentId);
	const services = new Set<string>();
	for (const n of map.nodes) {
		if (!inScope(n) || !("serviceId" in n)) continue;
		const own =
			n.type === "service"
				? n.name
				: n.type === "domain"
					? n.hostname
					: n.type === "task"
						? (n.hostname ?? "")
						: "";
		const text = `${own}\n${n.projectName}\n${n.environmentName}`;
		if (!q || text.toLowerCase().includes(q)) services.add(n.serviceId);
	}
	const keep = new Set(
		map.nodes
			.filter((n) => "serviceId" in n && services.has(n.serviceId))
			.map((n) => n.id),
	);
	// Edge nodes stay when they lead somewhere kept: tunnels and proxy first, then the internet.
	for (const pass of [
		["tunnel", "proxy"],
		["internet"],
	] as MapNode["type"][][]) {
		const ids = new Set(
			map.nodes.filter((n) => pass.includes(n.type)).map((n) => n.id),
		);
		for (const e of map.edges)
			if (ids.has(e.source) && keep.has(e.target)) keep.add(e.source);
	}
	return {
		nodes: map.nodes.filter((n) => keep.has(n.id)),
		edges: map.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
	};
}
