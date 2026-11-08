import { createRoute } from "@hono/zod-openapi";
import {
	type ApplicationSpec,
	AutoscaleFixId,
	AutoscaleFixProbe,
	AutoscaleFixResult,
	AutoscaleInput,
	AutoscalePreview,
	AutoscalePreviewQuery,
	type AutoscaleSettings,
	AutoscaleView,
} from "@logistack/contracts";
import {
	AUTOSCALE_FIX_CHECK,
	attachFixes,
	autoscaleChecks,
	BEHAVIOR_CPU_TARGET,
	type CopyUsage,
	type FixContext,
	fallbackHealthPort,
	HEALTH_PROBE_PATH,
	type HealthProbe,
	healthProbePort,
	ingressPortHolder,
	type LoadPoint,
	planFix,
	previewScale,
	publishedPortConflicts,
	targetCpuFor,
} from "@logistack/core";
import {
	type Db,
	deployment,
	domain,
	mount,
	node,
	service,
	serviceAutoscale,
} from "@logistack/db";
import { and, count, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { envelope } from "../events.ts";
import { guardHostSettings, portHolders } from "../host-settings.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { readResourceProfiles } from "../resource-profiles.ts";
import { byParam, refuseArchived, requirePermission } from "../scope.ts";
import { runningTask } from "./service-ops.ts";

const tags = ["services"];

const clamp = (n: number, min: number, max: number) =>
	Math.min(max, Math.max(min, n));

/** The service as an application, or a 400 for kinds that can't scale. */
async function loadApp(db: Db, id: string) {
	const [svc] = await db.select().from(service).where(eq(service.id, id));
	if (!svc) throw notFound("service");
	if (svc.spec.kind !== "application")
		throw new Failure(
			"bad_request",
			"Only application services can scale automatically",
		);
	return { svc, spec: svc.spec as ApplicationSpec };
}

/** p95 load of one copy over the last day; null under an hour of samples. */
async function copyUsage(db: Db, serviceId: string): Promise<CopyUsage> {
	const [row] = await db.$client<
		{ cpu: number | null; mem: number | null; minutes: number }[]
	>`
		select percentile_cont(0.95) within group (order by cpu) as cpu,
			percentile_cont(0.95) within group (order by mem_used) as mem,
			count(distinct ts)::int as minutes
		from metric_container_1m
		where service_id = ${serviceId} and ts > now() - interval '24 hours'`;
	if (!row || row.minutes < 60 || row.cpu == null || row.mem == null)
		return null;
	// Agent CPU is percent of one core.
	return { cpu: Number(row.cpu) / 100, memoryMb: Number(row.mem) / 2 ** 20 };
}

/** Why switching the host ports to ingress would clash with another holder, if it would. */
async function ingressConflict(
	c: Context<Env>,
	serviceId: string,
	spec: ApplicationSpec,
): Promise<string | undefined> {
	const plan = planFix("ingress_ports", spec, {
		profiles: { profiles: [], defaultProfile: null },
		usage: null,
	});
	if (!("spec" in plan)) return undefined;
	const [conflict] = publishedPortConflicts(
		{ id: serviceId, nodeId: null, ports: plan.spec.ports },
		[...(await portHolders(c)), ingressPortHolder],
	);
	if (!conflict) return undefined;
	const holder =
		conflict.holderId === ingressPortHolder.id
			? "the LogiStack ingress (Caddy)"
			: conflict.holderId === serviceId
				? "this service twice"
				: "another service";
	return `Port ${conflict.port}/${conflict.protocol} is already published by ${holder}, so it can't move to every server.`;
}

/**
 * Requests the healthcheck fix's URL inside one running copy, with the same tools the compiled
 * check uses (wget, then curl). Argv only; the URL holds no user input but the declared port.
 */
async function probeHealth(
	c: Context<Env>,
	serviceId: string,
	spec: ApplicationSpec,
): Promise<HealthProbe> {
	const port = healthProbePort(spec);
	if (port === undefined)
		return { ok: false, reason: "This service declares no port to check." };
	const task = await runningTask(c, serviceId);
	if (!task)
		return {
			ok: false,
			reason:
				"No copy is running, so the check can't be tested. Deploy the service first.",
		};
	const url = `http://127.0.0.1:${port}${HEALTH_PROBE_PATH}`;
	const tools = [
		["wget", ["wget", "-q", "-O", "/dev/null", url]],
		["curl", ["curl", "-fsS", "-o", "/dev/null", url]],
	] as const;
	let failed: string | undefined;
	for (const [tool, cmd] of tools) {
		const started = performance.now();
		let code: number | null = null;
		try {
			const exec = c.var.deps.nodes.exec(
				task.nodeId,
				{
					target: { kind: "task", taskId: task.id },
					cmd: [...cmd],
					stdin: false,
				},
				{ signal: AbortSignal.timeout(10_000) },
			);
			for await (const _ of exec);
			code = (await exec.result).code;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			// The engine refuses to start a binary the image lacks: try the next tool.
			if (/not found|no such file|executable/i.test(message)) continue;
			return { ok: false, reason: `The check couldn't run: ${message}` };
		}
		const ms = Math.round(performance.now() - started);
		if (code === 0)
			return { ok: true, port, path: HEALTH_PROBE_PATH, ms, tool };
		// 126/127: found no such binary; any other code means the request itself failed.
		if (code !== 126 && code !== 127)
			failed = `${HEALTH_PROBE_PATH} on port ${port} didn't answer inside a running copy (${tool} exit ${code}). Add a healthcheck that fits the app in the service settings.`;
		if (failed) break;
	}
	return {
		ok: false,
		reason:
			failed ??
			"The image has neither wget nor curl, so an HTTP check can't run in it. Add a command healthcheck in the service settings.",
	};
}

async function checksFor(
	c: Context<Env>,
	organizationId: string,
	serviceId: string,
	spec: ApplicationSpec,
	probe?: HealthProbe,
) {
	const { db } = c.var.deps;
	const [[volumes], [nodes], domains] = await Promise.all([
		db
			.select({ n: count() })
			.from(mount)
			.where(and(eq(mount.serviceId, serviceId), eq(mount.kind, "volume"))),
		db
			.select({ n: count() })
			.from(node)
			.where(eq(node.organizationId, organizationId)),
		db
			.select({ port: domain.port })
			.from(domain)
			.where(eq(domain.serviceId, serviceId)),
	]);
	const checks = autoscaleChecks({
		spec,
		volumes: volumes?.n ?? 0,
		nodes: nodes?.n ?? 0,
		fallbackPort: fallbackHealthPort(spec, domains),
	});
	const failing = (id: string) => checks.some((x) => x.id === id && !x.ok);
	const [profiles, usage, conflict] = await Promise.all([
		readResourceProfiles(db, organizationId),
		failing("cpu_limit") ? copyUsage(db, serviceId) : null,
		failing("host_ports") ? ingressConflict(c, serviceId, spec) : undefined,
	]);
	const ctx: FixContext = {
		profiles,
		usage,
		blocked: conflict ? { ingress_ports: conflict } : {},
		...(probe ? { probe } : {}),
	};
	return { checks: attachFixes(checks, spec, ctx), ctx };
}

async function view(
	c: Context<Env>,
	organizationId: string,
	serviceId: string,
): Promise<AutoscaleView> {
	const { db } = c.var.deps;
	const { spec } = await loadApp(db, serviceId);
	const [row] = await db
		.select()
		.from(serviceAutoscale)
		.where(eq(serviceAutoscale.serviceId, serviceId));
	const { checks } = await checksFor(c, organizationId, serviceId, spec);
	if (!row)
		return {
			configured: false,
			enabled: false,
			minReplicas: Math.max(1, spec.replicas),
			maxReplicas: Math.max(3, spec.replicas),
			behavior: "balanced",
			targetCpu: BEHAVIOR_CPU_TARGET.balanced,
			targetMemory: null,
			replicas: null,
			lastScaledAt: null,
			lastReason: null,
			checks,
		};
	return {
		configured: true,
		enabled: row.enabled,
		minReplicas: row.minReplicas,
		maxReplicas: row.maxReplicas,
		behavior: row.behavior,
		targetCpu: row.targetCpu,
		targetMemory: row.targetMemory,
		replicas: row.replicas,
		lastScaledAt: row.lastScaledAt,
		lastReason: row.lastReason,
		checks,
	};
}

/**
 * The service's load over the last day, one point per minute: CPU summed over its containers
 * (percent of a core), memory as the average percent of the limit.
 */
async function loadHistory(db: Db, serviceId: string): Promise<LoadPoint[]> {
	const rows = await db.$client<
		{ at: Date; cpu: number; memory: number | null }[]
	>`
		select ts as at, sum(cpu) as cpu,
			100 * avg(mem_used::float8 / nullif(mem_limit, 0)) as memory
		from metric_container_1m
		where service_id = ${serviceId} and ts > now() - interval '24 hours'
		group by ts order by ts`;
	return rows.map((r) => ({
		at: new Date(r.at),
		cpu: Number(r.cpu),
		memory: r.memory == null ? null : Number(r.memory),
	}));
}

export const autoscale = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/autoscale",
			tags,
			security,
			summary: "A service's autoscaling settings, state and readiness checks",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(AutoscaleView, "Autoscaling"), ...errors },
		}),
		async (c) =>
			c.json(
				await view(c, requireActor(c).organizationId, c.req.valid("param").id),
				200,
			),
	)
	.openapi(
		mutation(
			"service.autoscale",
			createRoute({
				method: "put",
				path: "/services/{id}/autoscale",
				tags,
				security,
				summary: "Turn autoscaling on or off and set its range and behavior",
				description:
					"While enabled, the service runs between `minReplicas` and `maxReplicas` copies and its `spec.replicas` is set aside; turning it off returns to `spec.replicas`. Enabling is refused while a blocker check fails (no CPU limit, a volume or host path, a port published on the host). Each change the autoscaler makes emits `service.scaled`.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(AutoscaleInput) },
				responses: { 200: json(AutoscaleView, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const organizationId = requireActor(c).organizationId;
			const { spec } = await loadApp(db, id);
			if (input.enabled) {
				const blockers = (
					await checksFor(c, organizationId, id, spec)
				).checks.filter((x) => x.level === "blocker" && !x.ok);
				if (blockers.length)
					throw new Failure(
						"bad_request",
						blockers.map((b) => b.message).join(" "),
						{ checks: blockers },
					);
			}
			if (input.targetMemory !== null && !spec.resources.memoryMb)
				throw new Failure(
					"bad_request",
					"Set a memory limit to scale on memory",
				);
			const [before] = await db
				.select()
				.from(serviceAutoscale)
				.where(eq(serviceAutoscale.serviceId, id));
			const settings: AutoscaleSettings = {
				enabled: input.enabled,
				minReplicas: input.minReplicas,
				maxReplicas: input.maxReplicas,
				behavior: input.behavior,
				targetCpu: targetCpuFor(input.behavior, input.targetCpu),
				targetMemory: input.targetMemory,
			};
			// Keep the current scaled count when it still fits; otherwise start from the manual one.
			const replicas = clamp(
				(before?.enabled ? before.replicas : null) ?? spec.replicas,
				settings.minReplicas,
				settings.maxReplicas,
			);
			await db
				.insert(serviceAutoscale)
				.values({ serviceId: id, ...settings, replicas })
				.onConflictDoUpdate({
					target: serviceAutoscale.serviceId,
					set: { ...settings, replicas, updatedAt: sql`now()` },
				});
			c.set("auditDiff", {
				before: before
					? {
							enabled: before.enabled,
							minReplicas: before.minReplicas,
							maxReplicas: before.maxReplicas,
							behavior: before.behavior,
							targetCpu: before.targetCpu,
							targetMemory: before.targetMemory,
						}
					: null,
				after: settings,
			});
			return c.json(await view(c, organizationId, id), 200);
		},
	)
	.openapi(
		mutation(
			"service.autoscale_fix",
			createRoute({
				method: "post",
				path: "/services/{id}/autoscale/fixes/{fixId}",
				tags,
				security,
				summary: "Apply a one-click fix for a failed autoscaling check",
				description:
					"Recomputes the fix named by `fixId` on the current settings (the change never comes from the client), saves it to the spec and queues a deployment. A no-op when its check already passes. The fix and its effects are listed on the failed check in `GET /services/{id}/autoscale`.",
				middleware: [
					requirePermission("write", byParam("service")),
					requirePermission("deploy", byParam("service")),
				],
				request: {
					params: z.object({ id: z.string(), fixId: AutoscaleFixId }),
				},
				responses: { 200: json(AutoscaleFixResult, "Applied"), ...errors },
			}),
		),
		async (c) => {
			const { id, fixId } = c.req.valid("param");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			await refuseArchived(c);
			const probe =
				fixId === "add_healthcheck"
					? await (async () => {
							const { spec } = await loadApp(db, id);
							return spec.healthcheck ? undefined : probeHealth(c, id, spec);
						})()
					: undefined;
			const queued = await db.transaction(async (tx) => {
				// Serializes two clicks (or two tabs) on the same service.
				const [svc] = await tx
					.select()
					.from(service)
					.where(eq(service.id, id))
					.for("update");
				if (!svc) throw notFound("service");
				if (svc.spec.kind !== "application")
					throw new Failure(
						"bad_request",
						"Only application services can scale automatically",
					);
				const spec = svc.spec;
				const { checks, ctx } = await checksFor(
					c,
					actor.organizationId,
					id,
					spec,
					probe,
				);
				const check = checks.find((x) => x.id === AUTOSCALE_FIX_CHECK[fixId]);
				if (check?.ok) return null;
				const plan = planFix(fixId, spec, ctx);
				if (!("spec" in plan))
					throw new Failure("bad_request", plan.unavailable);
				await guardHostSettings(c, {
					serviceId: id,
					spec: plan.spec,
					before: spec,
					nodeId: svc.nodeId,
				});
				await tx
					.update(service)
					.set({ spec: plan.spec })
					.where(eq(service.id, id));
				c.set("auditDiff", { before: spec, after: plan.spec });
				const [row] = await tx
					.insert(deployment)
					.values({
						serviceId: id,
						trigger: actor.kind === "user" ? "manual" : "api",
					})
					.returning();
				return row ?? null;
			});
			if (queued)
				await c.var.deps.bus.publishEvent(
					envelope(
						"deployment.queued",
						actor.organizationId,
						{ type: "deployment", id: queued.id },
						{ serviceId: id, trigger: queued.trigger },
					),
				);
			return c.json(
				{
					view: await view(c, actor.organizationId, id),
					deploymentId: queued?.id ?? null,
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"service.autoscale_probe",
			createRoute({
				method: "post",
				path: "/services/{id}/autoscale/fixes/add_healthcheck/probe",
				tags,
				security,
				summary: "Test the healthcheck AutoFix inside a running copy",
				description:
					"Requests `/` on the service's first port from inside one running copy, with wget or curl as the compiled check would. Returns the fix with the result, or why it isn't offered. Changes nothing.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam },
				responses: { 200: json(AutoscaleFixProbe, "Probe"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { spec } = await loadApp(c.var.deps.db, id);
			const probe = spec.healthcheck
				? undefined
				: await probeHealth(c, id, spec);
			const plan = planFix("add_healthcheck", spec, {
				profiles: { profiles: [], defaultProfile: null },
				usage: null,
				...(probe ? { probe } : {}),
			});
			return c.json(
				"fix" in plan ? { fix: plan.fix } : { unavailable: plan.unavailable },
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/autoscale/preview",
			tags,
			security,
			summary:
				"What these autoscaling settings would have done over the last day",
			description:
				"Replays the autoscaler over the service's last 24 hours of load. Total CPU is spread over the simulated copies; memory per copy is taken as it was.",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam, query: AutoscalePreviewQuery },
			responses: { 200: json(AutoscalePreview, "Preview"), ...errors },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const q = c.req.valid("query");
			const { db } = c.var.deps;
			const { spec } = await loadApp(db, id);
			const cpuLimit = spec.resources.cpu;
			if (!cpuLimit)
				throw new Failure(
					"bad_request",
					"Pick a size first: the preview measures CPU against each copy's limit",
				);
			const history = await loadHistory(db, id);
			const points = previewScale(
				history,
				{
					min: q.minReplicas,
					max: q.maxReplicas,
					targetCpu: targetCpuFor(q.behavior, q.targetCpu),
					targetMemory: null,
				},
				cpuLimit,
				spec.replicas,
			);
			return c.json({ points, enoughData: history.length >= 60 }, 200);
		},
	);
