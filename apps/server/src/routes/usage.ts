import { createRoute, z } from "@hono/zod-openapi";
import {
	type EnvironmentUsage,
	OrganizationUsage,
	ProjectUsage,
	type UsageFigures,
	UsageRange,
} from "@logistack/contracts";
import { type Db, folder, node, project } from "@logistack/db";
import type { NodeRunner } from "@logistack/worker/node-runner";
import { eq } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { errors, IdParam, json, router, security } from "../openapi.ts";
import {
	actorCan,
	byParam,
	organizationResource,
	requirePermission,
} from "../scope.ts";
import {
	type ServiceUsageRow,
	serviceUsage,
	usageTrend,
	usageWindow,
	volumeBytes,
} from "../usage-query.ts";

const tags = ["monitoring"];
const RangeQuery = z.object({ range: UsageRange.default("24h") });

const zero = (disk: Map<string, number> | null): UsageFigures => ({
	cpu: 0,
	memUsed: 0,
	rx: 0,
	tx: 0,
	disk: disk ? 0 : null,
});

function add(into: UsageFigures, f: UsageFigures) {
	into.cpu += f.cpu;
	into.memUsed += f.memUsed;
	into.rx += f.rx;
	into.tx += f.tx;
	if (into.disk !== null && f.disk !== null) into.disk += f.disk;
}

/** Service rows with their volume bytes; disk stays null when no node reported volumes. */
function withDisk(rows: ServiceUsageRow[], disk: Map<string, number> | null) {
	return rows.map((r) => ({
		...r,
		disk: disk ? (disk.get(r.serviceId ?? "") ?? 0) : null,
	}));
}

async function orgNodes(db: Db, organizationId: string) {
	return db
		.select({ swarmNodeId: node.swarmNodeId, facts: node.facts })
		.from(node)
		.where(eq(node.organizationId, organizationId));
}

async function diskFor(db: Db, nodes: NodeRunner, organizationId: string) {
	const rows = await orgNodes(db, organizationId);
	return volumeBytes(
		db,
		nodes,
		rows.map((n) => n.swarmNodeId),
	);
}

const windowOf = (w: Awaited<ReturnType<typeof usageWindow>>) => ({
	stepSec: w.stepSec,
	from: w.from.getTime(),
	to: w.to.getTime(),
});

export const usage = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/usage",
			tags,
			security,
			summary:
				"CPU, memory, network and volume usage per project, totals and trend, against cluster capacity",
			description:
				"Covers only the projects the caller can read. CPU is average cores and memory average bytes over the range; network is bytes transferred; disk is current volume size.",
			request: { query: RangeQuery },
			responses: { 200: json(OrganizationUsage, "Usage"), ...errors },
		}),
		async (c) => {
			const actor = requireActor(c);
			const { range } = c.req.valid("query");
			const { db, nodes } = c.var.deps;
			const all = await db
				.select({
					id: project.id,
					folderId: project.folderId,
					parentFolderId: folder.parentId,
				})
				.from(project)
				.leftJoin(folder, eq(folder.id, project.folderId))
				.where(eq(project.organizationId, actor.organizationId));
			const visible = all
				.filter((p) =>
					actorCan(actor, "read", {
						type: "project",
						organizationId: actor.organizationId,
						folderIds: [p.parentFolderId, p.folderId].filter(
							(id): id is string => id !== null,
						),
						projectId: p.id,
					}),
				)
				.map((p) => p.id);
			const w = await usageWindow(db.$client, range);
			const [rows, trend, disk, nodeRows] = await Promise.all([
				serviceUsage(db.$client, visible, w),
				usageTrend(db.$client, visible, w),
				visible.length
					? diskFor(db, nodes, actor.organizationId)
					: Promise.resolve(null),
				orgNodes(db, actor.organizationId),
			]);
			const byProject = new Map<
				string,
				UsageFigures & { id: string; name: string }
			>();
			const totals = zero(disk);
			for (const r of withDisk(rows, disk)) {
				const p = byProject.get(r.projectId) ?? {
					id: r.projectId,
					name: r.projectName,
					...zero(disk),
				};
				add(p, r);
				add(totals, r);
				byProject.set(r.projectId, p);
			}
			let capacity: OrganizationUsage["capacity"] = null;
			if (actorCan(actor, "read", organizationResource(actor.organizationId))) {
				const latest = nodeRows.length
					? await db.$client<{ mem: number; disk: number }[]>`
						select coalesce(sum(mem_total), 0)::float8 as mem, coalesce(sum(disk_total), 0)::float8 as disk
						from (select distinct on (node_id) mem_total, disk_total from metric_host_1m
							where node_id = any(${nodeRows.map((n) => n.swarmNodeId)}::text[])
								and ts >= now() - interval '1 day'
							order by node_id, ts desc) l`
					: [];
				capacity = {
					cpus: nodeRows.reduce((s, n) => s + (n.facts.cpus ?? 0), 0),
					memory:
						latest[0]?.mem ||
						nodeRows.reduce((s, n) => s + (n.facts.memoryBytes ?? 0), 0),
					disk: latest[0]?.disk ?? 0,
				};
			}
			return c.json(
				{
					range,
					...windowOf(w),
					totals,
					trend,
					capacity,
					projects: [...byProject.values()],
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/projects/{id}/usage",
			tags,
			security,
			summary:
				"A project's CPU, memory, network and volume usage per environment and service, with its trend",
			middleware: [requirePermission("read", byParam("project"))],
			request: { params: IdParam, query: RangeQuery },
			responses: { 200: json(ProjectUsage, "Usage"), ...errors },
		}),
		async (c) => {
			const actor = requireActor(c);
			const { id } = c.req.valid("param");
			const { range } = c.req.valid("query");
			const { db, nodes } = c.var.deps;
			const w = await usageWindow(db.$client, range);
			const [rows, trend, disk] = await Promise.all([
				serviceUsage(db.$client, [id], w),
				usageTrend(db.$client, [id], w),
				diskFor(db, nodes, actor.organizationId),
			]);
			const totals = zero(disk);
			const envs = new Map<string, EnvironmentUsage>();
			for (const r of withDisk(rows, disk)) {
				if (!r.environmentId) continue;
				const e = envs.get(r.environmentId) ?? {
					id: r.environmentId,
					name: r.environmentName ?? "",
					...zero(disk),
					services: [],
				};
				envs.set(r.environmentId, e);
				if (!r.serviceId) continue;
				const figures = {
					cpu: r.cpu,
					memUsed: r.memUsed,
					rx: r.rx,
					tx: r.tx,
					disk: r.disk,
				};
				e.services.push({
					id: r.serviceId,
					name: r.serviceName ?? "",
					...figures,
				});
				add(e, figures);
				add(totals, figures);
			}
			return c.json(
				{
					range,
					...windowOf(w),
					totals,
					trend,
					environments: [...envs.values()],
				},
				200,
			);
		},
	);
