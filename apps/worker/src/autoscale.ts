import type {
	ApplicationSpec,
	ServiceScaledEventPayload,
} from "@logistack/contracts";
import {
	decideScale,
	isTerminal,
	SCALE_DOWN_WINDOW_SEC,
	SCALE_UP_WINDOW_SEC,
	type Usage,
} from "@logistack/core";
import {
	auditLog,
	deployment,
	environment,
	project,
	service,
	serviceAutoscale,
	serviceStatus,
} from "@logistack/db";
import { and, eq, inArray, sql as q } from "drizzle-orm";
import { pausedServices } from "./backups.ts";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import type { Sql } from "./metrics-store.ts";
import { enqueueReconcile } from "./queues.ts";

/**
 * Average usage across the service's containers over the last `windowSec`, percent of the
 * limit. The agent reports CPU as percent of one core, so it is divided by the limit in cores.
 */
async function usage(
	sql: Sql,
	serviceId: string,
	cpuLimit: number,
	windowSec: number,
): Promise<Usage> {
	const [r] = await sql<{ cpu: number | null; memory: number | null }[]>`
		select avg(cpu) as cpu,
			100 * avg(mem_used::float8 / nullif(mem_limit, 0)) as memory
		from metric_container_raw
		where service_id = ${serviceId} and ts > now() - make_interval(secs => ${windowSec})`;
	return {
		cpu: r?.cpu == null ? null : Number(r.cpu) / cpuLimit,
		memory: r?.memory == null ? null : Number(r.memory),
	};
}

const round = (n: number | null) =>
	n == null ? null : Math.round(n * 10) / 10;

/**
 * One autoscaler pass: for each enabled, running application service, decide a replica count
 * from its recent usage and record it in `service_autoscale`. Docker is left to the reconciler.
 * Holds a service while a deployment or a backup owns it, and when it has no CPU limit.
 */
export async function autoscalePass(
	ctx: Ctx,
	now = new Date(),
): Promise<ServiceScaledEventPayload[]> {
	const rows = await ctx.db
		.select({
			a: serviceAutoscale,
			name: service.name,
			spec: service.spec,
			organizationId: project.organizationId,
			status: serviceStatus,
		})
		.from(serviceAutoscale)
		.innerJoin(service, eq(service.id, serviceAutoscale.serviceId))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.leftJoin(serviceStatus, eq(serviceStatus.serviceId, service.id))
		.where(
			and(
				eq(serviceAutoscale.enabled, true),
				eq(service.kind, "application"),
				eq(service.desiredState, "running"),
			),
		);
	if (!rows.length) return [];
	const ids = rows.map((r) => r.a.serviceId);
	const deployments = await ctx.db
		.select({ serviceId: deployment.serviceId, status: deployment.status })
		.from(deployment)
		.where(inArray(deployment.serviceId, ids));
	const busy = new Set(
		deployments.filter((d) => !isTerminal(d.status)).map((d) => d.serviceId),
	);
	const paused = await pausedServices(ctx, ids);

	const sql = ctx.db.$client;
	const scaled: ServiceScaledEventPayload[] = [];
	for (const { a, name, spec, organizationId, status } of rows) {
		const app = spec as ApplicationSpec;
		const cpuLimit = app.resources.cpu;
		if (!cpuLimit || busy.has(a.serviceId) || paused.has(a.serviceId)) continue;
		const current = a.replicas ?? app.replicas;
		const recent = await usage(sql, a.serviceId, cpuLimit, SCALE_UP_WINDOW_SEC);
		const decision = decideScale({
			current,
			min: a.minReplicas,
			max: a.maxReplicas,
			targetCpu: a.targetCpu,
			targetMemory: a.targetMemory,
			recent,
			sustained: await usage(sql, a.serviceId, cpuLimit, SCALE_DOWN_WINDOW_SEC),
			lastScaledAt: a.lastScaledAt,
			now,
			pending:
				!!status &&
				status.replicasDesired === current &&
				status.replicasRunning < current,
		});
		if (!decision || decision.replicas === current) continue;

		// Only if the count is still the one read; a concurrent change wins and the next pass decides again.
		const [updated] = await ctx.db
			.update(serviceAutoscale)
			.set({
				replicas: decision.replicas,
				lastScaledAt: now,
				lastReason: decision.reason,
			})
			.where(
				and(
					eq(serviceAutoscale.serviceId, a.serviceId),
					q`${serviceAutoscale.replicas} is not distinct from ${a.replicas}`,
				),
			)
			.returning({ serviceId: serviceAutoscale.serviceId });
		if (!updated) continue;

		const payload: ServiceScaledEventPayload = {
			serviceId: a.serviceId,
			service: name,
			from: current,
			to: decision.replicas,
			reason: decision.reason,
			cpu: round(recent.cpu),
			memory: round(recent.memory),
		};
		await ctx.db.insert(auditLog).values({
			organizationId,
			actorKind: "system",
			actorId: "autoscaler",
			action: "service.scaled",
			resourceType: "service",
			resourceId: a.serviceId,
			diff: {
				replicas: { before: current, after: decision.replicas },
				reason: decision.reason,
			},
			outcome: "success",
		});
		await ctx.bus.publish(
			"service.scaled",
			organizationId,
			{ type: "service", id: a.serviceId },
			payload,
		);
		log("info", "service scaled", payload);
		scaled.push(payload);
	}
	if (scaled.length) await enqueueReconcile(ctx.queues, "autoscale");
	return scaled;
}
