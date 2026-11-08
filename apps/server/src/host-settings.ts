import {
	gamePorts,
	type PortMapping,
	type ServiceSpec,
} from "@logistack/contracts";
import {
	ingressPortHolder,
	type PortHolder,
	publishedPortConflicts,
} from "@logistack/core";
import { databaseAccess, node, service } from "@logistack/db";
import { eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "./actor.ts";
import type { Env } from "./env.ts";
import { Failure, notFound } from "./errors.ts";
import { check } from "./scope.ts";

// Docker grants these to every container already, so adding them changes nothing.
const DEFAULT_CAPS = new Set([
	"AUDIT_WRITE",
	"CHOWN",
	"DAC_OVERRIDE",
	"FOWNER",
	"FSETID",
	"KILL",
	"MKNOD",
	"NET_BIND_SERVICE",
	"NET_RAW",
	"SETFCAP",
	"SETGID",
	"SETPCAP",
	"SETUID",
	"SYS_CHROOT",
]);

/** Settings that reach the host (bind mounts, extra capabilities): changing them needs admin. */
const hostKey = (spec: ServiceSpec | undefined) => {
	const app = spec?.kind === "application" ? spec : undefined;
	return JSON.stringify([
		(app?.mounts ?? []).map((m) => [
			m.hostPath,
			m.target,
			m.readOnly ?? false,
			m.allowSensitiveHostPath ?? false,
		]),
		(app?.capAdd ?? [])
			.map((cap) => cap.toUpperCase().replace(/^CAP_/, ""))
			.filter((cap) => !DEFAULT_CAPS.has(cap))
			.sort(),
	]);
};

/** The node a pinned service lands on: the requested one, else the only node, else the only manager. */
async function pinNode(
	c: Context<Env>,
	organizationId: string,
	requested: string | undefined,
): Promise<string | null> {
	const nodes = await c.var.deps.db
		.select({ id: node.id, role: node.role })
		.from(node)
		.where(eq(node.organizationId, organizationId));
	if (requested) {
		if (!nodes.some((n) => n.id === requested)) throw notFound("node");
		return requested;
	}
	// No node rows yet: the worker pins to its own node on the first deploy.
	if (nodes.length === 0) return null;
	const managers = nodes.filter((n) => n.role === "manager");
	const only = nodes.length === 1 ? nodes : managers;
	if (only.length === 1) return only[0]?.id ?? null;
	throw new Failure(
		"bad_request",
		"this service needs nodeId: its host paths or ports exist on one node",
	);
}

/** Ports a spec publishes on its node: an application's own, a game server's derived ones. */
export const publishedPorts = (spec: ServiceSpec): PortMapping[] =>
	spec.kind === "application"
		? spec.ports
		: spec.kind === "game"
			? gamePorts(spec.settings, spec.port)
			: [];

/**
 * Checks bind mounts and non-default capabilities (admin only), the pinned node and published-port conflicts before a
 * spec is written. Returns the node id to store, or undefined to leave it as it is.
 */
export async function guardHostSettings(
	c: Context<Env>,
	o: {
		serviceId?: string;
		spec: ServiceSpec;
		before?: ServiceSpec;
		nodeId: string | null;
		requestedNodeId?: string;
	},
): Promise<string | null | undefined> {
	if (o.spec.kind === "game") {
		// Players dial one node's address and the world lives there: a game server is always pinned.
		const nodeId =
			o.nodeId && !o.requestedNodeId
				? o.nodeId
				: await pinNode(c, requireActor(c).organizationId, o.requestedNodeId);
		await checkPorts(c, o.serviceId, nodeId, publishedPorts(o.spec));
		return nodeId === o.nodeId ? undefined : nodeId;
	}
	if (o.spec.kind !== "application") return undefined;
	const resource = c.get("resource");
	if (hostKey(o.spec) !== hostKey(o.before)) {
		// A git push has no one to authorize it: an admin applies host-level changes by hand.
		if (!resource)
			throw new Failure(
				"forbidden",
				"bind mounts and extra capabilities need an admin to apply them",
			);
		check(c, "admin", resource);
	}

	let nodeId = o.nodeId;
	let pinned: string | null | undefined;
	if (o.spec.mounts?.length && (!nodeId || o.requestedNodeId)) {
		pinned = await pinNode(
			c,
			requireActor(c).organizationId,
			o.requestedNodeId,
		);
		nodeId = pinned;
	}

	await checkPorts(c, o.serviceId, nodeId, o.spec.ports);
	return pinned;
}

/** Every service publishing ports, as port holders: applications and game servers. */
export async function portHolders(c: Context<Env>): Promise<PortHolder[]> {
	const rows = await c.var.deps.db
		.select({ id: service.id, nodeId: service.nodeId, spec: service.spec })
		.from(service)
		.where(inArray(service.kind, ["application", "game"]));
	// Database gateways hold a host port on the database's node (docs/plans/database-ops.md).
	const gateways = await c.var.deps.db
		.select({
			id: databaseAccess.id,
			nodeId: service.nodeId,
			port: databaseAccess.port,
		})
		.from(databaseAccess)
		.innerJoin(service, eq(service.id, databaseAccess.serviceId));
	return [
		...rows.map((r) => ({
			id: r.id,
			nodeId: r.nodeId,
			ports: publishedPorts(r.spec),
		})),
		...gateways.map((g) => ({
			id: g.id,
			nodeId: g.nodeId,
			ports: [
				{
					target: g.port,
					published: g.port,
					protocol: "tcp" as const,
					mode: "host" as const,
				},
			],
		})),
	];
}

/** Refuses ports another service (or Caddy) already publishes where this one would. */
async function checkPorts(
	c: Context<Env>,
	serviceId: string | undefined,
	nodeId: string | null,
	ports: PortMapping[],
) {
	if (!ports.some((p) => p.published)) return;
	const [conflict] = publishedPortConflicts(
		{ id: serviceId ?? "", nodeId, ports },
		[...(await portHolders(c)), ingressPortHolder],
	);
	if (!conflict) return;
	const holder =
		conflict.holderId === ingressPortHolder.id
			? "the LogiStack ingress (Caddy)"
			: conflict.holderId === serviceId || conflict.holderId === ""
				? "this service twice"
				: "another service";
	throw new Failure(
		"conflict",
		`port ${conflict.port}/${conflict.protocol} is already published by ${holder}`,
		{ port: conflict.port, protocol: conflict.protocol },
	);
}
