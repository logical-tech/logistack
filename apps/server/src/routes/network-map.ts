import { createRoute, z } from "@hono/zod-openapi";
import { NetworkMap } from "@logistack/contracts";
import { networkMap } from "@logistack/core";
import {
	cloudflareTunnel,
	dnsProvider,
	domain,
	environment,
	folder,
	node,
	project,
	service,
	serviceStatus,
} from "@logistack/db";
import { eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireActor } from "../actor.ts";
import { errors, json, router, security } from "../openapi.ts";
import { actorCan } from "../scope.ts";
import { tlsMode } from "./domains.ts";
import { TaskView } from "./service-ops.ts";

export const networkMapRoutes = router().openapi(
	createRoute({
		method: "get",
		path: "/network-map",
		tags: ["networking"],
		security,
		summary:
			"How traffic reaches every service the caller can read: proxy, tunnels, domains, tasks",
		description:
			"Filtered per service, so a grant on one project maps only that project. Task state is what the reconciler last observed.",
		responses: {
			200: json(NetworkMap, "Map"),
			...errors,
		},
	}),
	async (c) => {
		const actor = requireActor(c);
		const { db } = c.var.deps;
		// Folders nest at most two deep, so the project's folder and its parent are the whole path.
		const parent = alias(folder, "parent_folder");
		const rows = await db
			.select({
				service,
				status: serviceStatus,
				environment: { id: environment.id, name: environment.name },
				project: {
					id: project.id,
					name: project.name,
					folderId: project.folderId,
				},
				folder: { id: folder.id, name: folder.name },
				parent: { id: parent.id, name: parent.name },
			})
			.from(service)
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(project, eq(project.id, environment.projectId))
			.leftJoin(folder, eq(folder.id, project.folderId))
			.leftJoin(parent, eq(parent.id, folder.parentId))
			.leftJoin(serviceStatus, eq(serviceStatus.serviceId, service.id))
			.where(eq(project.organizationId, actor.organizationId));
		const visible = rows.filter((r) =>
			actorCan(actor, "read", {
				type: "service",
				organizationId: actor.organizationId,
				folderIds: [r.parent?.id, r.project.folderId].filter(
					(id): id is string => !!id,
				),
				projectId: r.project.id,
				environmentId: r.environment.id,
				serviceId: r.service.id,
			}),
		);
		const ids = visible.map((r) => r.service.id);
		const [domains, providers, nodes] = await Promise.all([
			ids.length
				? db.select().from(domain).where(inArray(domain.serviceId, ids))
				: [],
			// Tunnel cards read better under the tunnel's own name than its provider's.
			db
				.select({
					id: dnsProvider.id,
					name: sql<string>`coalesce(${cloudflareTunnel.name}, ${dnsProvider.name})`,
				})
				.from(dnsProvider)
				.leftJoin(
					cloudflareTunnel,
					eq(cloudflareTunnel.dnsProviderId, dnsProvider.id),
				)
				.where(eq(dnsProvider.organizationId, actor.organizationId)),
			db
				.select({
					id: node.id,
					swarmNodeId: node.swarmNodeId,
					hostname: node.hostname,
				})
				.from(node)
				.where(eq(node.organizationId, actor.organizationId)),
		]);
		const map = networkMap({
			services: visible.map((r) => ({
				id: r.service.id,
				name: r.service.name,
				kind: r.service.kind,
				icon: r.service.icon,
				spec: r.service.spec,
				status: r.status,
				tasks: z
					.array(TaskView)
					.catch([])
					.parse(r.status?.tasks ?? []),
				projectId: r.project.id,
				projectName: r.project.name,
				environmentId: r.environment.id,
				environmentName: r.environment.name,
				folders: [r.parent, r.folder].filter((f) => f !== null),
			})),
			domains: domains.map((d) => ({ ...d, tls: tlsMode(d) })),
			providers: new Map(providers.map((p) => [p.id, p.name])),
			nodes,
		});
		return c.json(map, 200);
	},
);
