import { createRoute } from "@hono/zod-openapi";
import {
	type ApplicationSpec,
	AutoscaleInput,
	AutoscalePreview,
	AutoscalePreviewQuery,
	type AutoscaleSettings,
	AutoscaleView,
} from "@logistack/contracts";
import {
	autoscaleChecks,
	BEHAVIOR_CPU_TARGET,
	type LoadPoint,
	previewScale,
	targetCpuFor,
} from "@logistack/core";
import { type Db, mount, node, service, serviceAutoscale } from "@logistack/db";
import { and, count, eq, sql } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, notFound } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { byParam, requirePermission } from "../scope.ts";

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

async function checksFor(
	db: Db,
	organizationId: string,
	serviceId: string,
	spec: ApplicationSpec,
) {
	const [[volumes], [nodes]] = await Promise.all([
		db
			.select({ n: count() })
			.from(mount)
			.where(and(eq(mount.serviceId, serviceId), eq(mount.kind, "volume"))),
		db
			.select({ n: count() })
			.from(node)
			.where(eq(node.organizationId, organizationId)),
	]);
	return autoscaleChecks({
		spec,
		volumes: volumes?.n ?? 0,
		nodes: nodes?.n ?? 0,
	});
}

async function view(
	db: Db,
	organizationId: string,
	serviceId: string,
): Promise<AutoscaleView> {
	const { spec } = await loadApp(db, serviceId);
	const [row] = await db
		.select()
		.from(serviceAutoscale)
		.where(eq(serviceAutoscale.serviceId, serviceId));
	const checks = await checksFor(db, organizationId, serviceId, spec);
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
				await view(
					c.var.deps.db,
					requireActor(c).organizationId,
					c.req.valid("param").id,
				),
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
				const blockers = (await checksFor(db, organizationId, id, spec)).filter(
					(x) => x.level === "blocker" && !x.ok,
				);
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
			return c.json(await view(db, organizationId, id), 200);
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
