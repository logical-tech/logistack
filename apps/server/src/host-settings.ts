import type { ServiceSpec } from "@logistack/contracts";
import { ingressPortHolder, publishedPortConflicts } from "@logistack/core";
import { node, service } from "@logistack/db";
import { eq } from "drizzle-orm";
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
		"a service with bind mounts needs nodeId: the host paths exist on one node",
	);
}

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

	if (o.spec.ports.some((p) => p.published)) {
		const rows = await c.var.deps.db
			.select({ id: service.id, nodeId: service.nodeId, spec: service.spec })
			.from(service)
			.where(eq(service.kind, "application"));
		const holders = rows.map((r) => ({
			id: r.id,
			nodeId: r.nodeId,
			ports: r.spec.kind === "application" ? r.spec.ports : [],
		}));
		const [conflict] = publishedPortConflicts(
			{ id: o.serviceId ?? "", nodeId, ports: o.spec.ports },
			[...holders, ingressPortHolder],
		);
		if (conflict) {
			const holder =
				conflict.holderId === ingressPortHolder.id
					? "the LogiStack ingress (Caddy)"
					: conflict.holderId === o.serviceId || conflict.holderId === ""
						? "this service twice"
						: "another service";
			throw new Failure(
				"conflict",
				`port ${conflict.port}/${conflict.protocol} is already published by ${holder}`,
				{ port: conflict.port, protocol: conflict.protocol },
			);
		}
	}
	return pinned;
}
