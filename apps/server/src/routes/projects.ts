import { createRoute, z } from "@hono/zod-openapi";
import {
	EnvironmentColor,
	EnvironmentKind,
	ObservedState,
} from "@logistack/contracts";
import { environment, project, service, serviceStatus } from "@logistack/db";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { auditInTx, mutation } from "../audit.ts";
import { one } from "../errors.ts";
import {
	body,
	Environment,
	errors,
	IdParam,
	json,
	Name,
	Project,
	patchOf,
	router,
	Slug,
	security,
	slugify,
} from "../openapi.ts";
import { requestProxySync, requestReconcile } from "../redis.ts";
import {
	byParam,
	check,
	inOrganization,
	locate,
	organizationResource,
	requirePermission,
} from "../scope.ts";

const ProjectInput = z.object({
	name: Name,
	slug: Slug.optional(),
	description: z.string().max(1000).nullable().optional(),
	folderId: z.string().nullable().optional(),
});

/**
 * A project with what list views draw: its environments and one status signal per service.
 * Counts and the aggregate health derive from these.
 */
const ProjectListItem = Project.extend({
	environments: z.array(
		Environment.pick({ id: true, name: true, kind: true, color: true }),
	),
	services: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			status: ObservedState,
			environmentId: z.string().optional(),
		}),
	),
}).openapi("ProjectListItem");

const EnvironmentInput = z.object({
	name: Name,
	slug: Slug.optional(),
	kind: EnvironmentKind,
	color: EnvironmentColor.nullable().optional(),
});

const EnvironmentPatch = patchOf(EnvironmentInput).extend({
	/** Only `true`: making one environment the default unsets the previous one. */
	isDefault: z.literal(true).optional(),
});

/** The periodic pass converges anyway; this only makes it immediate. */
const converge = (redisUrl: string, reason: string) =>
	Promise.all([
		requestReconcile(redisUrl, reason),
		requestProxySync(redisUrl, reason),
	]).catch(() => {});

const archiveRoute = <P extends string>(
	path: P,
	summary: string,
	description: string,
) =>
	createRoute({
		method: "post",
		path,
		tags: ["projects"],
		security,
		summary,
		description,
		middleware: [requirePermission("deploy", byParam("project"))],
		request: { params: IdParam },
		responses: { 200: json(Project, "Updated"), ...errors },
	});

const servicesOf = (projectId: string) =>
	sql`${service.environmentId} in (select ${environment.id} from ${environment} where ${environment.projectId} = ${projectId})`;

export const projects = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/projects",
			tags: ["projects"],
			security,
			middleware: [requirePermission("read", inOrganization)],
			summary: "List projects",
			description:
				"Active projects by default; `archived=true` lists the archived ones instead.",
			request: {
				query: z.object({
					folderId: z.string().optional(),
					archived: z.stringbool().default(false),
				}),
			},
			responses: {
				200: json(z.array(ProjectListItem), "Projects"),
				...errors,
			},
		}),
		async (c) => {
			const { folderId, archived } = c.req.valid("query");
			const { db } = c.var.deps;
			const rows = await db
				.select()
				.from(project)
				.where(
					and(
						eq(project.organizationId, requireActor(c).organizationId),
						folderId ? eq(project.folderId, folderId) : undefined,
						archived
							? isNotNull(project.archivedAt)
							: isNull(project.archivedAt),
					),
				)
				.orderBy(asc(project.name));
			const ids = rows.map((p) => p.id);
			const [envs, services] = ids.length
				? await Promise.all([
						db
							.select({
								id: environment.id,
								name: environment.name,
								kind: environment.kind,
								color: environment.color,
								projectId: environment.projectId,
							})
							.from(environment)
							.where(inArray(environment.projectId, ids))
							.orderBy(asc(environment.createdAt)),
						db
							.select({
								id: service.id,
								name: service.name,
								status: sql<ObservedState>`coalesce(${serviceStatus.observed}, 'unknown')`,
								environmentId: service.environmentId,
								projectId: environment.projectId,
							})
							.from(service)
							.innerJoin(environment, eq(environment.id, service.environmentId))
							.leftJoin(serviceStatus, eq(serviceStatus.serviceId, service.id))
							.where(inArray(environment.projectId, ids))
							.orderBy(asc(service.name)),
					])
				: [[], []];
			return c.json(
				rows.map((p) => ({
					...p,
					environments: envs
						.filter((e) => e.projectId === p.id)
						.map(({ projectId: _, ...e }) => e),
					services: services
						.filter((s) => s.projectId === p.id)
						.map(({ projectId: _, ...s }) => s),
				})),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"project.create",
			createRoute({
				method: "post",
				path: "/projects",
				tags: ["projects"],
				security,
				summary: "Create a project with a default production environment",
				request: body(ProjectInput),
				responses: { 201: json(Project, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			check(
				c,
				"write",
				input.folderId
					? await locate(db, orgId, "folder", input.folderId)
					: organizationResource(orgId),
			);
			const row = await db.transaction(async (tx) => {
				const created = one(
					await tx
						.insert(project)
						.values({
							organizationId: orgId,
							folderId: input.folderId ?? null,
							name: input.name,
							slug: input.slug ?? slugify(input.name),
							description: input.description ?? null,
						})
						.returning(),
				);
				await tx.insert(environment).values({
					projectId: created.id,
					name: "Production",
					slug: "production",
					kind: "production",
					isDefault: true,
				});
				await auditInTx(c, tx, { resourceId: created.id });
				return created;
			});
			return c.json(row, 201);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/projects/{id}",
			tags: ["projects"],
			security,
			middleware: [requirePermission("read", byParam("project"))],
			request: { params: IdParam },
			responses: { 200: json(Project, "Project"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(project)
				.where(eq(project.id, c.req.valid("param").id));
			return c.json(one(rows, "project"), 200);
		},
	)
	.openapi(
		mutation(
			"project.update",
			createRoute({
				method: "patch",
				path: "/projects/{id}",
				tags: ["projects"],
				security,
				summary: "Rename, describe or move a project",
				description: "Archiving has its own routes.",
				middleware: [requirePermission("write", byParam("project"))],
				request: { params: IdParam, ...body(patchOf(ProjectInput)) },
				responses: { 200: json(Project, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			if (input.folderId)
				check(c, "write", await locate(db, orgId, "folder", input.folderId));
			const row = one(
				await db
					.update(project)
					.set(input)
					.where(eq(project.id, id))
					.returning(),
			);
			return c.json(row, 200);
		},
	)
	.openapi(
		mutation(
			"project.delete",
			createRoute({
				method: "delete",
				path: "/projects/{id}",
				tags: ["projects"],
				security,
				middleware: [requirePermission("delete", byParam("project"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			await c.var.deps.db
				.delete(project)
				.where(eq(project.id, c.req.valid("param").id));
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"project.archive",
			archiveRoute(
				"/projects/{id}/archive",
				"Archive a project: stop its services and hide it",
				"Stops every running service (replicas to zero; data, configuration and replica counts stay), hides the project from the default list and refuses deploys until it is unarchived. Idempotent.",
			),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db, config } = c.var.deps;
			const row = await db.transaction(async (tx) => {
				await auditInTx(c, tx);
				await tx
					.update(service)
					.set({ desiredState: "stopped", stoppedByArchive: true })
					.where(and(servicesOf(id), eq(service.desiredState, "running")));
				return one(
					await tx
						.update(project)
						.set({ archivedAt: sql`coalesce(${project.archivedAt}, now())` })
						.where(eq(project.id, id))
						.returning(),
				);
			});
			await converge(config.REDIS_URL, "project archived");
			return c.json(row, 200);
		},
	)
	.openapi(
		mutation(
			"project.unarchive",
			archiveRoute(
				"/projects/{id}/unarchive",
				"Unarchive a project and restart what archiving stopped",
				"Starts again exactly the services archiving stopped, at their configured replica counts; services that were already stopped stay stopped. Idempotent.",
			),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db, config } = c.var.deps;
			const row = await db.transaction(async (tx) => {
				await auditInTx(c, tx);
				await tx
					.update(service)
					.set({ desiredState: "running", stoppedByArchive: false })
					.where(and(servicesOf(id), eq(service.stoppedByArchive, true)));
				return one(
					await tx
						.update(project)
						.set({ archivedAt: null })
						.where(eq(project.id, id))
						.returning(),
				);
			});
			await converge(config.REDIS_URL, "project unarchived");
			return c.json(row, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/projects/{id}/environments",
			tags: ["environments"],
			security,
			middleware: [requirePermission("read", byParam("project"))],
			request: { params: IdParam },
			responses: { 200: json(z.array(Environment), "Environments"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(environment)
				.where(eq(environment.projectId, c.req.valid("param").id))
				.orderBy(asc(environment.createdAt));
			return c.json(rows, 200);
		},
	)
	.openapi(
		mutation(
			"environment.create",
			createRoute({
				method: "post",
				path: "/projects/{id}/environments",
				tags: ["environments"],
				security,
				middleware: [requirePermission("write", byParam("project"))],
				request: { params: IdParam, ...body(EnvironmentInput) },
				responses: { 201: json(Environment, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const row = one(
				await c.var.deps.db
					.insert(environment)
					.values({
						projectId: c.req.valid("param").id,
						name: input.name,
						slug: input.slug ?? slugify(input.name),
						kind: input.kind,
						color: input.color ?? null,
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			return c.json(row, 201);
		},
	)
	.openapi(
		mutation(
			"environment.update",
			createRoute({
				method: "patch",
				path: "/environments/{id}",
				tags: ["environments"],
				security,
				summary: "Rename, recolor or make an environment the project's default",
				middleware: [requirePermission("write", byParam("environment"))],
				request: { params: IdParam, ...body(EnvironmentPatch) },
				responses: { 200: json(Environment, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const row = await c.var.deps.db.transaction(async (tx) => {
				await auditInTx(c, tx);
				if (input.isDefault) {
					const projectId = sql`(select ${environment.projectId} from ${environment} where ${environment.id} = ${id})`;
					// One default per project (partial unique index): clear the old one first.
					await tx
						.update(environment)
						.set({ isDefault: false })
						.where(
							and(
								eq(environment.isDefault, true),
								sql`${environment.projectId} = ${projectId}`,
							),
						);
				}
				return one(
					await tx
						.update(environment)
						.set(input)
						.where(eq(environment.id, id))
						.returning(),
				);
			});
			return c.json(row, 200);
		},
	)
	.openapi(
		mutation(
			"environment.delete",
			createRoute({
				method: "delete",
				path: "/environments/{id}",
				tags: ["environments"],
				security,
				middleware: [requirePermission("delete", byParam("environment"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			await c.var.deps.db
				.delete(environment)
				.where(eq(environment.id, c.req.valid("param").id));
			return c.body(null, 204);
		},
	);
