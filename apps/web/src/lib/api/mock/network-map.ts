import type { NetworkMap } from "@logistack/contracts";
import { networkMap } from "@logistack/core/network-map";
import { createMockDb } from "./fixtures";

const NODES = [
	{ id: "nod_mock1", swarmNodeId: "swarm1", hostname: "fra-1" },
	{ id: "nod_mock2", swarmNodeId: "swarm2", hostname: "fra-2" },
];

/** The fixture org as a map: every third domain goes through a tunnel, tasks spread over two nodes. */
export async function mockNetworkMap(): Promise<NetworkMap> {
	const db = createMockDb();
	const env = new Map(db.environments.map((e) => [e.id, e]));
	const prj = new Map(db.projects.map((p) => [p.id, p]));
	const fld = new Map(db.folders.map((f) => [f.id, f]));
	const path = (id: string | null) => {
		const f = id ? fld.get(id) : undefined;
		const up = f?.parentId ? fld.get(f.parentId) : undefined;
		return [up, f].flatMap((x) => (x ? [{ id: x.id, name: x.name }] : []));
	};
	let n = 0;
	const services = db.services.flatMap((s) => {
		const e = env.get(s.environmentId);
		const p = e && prj.get(e.projectId);
		if (!e || !p) return [];
		return [
			{
				id: s.id,
				name: s.name,
				kind: s.kind,
				icon: null,
				spec: s.spec,
				status: s.status,
				tasks: Array.from({ length: s.status.replicasRunning }, (_, i) => ({
					id: `${s.id}_t${i}`,
					slot: i + 1,
					nodeId: NODES[n++ % NODES.length]?.swarmNodeId ?? null,
					state: s.status.observed === "starting" ? "preparing" : "running",
					error: null,
				})),
				projectId: p.id,
				projectName: p.name,
				environmentId: e.id,
				environmentName: e.name,
				folders: path(p.folderId),
			},
		];
	});
	let d = 0;
	const domains = db.services.flatMap((s) =>
		(s.domains ?? []).map((hostname: string) => {
			const tunnel = d++ % 3 === 2;
			return {
				id: `dom_${d}`,
				serviceId: s.id,
				hostname,
				pathPrefix: null,
				tls: tunnel ? ("dns-01" as const) : ("http-01" as const),
				tunnel,
				dnsProviderId: tunnel ? "dns_cf" : null,
				status: "active" as const,
			};
		}),
	);
	await new Promise((r) => setTimeout(r, 300));
	return networkMap({
		services,
		domains,
		providers: new Map([["dns_cf", "Cloudflare"]]),
		nodes: NODES,
	});
}
