import { createRoute, z } from "@hono/zod-openapi";
import {
	DrainHealth,
	DrainNodeStatus,
	drainHealth,
	LogDrainConfig,
	LogDrainKind,
} from "@logistack/contracts";
import { decrypt, drainTarget, encrypt } from "@logistack/core";
import {
	type Db,
	environment,
	logDrain,
	node,
	project,
	service,
} from "@logistack/db";
import { NodeRunnerError } from "@logistack/worker/node-runner";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { DRAIN_STATUS_KEY, NODE_KEY, NODES_KNOWN } from "../agent-gateway.ts";
import { mutation } from "../audit.ts";
import { notifyDrainsChanged } from "../drains.ts";
import type { Deps } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import { parseJson } from "../events.ts";
import {
	body,
	errors,
	IdParam,
	json,
	Name,
	router,
	security,
} from "../openapi.ts";
import { redisFor } from "../redis.ts";
import { inOrganization, requirePermission } from "../scope.ts";
import { BlockedHostError, hostPolicy, resolvePublic } from "../ssrf.ts";

const NodeStatus = DrainNodeStatus.extend({
	nodeId: z.string(),
	hostname: z.string(),
	/** When the node reported, Unix ms. */
	at: z.number(),
}).openapi("LogDrainNodeStatus");

const DrainView = z
	.object({
		id: z.string(),
		name: z.string(),
		kind: LogDrainKind,
		/** Destination without credentials. */
		target: z.string(),
		enabled: z.boolean(),
		projectIds: z.array(z.string()),
		serviceIds: z.array(z.string()),
		health: DrainHealth,
		/** Fresh reports from the nodes shipping to it. */
		nodes: z.array(NodeStatus),
		createdAt: z.string(),
	})
	.openapi("LogDrain");

const TestResult = z
	.object({
		ok: z.boolean(),
		/** The destination's HTTP status, when it answered. */
		status: z.number().int().optional(),
		error: z.string().optional(),
		/** The node that sent the test event. */
		nodeId: z.string(),
	})
	.openapi("LogDrainTestResult");

const Scope = {
	projectIds: z.array(z.string()).max(500),
	serviceIds: z.array(z.string()).max(500),
};

type Row = typeof logDrain.$inferSelect;

/** The host a drain dials must pass the instance's private-host policy, like webhooks. */
async function checkHost(db: Db, config: LogDrainConfig) {
	const policy = await hostPolicy(db);
	if (policy.allowPrivateHosts) return;
	const host =
		config.kind === "syslog"
			? config.host
			: config.kind === "datadog"
				? `http-intake.logs.${config.site}`
				: new URL(config.url).hostname;
	try {
		await resolvePublic(host, policy);
	} catch (e) {
		if (e instanceof BlockedHostError)
			throw new Failure("bad_request", e.message);
		throw e;
	}
}

async function parseConfig(db: Db, raw: unknown): Promise<LogDrainConfig> {
	const parsed = LogDrainConfig.safeParse(raw);
	if (!parsed.success)
		throw new Failure(
			"validation_failed",
			"config does not match the drain kind",
			parsed.error.issues,
		);
	await checkHost(db, parsed.data);
	return parsed.data;
}

/** Projects and services must all be the caller's organization's. */
async function assertScopeOwned(
	db: Db,
	organizationId: string,
	projectIds: string[],
	serviceIds: string[],
) {
	if (projectIds.length) {
		const n = await db.$count(
			project,
			and(
				inArray(project.id, projectIds),
				eq(project.organizationId, organizationId),
			),
		);
		if (n !== new Set(projectIds).size) throw notFound("project");
	}
	if (serviceIds.length) {
		const rows = await db
			.select({ id: service.id })
			.from(service)
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(project, eq(project.id, environment.projectId))
			.where(
				and(
					inArray(service.id, serviceIds),
					eq(project.organizationId, organizationId),
				),
			);
		if (rows.length !== new Set(serviceIds).size) throw notFound("service");
	}
}

async function drainRow(db: Db, organizationId: string, id: string) {
	const [row] = await db
		.select()
		.from(logDrain)
		.where(
			and(eq(logDrain.id, id), eq(logDrain.organizationId, organizationId)),
		);
	if (!row) throw notFound("log drain");
	return row;
}

async function view(
	redisUrl: string,
	r: Row,
): Promise<z.infer<typeof DrainView>> {
	const raw = await redisFor(redisUrl)
		.hgetall(DRAIN_STATUS_KEY(r.id))
		.catch(() => null);
	const nodes = Object.entries(raw ?? {}).flatMap(([nodeId, v]) => {
		const s = NodeStatus.omit({ nodeId: true }).safeParse(parseJson(v));
		return s.success ? [{ ...s.data, nodeId }] : [];
	});
	return {
		id: r.id,
		name: r.name,
		kind: r.kind,
		target: r.target,
		enabled: r.enabled,
		projectIds: r.projectIds,
		serviceIds: r.serviceIds,
		health: r.enabled ? drainHealth(nodes) : "unknown",
		nodes,
		createdAt: r.createdAt.toISOString(),
	};
}

/** Sends the test event from the first online node that answers, or the requested one. */
async function sendTest(
	deps: Deps,
	config: LogDrainConfig,
	organizationId: string,
	nodeId?: string,
): Promise<z.infer<typeof TestResult>> {
	const redis = redisFor(deps.config.REDIS_URL);
	const own = new Set(
		(
			await deps.db
				.select({ id: node.id })
				.from(node)
				.where(eq(node.organizationId, organizationId))
		).map((n) => n.id),
	);
	if (nodeId && !own.has(nodeId)) throw notFound("node");
	const candidates = nodeId ? [nodeId] : await redis.smembers(NODES_KNOWN);
	for (const id of candidates) {
		if (!own.has(id)) continue;
		if (!nodeId && !(await redis.exists(NODE_KEY(id)))) continue;
		try {
			return { ...(await deps.nodes.testDrain(id, config)), nodeId: id };
		} catch (e) {
			// An old agent or a node that just went away: try the next one.
			if (!nodeId && e instanceof NodeRunnerError) continue;
			throw new Failure(
				"bad_request",
				e instanceof Error ? e.message : String(e),
			);
		}
	}
	throw new Failure(
		"bad_request",
		"no online node can send a test event; check that the node agents are connected and up to date",
	);
}

const tags = ["log-drains"];
const admin = [requirePermission("admin", inOrganization)];
const changed = (deps: Deps) =>
	notifyDrainsChanged(redisFor(deps.config.REDIS_URL));

export const logDrains = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/log-drains",
			tags,
			security,
			summary: "Log drains with their delivery health per node",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(DrainView), "Drains"), ...errors },
		}),
		async (c) => {
			const { db, config } = c.var.deps;
			const rows = await db
				.select()
				.from(logDrain)
				.where(eq(logDrain.organizationId, requireActor(c).organizationId))
				.orderBy(asc(logDrain.name));
			return c.json(
				await Promise.all(rows.map((r) => view(config.REDIS_URL, r))),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"log_drain.test",
			createRoute({
				method: "post",
				path: "/log-drains/test",
				tags,
				security,
				summary: "Send a test event through an unsaved drain config",
				description:
					"Sent from a node agent, the same way logs ship. Only the destination's HTTP status comes back, never its body.",
				middleware: admin,
				request: body(
					z.object({ config: z.unknown(), nodeId: z.string().optional() }),
				),
				responses: { 200: json(TestResult, "Attempted"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const deps = c.var.deps;
			const config = await parseConfig(deps.db, input.config);
			return c.json(
				await sendTest(
					deps,
					config,
					requireActor(c).organizationId,
					input.nodeId,
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"log_drain.create",
			createRoute({
				method: "post",
				path: "/log-drains",
				tags,
				security,
				summary: "Create a log drain",
				description:
					"Logs of every service in `projectIds`, plus the services in `serviceIds`, ship to it. `config` is one of the drain kinds (loki, otlp, http, datadog, syslog); it is stored encrypted and never returned.",
				middleware: admin,
				request: body(
					z.object({
						name: Name,
						config: z.unknown(),
						enabled: z.boolean().default(true),
						...Scope,
					}),
				),
				responses: { 201: json(DrainView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const deps = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const config = await parseConfig(deps.db, input.config);
			await assertScopeOwned(
				deps.db,
				organizationId,
				input.projectIds,
				input.serviceIds,
			);
			const row = one(
				await deps.db
					.insert(logDrain)
					.values({
						organizationId,
						name: input.name,
						kind: config.kind,
						target: drainTarget(config),
						configEncrypted: await encrypt(
							deps.masterKey,
							JSON.stringify(config),
						),
						enabled: input.enabled,
						projectIds: [...new Set(input.projectIds)],
						serviceIds: [...new Set(input.serviceIds)],
					})
					.returning(),
			);
			await changed(deps);
			c.set("auditResourceId", row.id);
			return c.json(await view(deps.config.REDIS_URL, row), 201);
		},
	)
	.openapi(
		mutation(
			"log_drain.update",
			createRoute({
				method: "patch",
				path: "/log-drains/{id}",
				tags,
				security,
				summary: "Rename, pause, rescope a drain, or replace its whole config",
				description: "A new `config` must keep the drain's kind.",
				middleware: admin,
				request: {
					params: IdParam,
					...body(
						z.object({
							name: Name.optional(),
							config: z.unknown().optional(),
							enabled: z.boolean().optional(),
							projectIds: Scope.projectIds.optional(),
							serviceIds: Scope.serviceIds.optional(),
						}),
					),
				},
				responses: { 200: json(DrainView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const deps = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const current = await drainRow(deps.db, organizationId, id);
			const config =
				input.config === undefined
					? undefined
					: await parseConfig(deps.db, input.config);
			if (config && config.kind !== current.kind)
				throw new Failure(
					"bad_request",
					"a drain keeps its kind; create a new drain instead",
				);
			await assertScopeOwned(
				deps.db,
				organizationId,
				input.projectIds ?? [],
				input.serviceIds ?? [],
			);
			const row = one(
				await deps.db
					.update(logDrain)
					.set({
						...(input.name ? { name: input.name } : {}),
						...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
						...(input.projectIds
							? { projectIds: [...new Set(input.projectIds)] }
							: {}),
						...(input.serviceIds
							? { serviceIds: [...new Set(input.serviceIds)] }
							: {}),
						...(config
							? {
									target: drainTarget(config),
									configEncrypted: await encrypt(
										deps.masterKey,
										JSON.stringify(config),
									),
								}
							: {}),
					})
					.where(eq(logDrain.id, id))
					.returning(),
			);
			await changed(deps);
			c.set("auditResourceId", id);
			return c.json(await view(deps.config.REDIS_URL, row), 200);
		},
	)
	.openapi(
		mutation(
			"log_drain.test",
			createRoute({
				method: "post",
				path: "/log-drains/{id}/test",
				tags,
				security,
				summary: "Send a test event through a saved drain",
				middleware: admin,
				request: {
					params: IdParam,
					query: z.object({ nodeId: z.string().optional() }),
				},
				responses: { 200: json(TestResult, "Attempted"), ...errors },
			}),
		),
		async (c) => {
			const deps = c.var.deps;
			const row = await drainRow(
				deps.db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			const config = LogDrainConfig.parse(
				JSON.parse(await decrypt(deps.masterKey, row.configEncrypted)),
			);
			await checkHost(deps.db, config);
			c.set("auditResourceId", row.id);
			return c.json(
				await sendTest(
					deps,
					config,
					requireActor(c).organizationId,
					c.req.valid("query").nodeId,
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"log_drain.delete",
			createRoute({
				method: "delete",
				path: "/log-drains/{id}",
				tags,
				security,
				description:
					"Agents stop shipping to it at their next config push, within seconds.",
				middleware: admin,
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const deps = c.var.deps;
			await drainRow(deps.db, requireActor(c).organizationId, id);
			await deps.db.delete(logDrain).where(eq(logDrain.id, id));
			await redisFor(deps.config.REDIS_URL)
				.del(DRAIN_STATUS_KEY(id))
				.catch(() => {});
			await changed(deps);
			c.set("auditResourceId", id);
			return c.body(null, 204);
		},
	);
