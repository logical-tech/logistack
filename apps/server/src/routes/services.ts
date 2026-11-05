import { createRoute, z } from "@hono/zod-openapi";
import {
	ApplicationSource,
	DesiredState,
	defaultServiceIcon,
	ObservedState,
	ServiceIcon,
	ServiceSpec,
} from "@logistack/contracts";
import {
	databaseCredentials,
	encrypt,
	storageCredentials,
} from "@logistack/core";
import {
	deployment,
	domain,
	envVar,
	mount,
	service,
	serviceStatus,
} from "@logistack/db";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, one } from "../errors.ts";
import { envelope } from "../events.ts";
import { guardHostSettings } from "../host-settings.ts";
import {
	body,
	Deployment,
	errors,
	IdParam,
	json,
	Name,
	patchOf,
	router,
	Service,
	Slug,
	security,
	slugify,
} from "../openapi.ts";
import { checkGit, checkImage } from "../probe.ts";
import { byParam, inOrganization, requirePermission } from "../scope.ts";
import { hostPolicy } from "../ssrf.ts";
import { ConfigContent, MountTarget } from "./files.ts";

/** The service row plus what list views draw: observed state, last deployment, hostnames. */
const ServiceListItem = Service.extend({
	status: z.object({
		observed: ObservedState,
		replicasRunning: z.int(),
		replicasDesired: z.int(),
		/** null until the reconciler first reports. */
		observedAt: z.string().nullable(),
	}),
	latestDeployment: Deployment.nullable(),
	domains: z.array(z.string()),
}).openapi("ServiceListItem");

const SourceCheck = z
	.object({
		ok: z.boolean(),
		message: z.string(),
		detail: z.string().optional(),
	})
	.openapi("SourceCheck");

const ServiceInput = z.object({
	name: Name,
	slug: Slug.optional(),
	/** Validated per kind; the service's kind is the spec's. */
	spec: ServiceSpec,
	/** Node a service with bind mounts is pinned to; default the only node, else the only manager. */
	nodeId: z.string().optional(),
	/** Set by importers, e.g. `dokploy:<appName>/<service>`; a re-import skips a service that has it. */
	importedFrom: z.string().min(1).max(255).optional(),
	/** Defaults to the engine's or image's brand icon. */
	icon: ServiceIcon.optional(),
	/** Config files (stored encrypted, mounted as Swarm configs) and named volumes. */
	mounts: z
		.array(
			z.discriminatedUnion("kind", [
				z.object({
					kind: z.literal("config"),
					target: MountTarget,
					content: ConfigContent,
				}),
				z.object({
					kind: z.literal("volume"),
					target: MountTarget,
					name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
				}),
			]),
		)
		.max(8)
		.refine(
			(ms) => new Set(ms.map((m) => m.target)).size === ms.length,
			"duplicate target",
		)
		.optional(),
});

const ServicePatch = patchOf(
	z.object({
		name: Name,
		slug: Slug,
		spec: ServiceSpec,
		desiredState: DesiredState,
		/** null resets to the default icon. */
		icon: ServiceIcon.nullable(),
	}),
);

export const services = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/environments/{id}/services",
			tags: ["services"],
			security,
			middleware: [requirePermission("read", byParam("environment"))],
			request: { params: IdParam },
			responses: {
				200: json(z.array(ServiceListItem), "Services"),
				...errors,
			},
		}),
		async (c) => {
			const { db } = c.var.deps;
			const rows = await db
				.select({ service, status: serviceStatus })
				.from(service)
				.leftJoin(serviceStatus, eq(serviceStatus.serviceId, service.id))
				.where(eq(service.environmentId, c.req.valid("param").id))
				.orderBy(asc(service.name));
			const ids = rows.map((r) => r.service.id);
			const [latest, hosts] = ids.length
				? await Promise.all([
						db
							.selectDistinctOn([deployment.serviceId])
							.from(deployment)
							.where(
								and(
									inArray(deployment.serviceId, ids),
									ne(deployment.status, "skipped"),
								),
							)
							.orderBy(deployment.serviceId, desc(deployment.createdAt)),
						db
							.select({
								serviceId: domain.serviceId,
								hostname: domain.hostname,
							})
							.from(domain)
							.where(inArray(domain.serviceId, ids))
							.orderBy(asc(domain.hostname)),
					])
				: [[], []];
			return c.json(
				rows.map(({ service: s, status }) => ({
					...s,
					status: {
						observed: status?.observed ?? ("unknown" as const),
						replicasRunning: status?.replicasRunning ?? 0,
						replicasDesired: status?.replicasDesired ?? 0,
						observedAt: status?.observedAt ?? null,
					},
					latestDeployment: latest.find((d) => d.serviceId === s.id) ?? null,
					domains: hosts
						.filter((h) => h.serviceId === s.id)
						.map((h) => h.hostname),
				})),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"service.create",
			createRoute({
				method: "post",
				path: "/environments/{id}/services",
				tags: ["services"],
				security,
				middleware: [requirePermission("write", byParam("environment"))],
				request: { params: IdParam, ...body(ServiceInput) },
				responses: { 201: json(Service, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const nodeId = await guardHostSettings(c, {
				spec: input.spec,
				nodeId: null,
				...(input.nodeId ? { requestedNodeId: input.nodeId } : {}),
			});
			const { db, masterKey } = c.var.deps;
			const spec = input.spec;
			const row = await db.transaction(async (tx) => {
				const created = one(
					await tx
						.insert(service)
						.values({
							environmentId: c.req.valid("param").id,
							name: input.name,
							slug: input.slug ?? slugify(input.name),
							kind: spec.kind,
							spec,
							nodeId: nodeId ?? null,
							createdBy: requireActor(c).userId,
							importedFrom: input.importedFrom ?? null,
							icon: input.icon ?? defaultServiceIcon(spec),
						})
						.returning(),
				);
				// Storage and database credentials are minted here and only ever live encrypted in the service env.
				const minted =
					spec.kind === "storage"
						? storageCredentials(spec.engine)
						: spec.kind === "database"
							? databaseCredentials(spec.engine)
							: undefined;
				for (const m of input.mounts ?? [])
					await tx.insert(mount).values({
						serviceId: created.id,
						kind: m.kind,
						target: m.target,
						...(m.kind === "volume"
							? { volumeName: m.name }
							: { contentEncrypted: await encrypt(masterKey, m.content) }),
					});
				if (minted)
					await tx.insert(envVar).values(
						await Promise.all(
							Object.entries(minted).map(async ([key, value]) => ({
								scope: "service" as const,
								scopeId: created.id,
								key,
								valueEncrypted: await encrypt(masterKey, value),
								isSecret: true,
							})),
						),
					);
				return created;
			});
			c.set("auditResourceId", row.id);
			return c.json(row, 201);
		},
	)
	.openapi(
		mutation(
			"service.check_source",
			createRoute({
				method: "post",
				path: "/services/check-source",
				tags: ["services"],
				security,
				summary:
					"Check a Git repository or image is reachable before creating a service",
				description:
					"Git: `git ls-remote` over https, without the server's credentials. Image: a manifest HEAD against its registry with an anonymous token. Nothing is stored.",
				middleware: [requirePermission("write", inOrganization)],
				request: body(ApplicationSource),
				responses: { 200: json(SourceCheck, "Result"), ...errors },
			}),
		),
		async (c) => {
			const source = c.req.valid("json");
			const policy = await hostPolicy(c.var.deps.db);
			return c.json(
				source.type === "git"
					? await checkGit(source, policy)
					: await checkImage(source.image, policy),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}",
			tags: ["services"],
			security,
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(Service, "Service"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(service)
				.where(eq(service.id, c.req.valid("param").id));
			return c.json(one(rows, "service"), 200);
		},
	)
	.openapi(
		mutation(
			"service.update",
			createRoute({
				method: "patch",
				path: "/services/{id}",
				tags: ["services"],
				security,
				summary:
					"Update name, spec or desired state (persisted; the reconciler converges)",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(ServicePatch) },
				responses: { 200: json(Service, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const [current] = await db
				.select({
					kind: service.kind,
					spec: service.spec,
					nodeId: service.nodeId,
				})
				.from(service)
				.where(eq(service.id, id));
			if (input.spec && input.spec.kind !== current?.kind)
				throw new Failure("bad_request", "spec.kind cannot change", {
					kind: current?.kind,
				});
			if (
				input.spec?.kind === "storage" &&
				current?.spec.kind === "storage" &&
				input.spec.engine !== current.spec.engine
			)
				throw new Failure(
					"bad_request",
					"spec.engine cannot change: the data volume belongs to the engine",
				);
			let nodeId: string | null | undefined;
			if (input.spec) {
				c.set("auditDiff", { before: current?.spec, after: input });
				nodeId = await guardHostSettings(c, {
					serviceId: id,
					spec: input.spec,
					before: current?.spec,
					nodeId: current?.nodeId ?? null,
				});
			}
			const row = one(
				await db
					.update(service)
					.set(nodeId ? { ...input, nodeId } : input)
					.where(eq(service.id, id))
					.returning(),
			);
			return c.json(row, 200);
		},
	)
	.openapi(
		mutation(
			"service.delete",
			createRoute({
				method: "delete",
				path: "/services/{id}",
				tags: ["services"],
				security,
				summary: "Delete a service",
				description:
					"Removes the desired state. Docker objects labelled with this service are garbage-collected by the reconciler.",
				middleware: [requirePermission("delete", byParam("service"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			await c.var.deps.db
				.delete(service)
				.where(eq(service.id, c.req.valid("param").id));
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/deployments",
			tags: ["deployments"],
			security,
			middleware: [requirePermission("read", byParam("service"))],
			request: {
				params: IdParam,
				query: z.object({
					limit: z.coerce.number().int().min(1).max(100).default(20),
				}),
			},
			responses: { 200: json(z.array(Deployment), "Newest first"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(deployment)
				.where(eq(deployment.serviceId, c.req.valid("param").id))
				.orderBy(desc(deployment.createdAt))
				.limit(c.req.valid("query").limit);
			return c.json(rows, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/deployments/{id}",
			tags: ["deployments"],
			security,
			middleware: [requirePermission("read", byParam("deployment"))],
			request: { params: IdParam },
			responses: { 200: json(Deployment, "Deployment"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(deployment)
				.where(eq(deployment.id, c.req.valid("param").id));
			return c.json(one(rows, "deployment"), 200);
		},
	)
	.openapi(
		mutation(
			"deployment.create",
			createRoute({
				method: "post",
				path: "/services/{id}/deploy",
				tags: ["deployments"],
				security,
				summary: "Queue a deployment",
				description:
					"Inserts a `queued` deployment and publishes `deployment.queued`.",
				middleware: [requirePermission("deploy", byParam("service"))],
				request: { params: IdParam },
				responses: { 202: json(Deployment, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const serviceId = c.req.valid("param").id;
			const actor = requireActor(c);
			const row = one(
				await c.var.deps.db
					.insert(deployment)
					.values({
						serviceId,
						trigger: actor.kind === "user" ? "manual" : "api",
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			await c.var.deps.bus.publishEvent(
				envelope(
					"deployment.queued",
					actor.organizationId,
					{ type: "deployment", id: row.id },
					{ serviceId, trigger: row.trigger },
				),
			);
			return c.json(row, 202);
		},
	);
