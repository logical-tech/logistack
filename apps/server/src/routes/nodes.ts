import { createRoute, z } from "@hono/zod-openapi";
import {
	LiveHostSample,
	NodeJoin,
	NodeJoinInput,
	NodeJoinStep,
	NodeUpdate,
	NodeView,
} from "@logistack/contracts";
import { nodeLabels } from "@logistack/core";
import { type Db, node, nodeJoin, sshKey } from "@logistack/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, notFound, one } from "../errors.ts";
import { live } from "../live.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { inOrganization, requirePermission } from "../scope.ts";

const tags = ["nodes"];

/** Same keys as the agent gateway and the worker's metrics consumer. */
const PRESENCE_KEY = (id: string) => `ls:nodes:${id}`;
const LAST_SAMPLE_KEY = (id: string) => `ls:metrics:last:${id}`;

type NodeRow = typeof node.$inferSelect;

function parse<T>(
	raw: string | null | undefined,
	schema?: z.ZodType<T>,
): T | undefined {
	if (!raw) return undefined;
	try {
		const v = JSON.parse(raw);
		return schema ? schema.safeParse(v).data : (v as T);
	} catch {
		return undefined;
	}
}

/** DB rows overlaid with what Redis knows right now: agent presence and the latest sample. */
async function views(redisUrl: string, rows: NodeRow[]): Promise<NodeView[]> {
	if (!rows.length) return [];
	const { redis } = await live(redisUrl);
	const keys = rows.flatMap((r) => [
		PRESENCE_KEY(r.swarmNodeId),
		LAST_SAMPLE_KEY(r.swarmNodeId),
	]);
	const values = (await redis.send("MGET", keys)) as (string | null)[];
	return rows.map((r, i) => {
		const presence = parse<{ version?: string; lastSeenAt?: string }>(
			values[2 * i],
		);
		const sample = parse(values[2 * i + 1], LiveHostSample);
		// The worker writes status every sync; presence catches an agent that came back since.
		const synced =
			presence && (r.status === "pending" || r.status === "down")
				? "ready"
				: r.status;
		const status =
			r.desired !== "active" && synced === "ready" ? "draining" : synced;
		return {
			id: r.id,
			swarmNodeId: r.swarmNodeId,
			hostname: r.hostname,
			address: r.address,
			role: r.role,
			labels: r.labels,
			desired: r.desired,
			status,
			agentVersion: presence?.version ?? r.agentVersion,
			lastSeenAt: presence?.lastSeenAt
				? new Date(presence.lastSeenAt)
				: r.lastSeenAt,
			cpus: r.facts.cpus ?? null,
			memoryBytes: r.facts.memoryBytes ?? null,
			engineVersion: r.facts.engineVersion ?? null,
			leader: r.facts.leader ?? false,
			live: sample ? { ...sample, nodeId: r.id } : null,
			createdAt: r.createdAt,
		};
	});
}

async function ownNode(db: Db, organizationId: string, id: string) {
	return one(
		await db
			.select()
			.from(node)
			.where(and(eq(node.id, id), eq(node.organizationId, organizationId))),
		"node",
	);
}

async function ownJoin(db: Db, organizationId: string, id: string) {
	return one(
		await db
			.select()
			.from(nodeJoin)
			.where(
				and(eq(nodeJoin.id, id), eq(nodeJoin.organizationId, organizationId)),
			),
		"server join",
	);
}

const joinView = ({
	hostKey: _,
	claimedAt: __,
	organizationId: ___,
	...j
}: typeof nodeJoin.$inferSelect) => j;

/** Each step needs the one before it to have succeeded on this run. */
const PREVIOUS: Record<NodeJoinStep, NodeJoinStep | undefined> = {
	test: undefined,
	preflight: "test",
	bootstrap: "preflight",
};
const ORDER: NodeJoinStep[] = ["test", "preflight", "bootstrap"];

export function canStart(
	current: { step: NodeJoinStep; state: string },
	next: NodeJoinStep,
): string | undefined {
	if (current.state === "queued" || current.state === "running")
		return `the ${current.step} step is still ${current.state}`;
	if (current.step === "bootstrap" && current.state === "succeeded")
		return "this server has already joined";
	const before = PREVIOUS[next];
	if (!before) return undefined;
	const reached = ORDER.indexOf(current.step);
	const done = current.state === "succeeded" ? reached : reached - 1;
	return done >= ORDER.indexOf(before)
		? undefined
		: `run the ${before} step first`;
}

export const nodes = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/nodes",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(NodeView), "Nodes"), ...errors },
		}),
		async (c) => {
			const { db, config } = c.var.deps;
			const rows = await db
				.select()
				.from(node)
				.where(eq(node.organizationId, requireActor(c).organizationId))
				.orderBy(desc(node.role), asc(node.hostname));
			return c.json(await views(config.REDIS_URL, rows), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/nodes/{id}",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			request: { params: IdParam },
			responses: { 200: json(NodeView, "Node"), ...errors },
		}),
		async (c) => {
			const { db, config } = c.var.deps;
			const row = await ownNode(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			return c.json(one(await views(config.REDIS_URL, [row])), 200);
		},
	)
	.openapi(
		mutation(
			"node.update",
			createRoute({
				method: "patch",
				path: "/nodes/{id}",
				tags,
				security,
				summary:
					"Set labels (applied to Swarm by the worker) or drain / activate",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam, ...body(NodeUpdate) },
				responses: { 200: json(NodeView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { db, config } = c.var.deps;
			const input = c.req.valid("json");
			const row = await ownNode(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			if (row.desired === "remove")
				throw new Failure("conflict", "the node is being removed");
			if (input.desired === "drain" && row.facts.leader)
				throw new Failure(
					"bad_request",
					"the leader manager runs LogiStack and cannot be drained",
				);
			const [updated] = await db
				.update(node)
				.set({
					// The installer's system labels keep their Swarm-mirrored values.
					...(input.labels && { labels: nodeLabels(input.labels, row.labels) }),
					...(input.desired && { desired: input.desired }),
				})
				.where(eq(node.id, row.id))
				.returning();
			await (await live(config.REDIS_URL)).poke();
			c.set("auditResourceId", row.id);
			return c.json(one(await views(config.REDIS_URL, [updated ?? row])), 200);
		},
	)
	.openapi(
		mutation(
			"node.delete",
			createRoute({
				method: "delete",
				path: "/nodes/{id}",
				tags,
				security,
				summary: "Remove a server: drain, leave the swarm, delete the node",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 202: json(NodeView, "Removal started"), ...errors },
			}),
		),
		async (c) => {
			const { db, config } = c.var.deps;
			const row = await ownNode(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			if (row.facts.leader)
				throw new Failure(
					"bad_request",
					"the leader manager runs LogiStack and cannot be removed",
				);
			const [updated] = await db
				.update(node)
				.set({ desired: "remove" })
				.where(eq(node.id, row.id))
				.returning();
			await (await live(config.REDIS_URL)).poke();
			c.set("auditResourceId", row.id);
			return c.json(one(await views(config.REDIS_URL, [updated ?? row])), 202);
		},
	)
	.openapi(
		mutation(
			"node_join.create",
			createRoute({
				method: "post",
				path: "/nodes/joins",
				tags,
				security,
				summary: "Start the Add-server wizard; queues the SSH test",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(NodeJoinInput),
				responses: { 201: json(NodeJoin, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const { db, config } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const input = c.req.valid("json");
			await ownKey(db, organizationId, input.sshKeyId);
			const row = one(
				await db
					.insert(nodeJoin)
					.values({ ...input, organizationId })
					.returning(),
			);
			await (await live(config.REDIS_URL)).poke();
			c.set("auditResourceId", row.id);
			return c.json(joinView(row), 201);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/nodes/joins/{id}",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			request: { params: IdParam },
			responses: { 200: json(NodeJoin, "Wizard run"), ...errors },
		}),
		async (c) => {
			const row = await ownJoin(
				c.var.deps.db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			return c.json(joinView(row), 200);
		},
	)
	.openapi(
		mutation(
			"node_join.update",
			createRoute({
				method: "put",
				path: "/nodes/joins/{id}",
				tags,
				security,
				summary: "Change the connection details; restarts from the SSH test",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam, ...body(NodeJoinInput) },
				responses: { 200: json(NodeJoin, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const { db, config } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const input = c.req.valid("json");
			const row = await ownJoin(db, organizationId, c.req.valid("param").id);
			const blocked = canStart(row, "test");
			if (blocked) throw new Failure("conflict", blocked);
			await ownKey(db, organizationId, input.sshKeyId);
			const moved = row.host !== input.host || row.port !== input.port;
			const updated = one(
				await db
					.update(nodeJoin)
					.set({
						...input,
						step: "test",
						state: "queued",
						error: null,
						checks: [],
						log: [],
						...(moved && { hostKey: null }),
					})
					.where(eq(nodeJoin.id, row.id))
					.returning(),
			);
			await (await live(config.REDIS_URL)).poke();
			c.set("auditResourceId", row.id);
			return c.json(joinView(updated), 200);
		},
	)
	.openapi(
		mutation(
			"node_join.run",
			createRoute({
				method: "post",
				path: "/nodes/joins/{id}/steps",
				tags,
				security,
				summary: "Queue the next wizard step (test, preflight or bootstrap)",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam, ...body(z.object({ step: NodeJoinStep })) },
				responses: { 202: json(NodeJoin, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const { db, config } = c.var.deps;
			const { step } = c.req.valid("json");
			const row = await ownJoin(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			const blocked = canStart(row, step);
			if (blocked) throw new Failure("conflict", blocked);
			const updated = one(
				await db
					.update(nodeJoin)
					.set({
						step,
						state: "queued",
						error: null,
						...(step === "bootstrap" && { log: [] }),
					})
					.where(eq(nodeJoin.id, row.id))
					.returning(),
			);
			await (await live(config.REDIS_URL)).poke();
			c.set("auditResourceId", row.id);
			return c.json(joinView(updated), 202);
		},
	);

async function ownKey(db: Db, organizationId: string, id: string) {
	const n = await db.$count(
		sshKey,
		and(eq(sshKey.id, id), eq(sshKey.organizationId, organizationId)),
	);
	if (n === 0) throw notFound("ssh key");
}
