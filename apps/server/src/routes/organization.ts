import { createRoute, z } from "@hono/zod-openapi";
import { observedStates } from "@logistack/contracts";
import type { Grant } from "@logistack/core";
import {
	deployment,
	environment,
	project,
	service,
	serviceStatus,
} from "@logistack/db";
import { count, desc, eq, sql } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { Deployment, errors, json, router, security } from "../openapi.ts";
import { inOrganization, requirePermission } from "../scope.ts";

const Named = z.object({ id: z.string(), name: z.string() });

const roleName = (g: Grant) =>
	typeof g.role === "string" ? g.role : g.role.id;

export const organizationRoutes = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/me",
			tags: ["identity"],
			security,
			summary: "The authenticated actor",
			responses: {
				200: json(
					z.object({
						kind: z.string(),
						id: z.string(),
						userId: z.string(),
						organizationId: z.string(),
						/** Organization-wide roles. */
						roles: z.array(z.string()),
						/** Every grant, organization-wide and scoped. */
						grants: z.array(
							z.object({
								role: z.string(),
								scope: z.object({ kind: z.string(), id: z.string() }),
							}),
						),
						/** Set when the credential is a scoped API key: it may act only within these. */
						keyScopes: z
							.array(
								z.object({
									role: z.string(),
									scope: z.object({ kind: z.string(), id: z.string() }),
								}),
							)
							.nullable(),
					}),
					"Actor",
				),
				...errors,
			},
		}),
		(c) => {
			const { grants, keyScopes, keyId: _, ...actor } = requireActor(c);
			const bindings = (gs: Grant[]) =>
				gs.map((g) => ({ role: roleName(g), scope: g.scope }));
			return c.json(
				{
					...actor,
					roles: grants
						.filter((g) => g.scope.kind === "organization")
						.map(roleName),
					grants: bindings(grants),
					keyScopes: keyScopes ? bindings(keyScopes) : null,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/home/summary",
			tags: ["home"],
			security,
			summary: "Counts by status and recent deployments",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(
					z.object({
						projects: z.int(),
						services: z.record(z.enum(observedStates), z.int()),
						recentDeployments: z.array(
							Deployment.extend({
								service: Named,
								environment: Named,
								project: Named,
							}),
						),
					}),
					"Summary",
				),
				...errors,
			},
		}),
		async (c) => {
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const observed = sql<
				(typeof observedStates)[number]
			>`coalesce(${serviceStatus.observed}, 'unknown')`;
			const [projects, byStatus, recentDeployments] = await Promise.all([
				db.$count(project, eq(project.organizationId, orgId)),
				db
					.select({ status: observed, n: count() })
					.from(service)
					.innerJoin(environment, eq(environment.id, service.environmentId))
					.innerJoin(project, eq(project.id, environment.projectId))
					.leftJoin(serviceStatus, eq(serviceStatus.serviceId, service.id))
					.where(eq(project.organizationId, orgId))
					.groupBy(observed),
				db
					.select({
						deployment,
						service: { id: service.id, name: service.name },
						environment: { id: environment.id, name: environment.name },
						project: { id: project.id, name: project.name },
					})
					.from(deployment)
					.innerJoin(service, eq(service.id, deployment.serviceId))
					.innerJoin(environment, eq(environment.id, service.environmentId))
					.innerJoin(project, eq(project.id, environment.projectId))
					.where(eq(project.organizationId, orgId))
					.orderBy(desc(deployment.createdAt))
					.limit(10),
			]);
			const services = Object.fromEntries(
				observedStates.map((s) => [s, 0]),
			) as Record<(typeof observedStates)[number], number>;
			for (const r of byStatus) services[r.status] = r.n;
			return c.json(
				{
					projects,
					services,
					recentDeployments: recentDeployments.map(
						({ deployment: d, ...names }) => ({ ...d, ...names }),
					),
				},
				200,
			);
		},
	);
