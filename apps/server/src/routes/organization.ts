import { createRoute, z } from "@hono/zod-openapi";
import {
	observedStates,
	TwoFactorPolicy,
	twoFactorAccessKinds,
} from "@logistack/contracts";
import type { Grant } from "@logistack/core";
import {
	deployment,
	environment,
	project,
	service,
	serviceStatus,
} from "@logistack/db";
import { and, count, desc, eq, ne, sql } from "drizzle-orm";
import { currentActor, requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import {
	body,
	Deployment,
	errors,
	json,
	router,
	security,
} from "../openapi.ts";
import { inOrganization, requirePermission } from "../scope.ts";
import { readTwoFactorPolicy, writeTwoFactorPolicy } from "../two-factor.ts";

const TwoFactorSetting = TwoFactorPolicy.extend({
	/** When the requirement was switched on; the grace period of existing members counts from it. */
	enabledAt: z.string().nullable(),
}).openapi("TwoFactorSetting");

const settingJson = (p: Awaited<ReturnType<typeof readTwoFactorPolicy>>) => ({
	...p,
	enabledAt: p.enabledAt?.toISOString() ?? null,
});

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
						/** Set while the organization requires a second factor this person has not added. */
						twoFactor: z
							.object({
								kind: z.enum(twoFactorAccessKinds),
								deadline: z.string(),
							})
							.nullable(),
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
			const {
				grants,
				keyScopes,
				keyId: _,
				twoFactor,
				...actor
			} = currentActor(c);
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
					twoFactor:
						twoFactor && twoFactor.kind !== "allow"
							? {
									kind: twoFactor.kind,
									deadline: twoFactor.deadline.toISOString(),
								}
							: null,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/organization/two-factor",
			tags: ["identity"],
			security,
			summary: "The organization's two-factor requirement",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(TwoFactorSetting, "Setting"), ...errors },
		}),
		async (c) =>
			c.json(
				settingJson(
					await readTwoFactorPolicy(
						c.var.deps.db,
						requireActor(c).organizationId,
					),
				),
				200,
			),
	)
	.openapi(
		mutation(
			"organization.two_factor_update",
			createRoute({
				method: "put",
				path: "/organization/two-factor",
				tags: ["identity"],
				security,
				summary: "Require two-factor authentication for every member",
				description:
					"Members without an authenticator app or a passkey are prompted to add one, and lose access once `graceDays` have passed since the requirement was switched on or since they joined, whichever is later. API keys and service accounts are exempt.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(TwoFactorPolicy),
				responses: { 200: json(TwoFactorSetting, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const { before, after } = await writeTwoFactorPolicy(
				c.var.deps.db,
				requireActor(c).organizationId,
				c.req.valid("json"),
			);
			c.set("auditDiff", {
				before: settingJson(before),
				after: settingJson(after),
			});
			return c.json(settingJson(after), 200);
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
					.where(
						and(
							eq(project.organizationId, orgId),
							ne(deployment.status, "skipped"),
						),
					)
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
