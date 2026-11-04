import { createRoute, z } from "@hono/zod-openapi";
import {
	Cleanup,
	ContainerMetricsResponse,
	DEFAULT_CLEANUP,
	HostMetricsResponse,
	MetricRange,
	MonitoringSettings,
	MonitoringSettingsInput,
} from "@logistack/contracts";
import {
	type Db,
	metricThreshold,
	monitoringSettings,
	node,
} from "@logistack/db";
import { syncCleanupScheduler } from "@logistack/worker/schedulers";
import { and, eq, notInArray } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Cron, Timezone } from "../cron.ts";
import { Failure, notFound } from "../errors.ts";
import {
	containerSeries,
	hostSeries,
	loadRetention,
	windowFor,
} from "../metrics-query.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { runQueues } from "../run-queues.ts";
import { byParam, inOrganization, requirePermission } from "../scope.ts";

const tags = ["monitoring"];

const RangeQuery = z.object({ range: MetricRange.default("1h") });

const HostQuery = RangeQuery.extend({
	/** A `node.id`; omitted means every node of the organization. */
	nodeId: z.string().optional(),
	/** With no `nodeId`: one series per node instead of the cluster aggregate. */
	perNode: z
		.enum(["true", "false"])
		.default("false")
		.transform((v) => v === "true"),
});

const SettingsInput = MonitoringSettingsInput.extend({
	cleanup: Cleanup.extend({ cron: Cron, timezone: Timezone }).optional(),
});

async function loadCleanup(db: Db) {
	const [row] = await db
		.select()
		.from(monitoringSettings)
		.where(eq(monitoringSettings.id, "singleton"));
	return {
		cleanup: row
			? {
					enabled: row.cleanupEnabled,
					cron: row.cleanupCron,
					timezone: row.cleanupTimezone,
					targets: row.cleanupTargets,
					untilHours: row.cleanupUntilHours,
				}
			: DEFAULT_CLEANUP,
		lastCleanup: row?.lastCleanup ?? null,
	};
}

export const metrics = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/metrics/hosts",
			tags,
			security,
			summary:
				"Host CPU, memory, disk and network, per node or for the cluster",
			middleware: [requirePermission("read", inOrganization)],
			request: { query: HostQuery },
			responses: { 200: json(HostMetricsResponse, "Series"), ...errors },
		}),
		async (c) => {
			const { range, nodeId, perNode } = c.req.valid("query");
			const { db } = c.var.deps;
			const nodes = await db
				.select({ id: node.id, swarmNodeId: node.swarmNodeId })
				.from(node)
				.where(
					and(
						eq(node.organizationId, requireActor(c).organizationId),
						nodeId ? eq(node.id, nodeId) : undefined,
					),
				);
			if (nodeId && !nodes.length) throw notFound("node");
			const w = await windowFor(db.$client, range);
			const cluster = !nodeId && !perNode;
			const series = await hostSeries(
				db.$client,
				nodes.map((n) => n.swarmNodeId),
				w,
				cluster,
			);
			const idOf = new Map(nodes.map((n) => [n.swarmNodeId, n.id]));
			return c.json(
				{
					range,
					source: w.source,
					stepSec: w.stepSec,
					from: w.from.getTime(),
					to: w.to.getTime(),
					series: cluster
						? [{ nodeId: null, points: series.get(null) ?? [] }]
						: nodes.map((n) => ({
								nodeId: idOf.get(n.swarmNodeId) ?? n.id,
								points: series.get(n.swarmNodeId) ?? [],
							})),
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/metrics/services/{id}",
			tags,
			security,
			summary: "A service's containers summed across replicas and nodes",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam, query: RangeQuery },
			responses: { 200: json(ContainerMetricsResponse, "Series"), ...errors },
		}),
		async (c) => {
			const { range } = c.req.valid("query");
			const { db } = c.var.deps;
			const w = await windowFor(db.$client, range);
			const points = await containerSeries(
				db.$client,
				{ serviceId: c.req.valid("param").id },
				w,
			);
			return c.json(
				{
					range,
					source: w.source,
					stepSec: w.stepSec,
					from: w.from.getTime(),
					to: w.to.getTime(),
					points,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/metrics/containers/{id}",
			tags,
			security,
			summary: "One container by its Docker id",
			middleware: [requirePermission("read", inOrganization)],
			request: { params: IdParam, query: RangeQuery },
			responses: { 200: json(ContainerMetricsResponse, "Series"), ...errors },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { range } = c.req.valid("query");
			const { db } = c.var.deps;
			const sql = db.$client;
			// The container must have run on one of the actor's nodes.
			const [owner] = await sql<{ ok: number }[]>`
				select 1 as ok from metric_container_1h m
				join node n on n.swarm_node_id = m.node_id
				where m.container_id = ${id} and n.organization_id = ${requireActor(c).organizationId}
				union all
				select 1 from metric_container_raw m
				join node n on n.swarm_node_id = m.node_id
				where m.container_id = ${id} and n.organization_id = ${requireActor(c).organizationId}
				limit 1`;
			if (!owner) throw notFound("container");
			const w = await windowFor(sql, range);
			const points = await containerSeries(sql, { containerId: id }, w);
			return c.json(
				{
					range,
					source: w.source,
					stepSec: w.stepSec,
					from: w.from.getTime(),
					to: w.to.getTime(),
					points,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/monitoring/settings",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(MonitoringSettings, "Settings"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const thresholds = await db
				.select()
				.from(metricThreshold)
				.where(
					eq(metricThreshold.organizationId, requireActor(c).organizationId),
				)
				.orderBy(metricThreshold.createdAt);
			return c.json(
				{
					retention: await loadRetention(db.$client),
					...(await loadCleanup(db)),
					thresholds: thresholds.map((t) => ({
						id: t.id,
						metric: t.metric,
						nodeId: t.nodeId,
						percent: t.percent,
						forSec: t.forSec,
						enabled: t.enabled,
					})),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"monitoring.update",
			createRoute({
				method: "put",
				path: "/monitoring/settings",
				tags,
				security,
				summary:
					"Replace retention and node cleanup (instance-wide) and the organization's thresholds",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(SettingsInput),
				responses: { 200: json(MonitoringSettings, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const organizationId = requireActor(c).organizationId;
			const { db } = c.var.deps;
			const nodeIds = new Set(
				(
					await db
						.select({ id: node.id })
						.from(node)
						.where(eq(node.organizationId, organizationId))
				).map((n) => n.id),
			);
			for (const t of input.thresholds)
				if (t.nodeId && !nodeIds.has(t.nodeId)) throw notFound("node");
			if (input.retention.minuteDays * 24 < input.retention.rawHours)
				throw new Failure(
					"bad_request",
					"1-minute retention must outlast raw retention",
				);
			const saved = await db.transaction(async (tx) => {
				const r = {
					rawRetentionHours: input.retention.rawHours,
					minuteRetentionDays: input.retention.minuteDays,
					hourRetentionDays: input.retention.hourDays,
					...(input.cleanup && {
						cleanupEnabled: input.cleanup.enabled,
						cleanupCron: input.cleanup.cron,
						cleanupTimezone: input.cleanup.timezone,
						cleanupTargets: input.cleanup.targets,
						cleanupUntilHours: input.cleanup.untilHours,
					}),
				};
				await tx
					.insert(monitoringSettings)
					.values(r)
					.onConflictDoUpdate({ target: monitoringSettings.id, set: r });
				const keep = input.thresholds.flatMap((t) => (t.id ? [t.id] : []));
				await tx
					.delete(metricThreshold)
					.where(
						and(
							eq(metricThreshold.organizationId, organizationId),
							keep.length ? notInArray(metricThreshold.id, keep) : undefined,
						),
					);
				const out = [];
				for (const { id, ...t } of input.thresholds) {
					const [row] = id
						? await tx
								.update(metricThreshold)
								.set(t)
								.where(
									and(
										eq(metricThreshold.id, id),
										eq(metricThreshold.organizationId, organizationId),
									),
								)
								.returning()
						: await tx
								.insert(metricThreshold)
								.values({ ...t, organizationId })
								.returning();
					if (!row) throw notFound("threshold");
					out.push({
						id: row.id,
						metric: row.metric,
						nodeId: row.nodeId,
						percent: row.percent,
						forSec: row.forSec,
						enabled: row.enabled,
					});
				}
				return out;
			});
			const cleanup = await loadCleanup(db);
			if (input.cleanup)
				await syncCleanupScheduler(
					runQueues(c.var.deps.config.REDIS_URL),
					cleanup.cleanup,
				);
			return c.json(
				{ retention: input.retention, thresholds: saved, ...cleanup },
				200,
			);
		},
	);
