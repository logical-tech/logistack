import { createRoute, z } from "@hono/zod-openapi";
import {
	CrashLoop,
	EnvKey,
	EnvVar,
	type EnvVarScope,
	envVarScopes,
	ObservedState,
	PendingDiff,
} from "@logistack/contracts";
import {
	decrypt,
	diffSpecs,
	dockerName,
	encrypt,
	type Resource,
	type SpecSnapshot,
	specSnapshot,
	summarizeChange,
	transition,
} from "@logistack/core";
import {
	deployment,
	environment,
	envVar,
	node,
	secret,
	service,
	serviceStatus,
} from "@logistack/db";
import { compileInput, loadService } from "@logistack/worker/load";
import {
	createSecret,
	type DbOrTx,
	readSecretValue,
	readSecretValues,
	type SecretsCtx,
	setSecretValue,
} from "@logistack/worker/secrets";
import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { Context } from "hono";
import { type Actor, requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one, rejectReservedEnvKeys } from "../errors.ts";
import { envelope } from "../events.ts";
import {
	body,
	Deployment,
	errors,
	IdParam,
	json,
	reservedEnvKey,
	router,
	Service,
	security,
} from "../openapi.ts";
import { redisFor, requestProxySync, requestReconcile } from "../redis.ts";
import {
	actorCan,
	byParam,
	refuseArchived,
	requirePermission,
} from "../scope.ts";
import { availableSecrets } from "./secrets.ts";

/** What the reconciler stores per running-desired task in `service_status.tasks`. */
export const TaskView = z.object({
	id: z.string(),
	slot: z.number().nullable(),
	/** Swarm node id. */
	nodeId: z.string().nullable(),
	state: z.string(),
	message: z.string().optional(),
	error: z.string().nullable(),
	at: z.string().optional(),
});
export type TaskView = z.infer<typeof TaskView>;

const ServiceTask = TaskView.extend({
	/** The node's LogiStack hostname, when the node is enrolled. */
	hostname: z.string().nullable(),
	/** Swarm's container name: `<service>.<slot or node>.<task id>`. */
	containerName: z.string(),
}).openapi("ServiceTask");

const ServiceOverview = Service.extend({
	projectId: z.string(),
	environmentName: z.string(),
	status: z.object({
		observed: ObservedState,
		replicasRunning: z.int(),
		replicasDesired: z.int(),
		observedAt: z.string().nullable(),
		tasks: z.array(ServiceTask),
		/** Set while tasks keep failing. */
		crashLoop: CrashLoop.nullable(),
	}),
	/** Newest healthy deployment: the image the service runs. */
	current: Deployment.nullable(),
	latest: Deployment.nullable(),
}).openapi("ServiceOverview");

const EffectiveVar = EnvVar.extend({
	/** A more specific scope defines the same key, so this definition does not apply. */
	overridden: z.boolean(),
}).openapi("EffectiveEnvVar");

const ServiceVarsInput = z.object({
	/** The complete service-scope set: keys left out are deleted. */
	variables: z
		.array(
			z.object({
				key: EnvKey,
				/** Omitted: keep the stored value (a masked secret the caller did not change). */
				value: z.string().optional(),
				isSecret: z.boolean(),
				isBuildTime: z.boolean(),
				/** Reference a managed secret on the service's chain instead of a value. */
				secretId: z.string().optional(),
			}),
		)
		.max(500)
		.refine(
			(vs) => new Set(vs.map((v) => v.key)).size === vs.length,
			"duplicate key",
		),
});

export const Shell = z.enum(["sh", "bash"]);

const ExecInput = z.object({
	/** Defaults to the first running replica. */
	taskId: z.string().optional(),
	shell: Shell,
	rows: z.int().min(2).max(500),
	cols: z.int().min(2).max(1000),
});

export const ExecTicket = z.object({
	actorId: z.string(),
	organizationId: z.string(),
	serviceId: z.string(),
	nodeId: z.string(),
	taskId: z.string(),
	shell: Shell,
	rows: z.int(),
	cols: z.int(),
});
export type ExecTicket = z.infer<typeof ExecTicket>;

export const execTicketKey = (ticket: string) => `ls:exec:ticket:${ticket}`;
const EXEC_TICKET_TTL_SEC = 30;

/** Running tasks of a service as last reported by the reconciler. */
export async function serviceTasks(
	c: Context<Env>,
	serviceId: string,
): Promise<TaskView[]> {
	const [row] = await c.var.deps.db
		.select({ tasks: serviceStatus.tasks })
		.from(serviceStatus)
		.where(eq(serviceStatus.serviceId, serviceId));
	return z
		.array(TaskView)
		.catch([])
		.parse(row?.tasks ?? []);
}

/** A running replica with its node: `taskId`'s, else the first. */
export async function runningTask(
	c: Context<Env>,
	serviceId: string,
	taskId?: string,
): Promise<{ id: string; nodeId: string } | undefined> {
	const t = (await serviceTasks(c, serviceId)).find(
		(t) => t.state === "running" && t.nodeId && (!taskId || t.id === taskId),
	);
	return t?.nodeId ? { id: t.id, nodeId: t.nodeId } : undefined;
}

export function actorTrigger(actor: Actor) {
	return actor.kind === "user" ? ("manual" as const) : ("api" as const);
}

export async function queueDeployment(
	c: Context<Env>,
	values: typeof deployment.$inferInsert,
	payload: Record<string, unknown> = {},
) {
	const actor = requireActor(c);
	await refuseArchived(c);
	const row = one(
		await c.var.deps.db.insert(deployment).values(values).returning(),
	);
	c.set("auditResourceId", row.id);
	await c.var.deps.bus.publishEvent(
		envelope(
			"deployment.queued",
			actor.organizationId,
			{ type: "deployment", id: row.id },
			{ serviceId: row.serviceId, trigger: row.trigger, ...payload },
		),
	);
	return row;
}

async function setDesired(
	c: Context<Env>,
	desiredState: "running" | "stopped",
) {
	const { db, config } = c.var.deps;
	if (desiredState === "running") await refuseArchived(c);
	const row = one(
		await db
			.update(service)
			.set({ desiredState })
			.where(eq(service.id, c.req.param("id") ?? ""))
			.returning(),
	);
	const reason = `service ${desiredState === "running" ? "started" : "stopped"}`;
	// The periodic pass converges anyway; these only make it immediate.
	await Promise.all([
		requestReconcile(config.REDIS_URL, reason),
		requestProxySync(config.REDIS_URL, reason),
	]).catch(() => {});
	return row;
}

// The literal path type is what the typed web client is built from.
const deployRoute = <P extends string>(
	path: P,
	summary: string,
	description: string,
) =>
	createRoute({
		method: "post",
		path,
		tags: ["services"],
		security,
		summary,
		description,
		middleware: [requirePermission("deploy", byParam("service"))],
		request: { params: IdParam },
		responses: { 200: json(Service, "Updated"), ...errors },
	});

export const serviceOps = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/overview",
			tags: ["services"],
			security,
			summary:
				"A service with its observed state, tasks per node and current image",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(ServiceOverview, "Overview"), ...errors },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const [row] = await db
				.select({ service, status: serviceStatus, environment })
				.from(service)
				.innerJoin(environment, eq(environment.id, service.environmentId))
				.leftJoin(serviceStatus, eq(serviceStatus.serviceId, service.id))
				.where(eq(service.id, id));
			if (!row) throw notFound("service");
			const [tasks, [current], [latest]] = await Promise.all([
				serviceTasks(c, id),
				db
					.select()
					.from(deployment)
					.where(
						and(eq(deployment.serviceId, id), eq(deployment.status, "healthy")),
					)
					.orderBy(desc(deployment.createdAt))
					.limit(1),
				// A skipped trigger never ran: the latest deployment is the latest that did or will.
				db
					.select()
					.from(deployment)
					.where(
						and(eq(deployment.serviceId, id), ne(deployment.status, "skipped")),
					)
					.orderBy(desc(deployment.createdAt))
					.limit(1),
			]);
			const nodeIds = [
				...new Set(tasks.flatMap((t) => (t.nodeId ? [t.nodeId] : []))),
			];
			const hosts = nodeIds.length
				? await db
						.select({ swarmNodeId: node.swarmNodeId, hostname: node.hostname })
						.from(node)
						.where(
							and(
								eq(node.organizationId, actor.organizationId),
								inArray(node.swarmNodeId, nodeIds),
							),
						)
				: [];
			const { status } = row;
			return c.json(
				{
					...row.service,
					projectId: row.environment.projectId,
					environmentName: row.environment.name,
					status: {
						observed: status?.observed ?? ("unknown" as const),
						replicasRunning: status?.replicasRunning ?? 0,
						replicasDesired: status?.replicasDesired ?? 0,
						observedAt: status?.observedAt?.toISOString() ?? null,
						crashLoop: status?.crashLoop ?? null,
						tasks: tasks.map((t) => ({
							...t,
							hostname:
								hosts.find((h) => h.swarmNodeId === t.nodeId)?.hostname ?? null,
							containerName: `${dockerName("svc", id)}.${t.slot ?? t.nodeId}.${t.id}`,
						})),
					},
					current: current ?? null,
					latest: latest ?? null,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/pending-diff",
			tags: ["services"],
			security,
			summary: "What the next deploy changes",
			description:
				"Diffs the spec the newest healthy deployment applied against the one the current configuration compiles to. Secret values are never returned, only that they changed. A git source's next build and commit are unknown until it runs, so the image and commit are compared as of that deployment.",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(PendingDiff, "Pending changes"), ...errors },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db, masterKey } = c.var.deps;
			const [last] = await db
				.select()
				.from(deployment)
				.where(
					and(
						eq(deployment.serviceId, id),
						eq(deployment.status, "healthy"),
						isNotNull(deployment.specSnapshotEncrypted),
					),
				)
				.orderBy(desc(deployment.createdAt))
				.limit(1);
			if (!last?.specSnapshotEncrypted)
				return c.json({ baseline: null, changes: [] }, 200);
			const before: SpecSnapshot = JSON.parse(
				await decrypt(masterKey, last.specSnapshotEncrypted),
			);
			let after: SpecSnapshot;
			try {
				const sc = await loadService(
					{ db, masterKey, secretsKek: c.var.deps.secretsKek },
					id,
					{ gitAuth: false },
				);
				if (!sc) throw notFound("service");
				const spec = sc.service.spec;
				const nets = before.spec.TaskTemplate.Networks ?? [];
				// Same rule as the worker: an image source names its image, a git source builds one.
				const input = compileInput(
					sc,
					{
						...last,
						imageRef:
							spec.kind === "application" && spec.source.type === "image"
								? spec.source.image
								: last.imageRef,
					},
					{
						// Names, not Docker ids: `specSnapshot` compares by name. ls-db is optional on the worker side.
						networks: {
							environment: "environment",
							ingress: "ingress",
							...(spec.kind === "storage" ? { storage: "storage" } : {}),
							...(nets.some((n) => n.Target === "db") ? { db: "db" } : {}),
							...(nets.some((n) => n.Target === "game")
								? { game: "game" }
								: {}),
						},
						// shortcut: a stateful service whose node row is gone diffs as re-pinned; rare, the worker logs it.
						pinNodeId: sc.pinnedSwarmNodeId ?? "unpinned",
					},
				);
				after = specSnapshot(input, sc.env);
			} catch (e) {
				if (e instanceof Failure) throw e;
				throw new Failure(
					"unprocessable",
					e instanceof Error ? e.message : String(e),
				);
			}
			return c.json(
				{
					baseline: {
						deploymentId: last.id,
						createdAt: last.createdAt.toISOString(),
					},
					changes: diffSpecs(before, after).map((change) => ({
						summary: summarizeChange(change),
						change,
					})),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"service.restart",
			createRoute({
				method: "post",
				path: "/services/{id}/restart",
				tags: ["services"],
				security,
				summary: "Rolling restart on the current image",
				description:
					"Queues a deployment of the newest healthy deployment's image: no build, Swarm replaces tasks start-first.",
				middleware: [requirePermission("deploy", byParam("service"))],
				request: { params: IdParam },
				responses: { 202: json(Deployment, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const [current] = await c.var.deps.db
				.select()
				.from(deployment)
				.where(
					and(eq(deployment.serviceId, id), eq(deployment.status, "healthy")),
				)
				.orderBy(desc(deployment.createdAt))
				.limit(1);
			if (!current?.imageRef)
				throw new Failure(
					"conflict",
					"the service has no healthy deployment to restart",
				);
			const row = await queueDeployment(c, {
				serviceId: id,
				trigger: actorTrigger(requireActor(c)),
				imageRef: current.imageRef,
				platforms: current.platforms,
				commitSha: current.commitSha,
				commitMessage: current.commitMessage,
			});
			return c.json(row, 202);
		},
	)
	.openapi(
		mutation(
			"service.stop",
			deployRoute(
				"/services/{id}/stop",
				"Stop: desired state stopped",
				"Scales the service to zero replicas and takes its domains out of the proxy. Data and configuration stay.",
			),
		),
		async (c) => c.json(await setDesired(c, "stopped"), 200),
	)
	.openapi(
		mutation(
			"service.start",
			deployRoute(
				"/services/{id}/start",
				"Start: desired state running",
				"Scales the service back to its configured replicas.",
			),
		),
		async (c) => c.json(await setDesired(c, "running"), 200),
	)
	.openapi(
		mutation(
			"deployment.rollback",
			createRoute({
				method: "post",
				path: "/deployments/{id}/rollback",
				tags: ["deployments"],
				security,
				summary: "Roll back to this deployment's image",
				description:
					"Queues a `rollback` deployment that reuses the image of a previous healthy deployment, skipping clone and build.",
				middleware: [requirePermission("deploy", byParam("deployment"))],
				request: { params: IdParam },
				responses: { 202: json(Deployment, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const target = one(
				await c.var.deps.db
					.select()
					.from(deployment)
					.where(eq(deployment.id, id)),
				"deployment",
			);
			if (target.status !== "healthy" || !target.imageRef)
				throw new Failure(
					"conflict",
					"only a healthy deployment with an image can be rolled back to",
					{ status: target.status },
				);
			c.set("auditDiff", { rollbackOf: id, imageRef: target.imageRef });
			const row = await queueDeployment(
				c,
				{
					serviceId: target.serviceId,
					trigger: "rollback",
					imageRef: target.imageRef,
					platforms: target.platforms,
					commitSha: target.commitSha,
					commitMessage: target.commitMessage,
				},
				{ rollbackOf: id },
			);
			return c.json(row, 202);
		},
	)
	.openapi(
		mutation(
			"deployment.cancel",
			createRoute({
				method: "post",
				path: "/deployments/{id}/cancel",
				tags: ["deployments"],
				security,
				summary: "Cancel a queued or building deployment",
				description:
					"Allowed until the rollout reaches Swarm (`deploying`); from then on Swarm owns it. The worker aborts the clone, build or push.",
				middleware: [requirePermission("deploy", byParam("deployment"))],
				request: { params: IdParam },
				responses: { 200: json(Deployment, "Cancelled"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db, bus } = c.var.deps;
			const current = one(
				await db.select().from(deployment).where(eq(deployment.id, id)),
				"deployment",
			);
			const r = transition(current.status, { type: "cancel" });
			if (!r.ok)
				throw new Failure(
					"conflict",
					`a ${current.status} deployment cannot be cancelled`,
					{
						status: current.status,
					},
				);
			// Conditional on the state read: a worker transition in between wins and this is a 409.
			const [row] = await db
				.update(deployment)
				.set({ status: r.state, finishedAt: new Date() })
				.where(
					and(eq(deployment.id, id), eq(deployment.status, current.status)),
				)
				.returning();
			if (!row)
				throw new Failure(
					"conflict",
					"the deployment changed state; try again",
				);
			await bus.publishEvent(
				envelope(
					"deployment.cancelled",
					requireActor(c).organizationId,
					{ type: "deployment", id },
					{
						serviceId: row.serviceId,
						from: current.status,
						status: row.status,
					},
				),
			);
			return c.json(row, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/env-vars",
			tags: ["env-vars"],
			security,
			summary:
				"Every variable that applies to the service, inherited ones included",
			description:
				"Organization, project, environment and service definitions, least specific first. A secret is masked (null) unless the caller holds `read:secrets` on the scope that defines it.",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(z.array(EffectiveVar), "Variables"), ...errors },
		}),
		async (c) => {
			const actor = requireActor(c);
			const resource = c.get("resource") as Resource;
			const chain: Record<z.infer<typeof EnvVarScope>, [string, Resource]> = {
				organization: [
					resource.organizationId,
					{ type: "organization", organizationId: resource.organizationId },
				],
				project: [
					resource.projectId ?? "",
					{
						...resource,
						type: "project",
						environmentId: undefined,
						serviceId: undefined,
					},
				],
				environment: [
					resource.environmentId ?? "",
					{ ...resource, type: "environment", serviceId: undefined },
				],
				service: [resource.serviceId ?? "", resource],
			};
			const rows = await c.var.deps.db
				.select()
				.from(envVar)
				.where(
					or(
						...envVarScopes.map((s) =>
							and(eq(envVar.scope, s), eq(envVar.scopeId, chain[s][0])),
						),
					),
				);
			const rank = (s: z.infer<typeof EnvVarScope>) => envVarScopes.indexOf(s);
			rows.sort(
				(a, b) => a.key.localeCompare(b.key) || rank(a.scope) - rank(b.scope),
			);
			const out = await Promise.all(
				rows.map(async ({ valueEncrypted, ...r }) => {
					// Managed secret values come only from `POST /secrets/{id}/reveal`, which is audited.
					const reveal =
						!r.secretId &&
						(!r.isSecret || actorCan(actor, "read:secrets", chain[r.scope][1]));
					return {
						...r,
						value: reveal
							? await decrypt(c.var.deps.masterKey, valueEncrypted)
							: null,
						overridden: rows.some(
							(o) => o.key === r.key && rank(o.scope) > rank(r.scope),
						),
					};
				}),
			);
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"env_var.replace",
			createRoute({
				method: "put",
				path: "/services/{id}/env-vars",
				tags: ["env-vars"],
				security,
				summary: "Replace the service-scope variables in one request",
				description:
					"The body is the full set at service scope: missing keys are deleted, an entry without `value` keeps its stored value. Inherited scopes are untouched.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(ServiceVarsInput) },
				responses: {
					200: json(z.array(EnvVar), "The service's variables"),
					...errors,
					...reservedEnvKey,
				},
			}),
		),
		async (c) => {
			const serviceId = c.req.valid("param").id;
			const { variables } = c.req.valid("json");
			rejectReservedEnvKeys(variables.map((v) => v.key));
			const actor = requireActor(c);
			const resource = c.get("resource") as Resource;
			const { db, masterKey, secretsKek } = c.var.deps;
			const scope = and(
				eq(envVar.scope, "service"),
				eq(envVar.scopeId, serviceId),
			);
			const refs = variables.flatMap((v) => (v.secretId ? [v.secretId] : []));
			const available = new Map(
				(await availableSecrets(db, actor, resource)).map((s) => [s.id, s]),
			);
			const outside = refs.filter((id) => !available.has(id));
			if (outside.length)
				throw new Failure(
					"bad_request",
					"a referenced secret is not defined on this service's chain, or you cannot read its scope",
					{ secretIds: outside },
				);
			const rows = await db.transaction(async (tx) => {
				const sctx = { db: tx, masterKey, secretsKek };
				const existing = await tx.select().from(envVar).where(scope);
				const missing = variables.filter((v) => {
					if (v.secretId || v.value !== undefined) return false;
					const prev = existing.find((e) => e.key === v.key);
					// Keeping a stored value only works for the same kind of variable.
					return !prev || prev.isSecret !== v.isSecret;
				});
				if (missing.length)
					throw new Failure("bad_request", "a new variable needs a value", {
						keys: missing.map((v) => v.key),
					});
				const keep = new Set(variables.map((v) => v.key));
				const removed = existing.filter((e) => !keep.has(e.key));
				// Service secrets this save may leave unreferenced; removed below if so.
				const released = existing.flatMap((e) =>
					e.secretId ? [{ id: e.secretId, key: e.key }] : [],
				);
				if (removed.length)
					await tx.delete(envVar).where(
						and(
							scope,
							inArray(
								envVar.id,
								removed.map((e) => e.id),
							),
						),
					);
				const values = await readSecretValues(sctx, refs);
				for (const v of variables) {
					const prev = existing.find((e) => e.key === v.key);
					let set: Partial<typeof envVar.$inferInsert>;
					if (v.secretId) {
						set = {
							isSecret: true,
							secretId: v.secretId,
							valueEncrypted: await encrypt(
								masterKey,
								values.get(v.secretId)?.value ?? "",
							),
						};
					} else if (v.isSecret && v.value !== undefined) {
						// Typed text marked secret: stored as this service's own secret, then referenced.
						const own = await serviceSecret(sctx, {
							organizationId: actor.organizationId,
							serviceId,
							key: v.key,
							value: v.value,
							userId: actor.userId,
						});
						set = {
							isSecret: true,
							secretId: own.id,
							valueEncrypted: await encrypt(masterKey, v.value),
						};
					} else if (v.value !== undefined) {
						set = {
							isSecret: false,
							secretId: null,
							valueEncrypted: await encrypt(masterKey, v.value),
						};
					} else set = {};
					set.isBuildTime = v.isBuildTime;
					if (prev)
						await tx.update(envVar).set(set).where(eq(envVar.id, prev.id));
					else
						await tx.insert(envVar).values({
							scope: "service",
							scopeId: serviceId,
							key: v.key,
							isSecret: set.isSecret ?? false,
							...set,
							valueEncrypted: set.valueEncrypted as string,
						});
				}
				await dropUnusedServiceSecrets(tx, serviceId, released);
				c.set("auditDiff", {
					added: variables
						.filter((v) => !existing.some((e) => e.key === v.key))
						.map((v) => v.key),
					changed: variables
						.filter(
							(v) =>
								(v.value !== undefined || v.secretId) &&
								existing.some((e) => e.key === v.key),
						)
						.map((v) => v.key),
					removed: removed.map((e) => e.key),
					references: variables
						.filter((v) => v.secretId)
						.map((v) => ({ key: v.key, secretId: v.secretId })),
				});
				return tx.select().from(envVar).where(scope);
			});
			const reveal = actorCan(actor, "read:secrets", resource);
			const out = await Promise.all(
				rows
					.sort((a, b) => a.key.localeCompare(b.key))
					.map(async ({ valueEncrypted, ...r }) => ({
						...r,
						value:
							!r.secretId && (!r.isSecret || reveal)
								? await decrypt(masterKey, valueEncrypted)
								: null,
					})),
			);
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"service.exec",
			createRoute({
				method: "post",
				path: "/services/{id}/exec",
				tags: ["services"],
				security,
				summary: "Open a terminal session in a running replica",
				description:
					"Needs the `exec` permission. Returns a one-time ticket, valid 30 seconds, for `GET /ws/exec?ticket=` (WebSocket): binary frames carry the TTY, text frames carry `{type:'resize',rows,cols}`. The session's end is audited as `service.exec_end`.",
				middleware: [requirePermission("exec", byParam("service"))],
				request: { params: IdParam, ...body(ExecInput) },
				responses: {
					201: json(
						z.object({
							ticket: z.string(),
							taskId: z.string(),
							nodeId: z.string(),
						}),
						"Ticket",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const serviceId = c.req.valid("param").id;
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const task = await runningTask(c, serviceId, input.taskId);
			if (!task)
				throw new Failure(
					"conflict",
					"no running replica to open a terminal in",
					{
						taskId: input.taskId,
					},
				);
			const ticket = crypto.randomUUID();
			const value: ExecTicket = {
				actorId: actor.id,
				organizationId: actor.organizationId,
				serviceId,
				nodeId: task.nodeId,
				taskId: task.id,
				shell: input.shell,
				rows: input.rows,
				cols: input.cols,
			};
			await redisFor(c.var.deps.config.REDIS_URL).set(
				execTicketKey(ticket),
				JSON.stringify(value),
				"EX",
				EXEC_TICKET_TTL_SEC,
			);
			c.set("auditDiff", {
				taskId: task.id,
				nodeId: task.nodeId,
				shell: input.shell,
			});
			return c.json({ ticket, taskId: task.id, nodeId: task.nodeId }, 201);
		},
	);

/** The service's own secret named `key`, created or given a new version when the value differs. */
async function serviceSecret(
	ctx: SecretsCtx,
	o: {
		organizationId: string;
		serviceId: string;
		key: string;
		value: string;
		userId: string;
	},
) {
	const [existing] = await ctx.db
		.select()
		.from(secret)
		.where(
			and(
				eq(secret.scope, "service"),
				eq(secret.scopeId, o.serviceId),
				eq(secret.key, o.key),
			),
		);
	if (!existing)
		return createSecret(
			ctx,
			{
				organizationId: o.organizationId,
				scope: "service",
				scopeId: o.serviceId,
				key: o.key,
				value: o.value,
			},
			o.userId,
		);
	if ((await readSecretValue(ctx, existing)) === o.value) return existing;
	return setSecretValue(ctx, existing.id, o.value, o.userId);
}

/**
 * Deletes the service secrets this save stopped using: the ones typed in its Environment tab
 * (same scope, same key as the variable), when nothing references them any more.
 */
async function dropUnusedServiceSecrets(
	db: DbOrTx,
	serviceId: string,
	released: { id: string; key: string }[],
) {
	const ids = released.map((r) => r.id);
	if (!ids.length) return;
	const used = new Set(
		(
			await db
				.select({ id: envVar.secretId })
				.from(envVar)
				.where(inArray(envVar.secretId, ids))
		).map((r) => r.id),
	);
	const unused = released.filter((r) => !used.has(r.id));
	if (unused.length)
		await db
			.delete(secret)
			.where(
				and(
					eq(secret.scope, "service"),
					eq(secret.scopeId, serviceId),
					or(
						...unused.map((r) =>
							and(eq(secret.id, r.id), eq(secret.key, r.key)),
						),
					),
				),
			);
}
