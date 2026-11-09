import { z } from "zod";
import { DomainStatus, ObservedState, ServiceKind } from "./enums.ts";

/** Where a node sits in the hierarchy; edge nodes (internet, proxy, tunnels) have none. */
const Scope = z.object({
	projectId: z.string(),
	projectName: z.string(),
	environmentId: z.string(),
	environmentName: z.string(),
	/** The project's folders, outermost first; empty at the root. */
	folders: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});

export const TlsMode = z.enum(["http-01", "dns-01", "custom", "none"]);
export type TlsMode = z.infer<typeof TlsMode>;

export const MapNode = z.discriminatedUnion("type", [
	z.object({ type: z.literal("internet"), id: z.string() }),
	z.object({ type: z.literal("proxy"), id: z.string() }),
	/** Swarm's ingress routing mesh, which carries published ports to any replica. */
	z.object({ type: z.literal("mesh"), id: z.string() }),
	z.object({
		type: z.literal("tunnel"),
		id: z.string(),
		dnsProviderId: z.string(),
		name: z.string(),
	}),
	z.object({
		type: z.literal("domain"),
		id: z.string(),
		domainId: z.string(),
		serviceId: z.string(),
		hostname: z.string(),
		pathPrefix: z.string().nullable(),
		tls: TlsMode,
		tunnel: z.boolean(),
		status: DomainStatus,
		...Scope.shape,
	}),
	z.object({
		type: z.literal("service"),
		id: z.string(),
		serviceId: z.string(),
		name: z.string(),
		kind: ServiceKind,
		icon: z.string().nullable(),
		status: ObservedState,
		replicasRunning: z.int(),
		replicasDesired: z.int(),
		/** Ports published on the nodes, bypassing the proxy. */
		ports: z.array(
			z.object({
				published: z.int(),
				target: z.int(),
				protocol: z.enum(["tcp", "udp"]),
			}),
		),
		mounts: z.int(),
		...Scope.shape,
	}),
	z.object({
		type: z.literal("task"),
		id: z.string(),
		serviceId: z.string(),
		slot: z.number().nullable(),
		state: z.string(),
		error: z.string().nullable(),
		/** LogiStack node id, for linking; null when the Swarm node is not enrolled. */
		nodeId: z.string().nullable(),
		hostname: z.string().nullable(),
		...Scope.shape,
	}),
]);
export type MapNode = z.infer<typeof MapNode>;

export const MapEdge = z.object({
	id: z.string(),
	source: z.string(),
	target: z.string(),
	/** `tunnel` through Cloudflare, `port` a published port bypassing the proxy. */
	via: z.enum(["proxy", "tunnel", "port", "internal"]),
});
export type MapEdge = z.infer<typeof MapEdge>;

export const NetworkMap = z.object({
	nodes: z.array(MapNode),
	edges: z.array(MapEdge),
});
export type NetworkMap = z.infer<typeof NetworkMap>;
