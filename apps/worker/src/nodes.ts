import { deriveNodeStatus, NODE_OPS_CHANNEL } from "@logistack/contracts";
import { decrypt, nodeLabels, SYSTEM_NODE_LABELS } from "@logistack/core";
import {
	type NodeFacts,
	node,
	nodeJoin,
	organization,
	sshKey,
} from "@logistack/db";
import type { SwarmNode } from "@logistack/docker";
import { RedisClient } from "bun";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import { LEAVE_SCRIPT } from "./node-scripts.ts";
import { runSsh } from "./ssh.ts";

/** Written by the agent gateway (apps/server/src/agent-gateway.ts) on hello and heartbeat. */
const PRESENCE_KEY = (swarmNodeId: string) => `ls:nodes:${swarmNodeId}`;
/** How long a `remove` waits for drained tasks to stop before leaving anyway. */
const DRAIN_GRACE_MS = 120_000;

type Presence = {
	version?: string;
	organizationId?: string;
	lastSeenAt?: string;
};

async function presence(
	redis: RedisClient,
	swarmNodeId: string,
): Promise<Presence | undefined> {
	const raw = await redis.get(PRESENCE_KEY(swarmNodeId));
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as Presence;
	} catch {
		return undefined;
	}
}

const sameLabels = (a: Record<string, string>, b: Record<string, string>) => {
	const ka = Object.keys(a);
	return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

function facts(n: SwarmNode): NodeFacts {
	return {
		cpus: Math.round(n.Description.Resources.NanoCPUs / 1e9),
		memoryBytes: n.Description.Resources.MemoryBytes,
		engineVersion: n.Description.Engine.EngineVersion,
		leader: n.ManagerStatus?.Leader ?? false,
		architecture: n.Description.Platform.Architecture,
	};
}

/** Runs the leave script over the SSH credentials of the wizard run that added the node, if any. */
async function leaveOverSsh(ctx: Ctx, swarmNodeId: string): Promise<void> {
	const [join] = await ctx.db
		.select({
			host: nodeJoin.host,
			port: nodeJoin.port,
			user: nodeJoin.sshUser,
			hostKey: nodeJoin.hostKey,
			key: sshKey.privateKeyEncrypted,
		})
		.from(nodeJoin)
		.innerJoin(sshKey, eq(sshKey.id, nodeJoin.sshKeyId))
		.where(eq(nodeJoin.swarmNodeId, swarmNodeId))
		.limit(1);
	if (!join) return;
	try {
		const res = await runSsh(
			join,
			await decrypt(ctx.masterKey, join.key),
			LEAVE_SCRIPT,
			{ hostKey: join.hostKey, timeoutMs: 60_000 },
		);
		log("info", "node left the swarm", { swarmNodeId, code: res.code });
	} catch (e) {
		log("warn", "node leave over ssh failed", {
			swarmNodeId,
			error: String(e),
		});
	}
}

/**
 * Converges Swarm nodes and `node` rows: observed facts and the installer's system labels flow
 * Docker -> Postgres, user labels and availability flow Postgres -> Docker, and `desired = remove`
 * walks drain -> leave -> rm.
 * Every step is idempotent, so a pass interrupted anywhere is finished by the next one.
 */
export async function syncNodes(ctx: Ctx): Promise<void> {
	const redis = ctx.bus.redis;
	const swarm = await ctx.docker.nodes.list();
	const rows = await ctx.db.select().from(node);
	const bySwarmId = new Map(rows.map((r) => [r.swarmNodeId, r]));
	const [firstOrg] = await ctx.db
		.select({ id: organization.id })
		.from(organization)
		.orderBy(asc(organization.createdAt))
		.limit(1);

	for (const dn of swarm) {
		const seen = await presence(redis, dn.ID);
		let row = bySwarmId.get(dn.ID);
		const observed = {
			hostname: dn.Description.Hostname,
			address: dn.Status.Addr,
			role: dn.Spec.Role,
			facts: facts(dn),
			...(seen?.version && { agentVersion: seen.version }),
			...(seen?.lastSeenAt && { lastSeenAt: new Date(seen.lastSeenAt) }),
		};
		if (!row) {
			const [joined] = await ctx.db
				.select({ organizationId: nodeJoin.organizationId })
				.from(nodeJoin)
				.where(eq(nodeJoin.swarmNodeId, dn.ID))
				.limit(1);
			// shortcut: a node nobody added through LogiStack belongs to the first organization; revisit with multi-tenant clusters.
			const organizationId =
				joined?.organizationId ?? seen?.organizationId ?? firstOrg?.id;
			if (!organizationId) continue;
			[row] = await ctx.db
				.insert(node)
				.values({
					organizationId,
					swarmNodeId: dn.ID,
					labels: dn.Spec.Labels ?? {},
					desired: dn.Spec.Availability === "drain" ? "drain" : "active",
					...observed,
				})
				.onConflictDoNothing()
				.returning();
			if (!row) continue;
		}
		const status = deriveNodeStatus({
			swarmState: dn.Status.State,
			availability: dn.Spec.Availability,
			agentPresent: Boolean(seen),
			agentEverSeen: Boolean(seen ?? row.lastSeenAt),
		});
		const labels = nodeLabels(row.labels, dn.Spec.Labels ?? {});
		const system = nodeLabels({}, labels);
		await ctx.db
			.update(node)
			.set({
				...observed,
				status,
				// Rewrites only the system keys, so an API edit of the user labels since `rows` survives.
				labels: sql`(${node.labels} - ${`{${SYSTEM_NODE_LABELS.join(",")}}`}::text[]) || ${JSON.stringify(system)}::jsonb`,
			})
			.where(eq(node.id, row.id));

		if (row.desired === "remove") {
			await removeStep(ctx, row, dn);
			continue;
		}
		const want = {
			...dn.Spec,
			Labels: labels,
			Availability: row.desired,
		};
		if (
			want.Availability !== dn.Spec.Availability ||
			!sameLabels(want.Labels, dn.Spec.Labels ?? {})
		) {
			await ctx.docker.nodes.update(dn.ID, dn.Version.Index, want);
			log("info", "node spec applied", {
				node: dn.ID,
				availability: want.Availability,
			});
		}
	}

	const present = new Set(swarm.map((n) => n.ID));
	for (const r of rows) {
		if (present.has(r.swarmNodeId)) continue;
		if (r.desired === "remove")
			await ctx.db.delete(node).where(eq(node.id, r.id));
		else if (r.status !== "down")
			await ctx.db
				.update(node)
				.set({ status: "down" })
				.where(eq(node.id, r.id));
	}
}

async function removeStep(
	ctx: Ctx,
	row: typeof node.$inferSelect,
	dn: SwarmNode,
): Promise<void> {
	const info = await ctx.docker.info();
	if (dn.ID === info.Swarm.NodeID || dn.ManagerStatus?.Leader) {
		log("warn", "refusing to remove the manager LogiStack runs on", {
			node: dn.ID,
		});
		await ctx.db
			.update(node)
			.set({ desired: "active" })
			.where(eq(node.id, row.id));
		return;
	}
	if (dn.Spec.Availability !== "drain" || dn.Spec.Role === "manager") {
		await ctx.docker.nodes.update(dn.ID, dn.Version.Index, {
			...dn.Spec,
			Role: "worker",
			Availability: "drain",
		});
		return;
	}
	const running = await ctx.docker.tasks.list({
		node: [dn.ID],
		"desired-state": ["running"],
	});
	// The first pass that sees the node drained starts the grace clock.
	const key = `ls:nodes:removing:${dn.ID}`;
	await ctx.bus.redis.send("SET", [
		key,
		String(Date.now()),
		"NX",
		"EX",
		"3600",
	]);
	const since = Number(await ctx.bus.redis.get(key));
	if (running.length > 0 && Date.now() - since < DRAIN_GRACE_MS) return;
	if (dn.Status.State === "ready") await leaveOverSsh(ctx, dn.ID);
	await ctx.docker.nodes.remove(dn.ID, true);
	await ctx.db.delete(node).where(eq(node.id, row.id));
	await ctx.bus.redis.del(key);
	await ctx.db
		.update(nodeJoin)
		.set({ nodeId: null })
		.where(and(eq(nodeJoin.swarmNodeId, dn.ID), isNotNull(nodeJoin.nodeId)));
	log("info", "node removed", { node: dn.ID });
}

/** Calls `fn` whenever the server pokes `ls:node-ops`. Returns an unsubscribe. */
export async function onNodeOps(
	url: string,
	fn: () => void,
): Promise<() => void> {
	const sub = new RedisClient(url);
	await sub.subscribe(NODE_OPS_CHANNEL, () => fn());
	return () => sub.close();
}
