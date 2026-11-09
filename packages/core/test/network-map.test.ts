import { describe, expect, test } from "bun:test";
import type { ServiceSpec } from "@logistack/contracts";
import {
	filterNetworkMap,
	type NetworkMapInput,
	networkMap,
} from "../src/network-map.ts";

const app = (ports: { target: number; published?: number }[]): ServiceSpec => ({
	kind: "application",
	source: { type: "image", image: "nginx:1" },
	build: { type: "image" },
	ports: ports.map((p) => ({ ...p, protocol: "tcp" as const })),
	replicas: 1,
	resources: {},
	placement: [],
});

const scope = (p: string, e: string) => ({
	projectId: `prj_${p}`,
	projectName: p,
	environmentId: `env_${p}_${e}`,
	environmentName: e,
});

const input: NetworkMapInput = {
	services: [
		{
			id: "svc_web",
			name: "web",
			kind: "application",
			icon: "nginx",
			spec: app([{ target: 80 }]),
			status: { observed: "running", replicasRunning: 1, replicasDesired: 1 },
			tasks: [
				{
					id: "t1",
					slot: 1,
					nodeId: "swarm1",
					state: "running",
					error: null,
				},
			],
			...scope("shop", "production"),
			folders: [{ id: "fld_clients", name: "Clients" }],
		},
		{
			id: "svc_mqtt",
			name: "mqtt",
			kind: "application",
			icon: null,
			spec: app([{ target: 1883, published: 1883 }]),
			status: null,
			tasks: [],
			...scope("iot", "production"),
		},
		{
			id: "svc_admin",
			name: "admin",
			kind: "application",
			icon: null,
			spec: app([]),
			status: { observed: "failed", replicasRunning: 0, replicasDesired: 1 },
			tasks: [],
			...scope("shop", "staging"),
		},
	],
	domains: [
		{
			id: "dom_web",
			serviceId: "svc_web",
			hostname: "shop.example.com",
			pathPrefix: null,
			tls: "http-01",
			tunnel: false,
			dnsProviderId: null,
			status: "active",
		},
		{
			id: "dom_admin",
			serviceId: "svc_admin",
			hostname: "admin.example.com",
			pathPrefix: null,
			tls: "dns-01",
			tunnel: true,
			dnsProviderId: "dns_cf",
			status: "pending",
		},
		{
			id: "dom_gone",
			serviceId: "svc_hidden",
			hostname: "hidden.example.com",
			pathPrefix: null,
			tls: "none",
			tunnel: false,
			dnsProviderId: null,
			status: "active",
		},
	],
	providers: new Map([["dns_cf", "Cloudflare"]]),
	nodes: [{ id: "nod_1", swarmNodeId: "swarm1", hostname: "node-1" }],
};

const ids = (m: { nodes: { id: string }[] }) => m.nodes.map((n) => n.id).sort();

describe("networkMap", () => {
	const map = networkMap(input);

	test("draws every path from the internet to the tasks", () => {
		expect(ids(map)).toEqual(
			[
				"internet",
				"proxy",
				"mesh",
				"tunnel:dns_cf",
				"domain:dom_web",
				"domain:dom_admin",
				"service:svc_web",
				"service:svc_mqtt",
				"service:svc_admin",
				"task:t1",
			].sort(),
		);
		const e = (s: string, t: string) =>
			map.edges.find((x) => x.source === s && x.target === t)?.via;
		expect(e("internet", "proxy")).toBe("proxy");
		expect(e("proxy", "domain:dom_web")).toBe("proxy");
		expect(e("internet", "tunnel:dns_cf")).toBe("tunnel");
		expect(e("tunnel:dns_cf", "domain:dom_admin")).toBe("tunnel");
		expect(e("domain:dom_admin", "service:svc_admin")).toBe("tunnel");
		expect(e("internet", "mesh")).toBe("port");
		expect(e("mesh", "service:svc_mqtt")).toBe("port");
		expect(e("service:svc_web", "task:t1")).toBe("internal");
	});

	test("resolves hosts, ports, status and drops domains of unseen services", () => {
		const task = map.nodes.find((n) => n.id === "task:t1");
		expect(task).toMatchObject({ nodeId: "nod_1", hostname: "node-1" });
		const mqtt = map.nodes.find((n) => n.id === "service:svc_mqtt");
		expect(mqtt).toMatchObject({
			status: "unknown",
			ports: [{ published: 1883, target: 1883, protocol: "tcp" }],
		});
		expect(map.nodes.find((n) => n.id === "tunnel:dns_cf")).toMatchObject({
			name: "Cloudflare",
		});
		expect(map.edges.every((e) => !e.target.includes("dom_gone"))).toBe(true);
	});

	test("an empty organization has no edge nodes", () => {
		expect(networkMap({ ...input, services: [], domains: [] }).nodes).toEqual(
			[],
		);
	});
});

describe("filterNetworkMap", () => {
	const map = networkMap(input);

	test("an environment keeps only the edge nodes leading into it", () => {
		const m = filterNetworkMap(map, { environmentId: "env_shop_staging" });
		expect(ids(m)).toEqual(
			[
				"internet",
				"tunnel:dns_cf",
				"domain:dom_admin",
				"service:svc_admin",
			].sort(),
		);
		expect(m.edges).toHaveLength(3);
	});

	test("search matches hostnames and keeps the whole service", () => {
		const m = filterNetworkMap(map, { query: "SHOP.example" });
		expect(ids(m)).toEqual(
			[
				"internet",
				"proxy",
				"domain:dom_web",
				"service:svc_web",
				"task:t1",
			].sort(),
		);
		expect(ids(filterNetworkMap(map, { query: "node-1" }))).toContain(
			"service:svc_web",
		);
		expect(ids(filterNetworkMap(map, { query: "iot" }))).toEqual(
			["internet", "mesh", "service:svc_mqtt"].sort(),
		);
		expect(ids(filterNetworkMap(map, { query: "clients" }))).toContain(
			"service:svc_web",
		);
	});

	test("a project with nothing matching is empty", () => {
		expect(
			filterNetworkMap(map, { projectId: "prj_iot", query: "shop" }).nodes,
		).toEqual([]);
	});
});
