import { createRoute, z } from "@hono/zod-openapi";
import {
	defaultServiceIcon,
	type ServiceIcon,
	StackSource,
} from "@logistack/contracts";
import {
	decrypt,
	encrypt,
	newId,
	planTemplate,
	type Resource,
	type TemplateServicePlan,
} from "@logistack/core";
import {
	deployment,
	domain,
	envVar,
	mount,
	service,
	stack,
} from "@logistack/db";
import { fromCompose, Skip } from "@logistack/templates";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, one } from "../errors.ts";
import { envelope } from "../events.ts";
import { guardHostSettings } from "../host-settings.ts";
import { log } from "../log.ts";
import {
	body,
	errors,
	IdParam,
	json,
	router,
	Slug,
	security,
} from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { actorCan, byParam, check, requirePermission } from "../scope.ts";
import { stackCompose } from "../stack-compose.ts";
import { listServices, ServiceListItem } from "./services.ts";

const tags = ["stacks"];

const Stack = z
	.object({
		id: z.string(),
		environmentId: z.string(),
		name: z.string(),
		source: StackSource,
		templateId: z.string().nullable(),
		createdBy: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi("Stack");

const StackDetail = Stack.extend({
	/** The compose file as pasted; null for a template stack or without `read:secrets`. */
	composeYaml: z.string().nullable(),
	/** True when the stack has a compose file the caller may not read. */
	composeHidden: z.boolean(),
	/** Desired state written as compose; secrets masked without `read:secrets`. */
	effectiveCompose: z.string(),
	services: z.array(ServiceListItem),
}).openapi("StackDetail");

export const DeployedService = z.object({
	id: z.string(),
	name: z.string(),
	kind: z.enum(["application", "database"]),
	/** null for a service deployed before; poll its deployments instead. */
	deploymentId: z.string().nullable(),
	hostname: z.string().nullable(),
});

const StackCreated = z
	.object({
		stackId: z.string(),
		name: z.string(),
		services: z.array(DeployedService),
	})
	.openapi("StackCreated");

const ComposeInput = z.object({
	/** The stack's name; its services take the compose service names. */
	name: Slug,
	composeYaml: z
		.string()
		.min(1)
		.max(256 * 1024),
});

/** A pasted compose has no secret inputs: credentials are told apart by name or URL userinfo. */
export const looksSecret = (key: string, value: string) =>
	/PASS|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|AUTH/i.test(key) ||
	/:\/\/[^/\s:@]+:[^@\s]+@/.test(value);

const stackColumns = {
	id: stack.id,
	environmentId: stack.environmentId,
	name: stack.name,
	source: stack.source,
	templateId: stack.templateId,
	createdBy: stack.createdBy,
	createdAt: stack.createdAt,
	updatedAt: stack.updatedAt,
};

type Planned = {
	plan: TemplateServicePlan;
	id: string;
	icon: ServiceIcon | null;
};

/**
 * Creates a stack and every service of `services` (dependencies first) with their env vars,
 * volumes, files and domain in one transaction, then queues a deployment per service.
 * A slug already taken in the environment is a 409.
 */
export async function createStack(
	c: Context<Env>,
	input: {
		environmentId: string;
		name: string;
		source: StackSource;
		templateId?: string;
		composeYaml?: string;
		services: Planned[];
		/** Hostnames LogiStack generated, as opposed to ones the user typed. */
		generated?: Set<string>;
		/** `imported_from` of each service. */
		provenance?: (name: string) => string;
	},
) {
	const actor = requireActor(c);
	const { db, masterKey, config } = c.var.deps;
	const taken = await db
		.select({ slug: service.slug })
		.from(service)
		.where(
			and(
				eq(service.environmentId, input.environmentId),
				inArray(
					service.slug,
					input.services.map((s) => s.plan.name),
				),
			),
		);
	if (taken.length)
		throw new Failure(
			"conflict",
			`this environment already has services named ${taken.map((s) => s.slug).join(", ")}; deploy into another environment`,
			{ conflicts: taken.map((s) => s.slug) },
		);
	const nodeIds = new Map<string, string | null | undefined>();
	for (const s of input.services)
		nodeIds.set(
			s.plan.name,
			await guardHostSettings(c, { spec: s.plan.spec, nodeId: null }),
		);

	const trigger = actor.kind === "user" ? "manual" : "api";
	const { stackId, created } = await db.transaction(async (tx) => {
		const row = one(
			await tx
				.insert(stack)
				.values({
					environmentId: input.environmentId,
					name: input.name,
					source: input.source,
					templateId: input.templateId ?? null,
					composeYamlEncrypted: input.composeYaml
						? await encrypt(masterKey, input.composeYaml)
						: null,
					createdBy: actor.userId,
				})
				.returning({ id: stack.id }),
		);
		const out: (Planned & { deploymentId: string })[] = [];
		for (const s of input.services) {
			const p = s.plan;
			await tx.insert(service).values({
				id: s.id,
				environmentId: input.environmentId,
				stackId: row.id,
				name: p.name,
				slug: p.name,
				kind: p.spec.kind,
				spec: p.spec,
				nodeId: nodeIds.get(p.name) ?? null,
				createdBy: actor.userId,
				importedFrom: input.provenance?.(p.name) ?? null,
				icon: defaultServiceIcon(p.spec) ?? s.icon,
			});
			if (p.env.length)
				await tx.insert(envVar).values(
					await Promise.all(
						p.env.map(async (e) => ({
							scope: "service" as const,
							scopeId: s.id,
							key: e.key,
							valueEncrypted: await encrypt(masterKey, e.value),
							isSecret: e.isSecret,
						})),
					),
				);
			for (const m of p.mounts)
				await tx.insert(mount).values({
					serviceId: s.id,
					kind: m.kind,
					target: m.target,
					readOnly: m.readOnly,
					...(m.kind === "volume"
						? { volumeName: m.volumeName }
						: { contentEncrypted: await encrypt(masterKey, m.content) }),
				});
			if (p.domain)
				await tx.insert(domain).values({
					serviceId: s.id,
					hostname: p.domain.hostname,
					port: p.domain.port,
					isGenerated: input.generated?.has(p.domain.hostname) ?? false,
				});
			const d = one(
				await tx
					.insert(deployment)
					.values({ serviceId: s.id, trigger })
					.returning({ id: deployment.id }),
			);
			out.push({ ...s, deploymentId: d.id });
		}
		return { stackId: row.id, created: out };
	});

	for (const s of created)
		await c.var.deps.bus.publishEvent(
			envelope(
				"deployment.queued",
				actor.organizationId,
				{ type: "deployment", id: s.deploymentId },
				{ serviceId: s.id, trigger },
			),
		);
	if (created.some((s) => s.plan.domain))
		await requestProxySync(config.REDIS_URL, "stack created").catch(
			(err: unknown) =>
				log("warn", "proxy sync request failed", { error: String(err) }),
		);
	return {
		stackId,
		services: created.map((s) => ({
			id: s.id,
			name: s.plan.name,
			kind: s.plan.spec.kind as "application" | "database",
			deploymentId: s.deploymentId,
			hostname: s.plan.domain?.hostname ?? null,
		})),
	};
}

export const stacks = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/environments/{id}/stacks",
			tags,
			security,
			middleware: [requirePermission("read", byParam("environment"))],
			request: { params: IdParam },
			responses: { 200: json(z.array(Stack), "Stacks"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select(stackColumns)
				.from(stack)
				.where(eq(stack.environmentId, c.req.valid("param").id))
				.orderBy(asc(stack.name));
			return c.json(rows, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/stacks/{id}",
			tags,
			security,
			summary: "A stack with its services, compose file and effective compose",
			middleware: [requirePermission("read", byParam("stack"))],
			request: { params: IdParam },
			responses: { 200: json(StackDetail, "Stack"), ...errors },
		}),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const id = c.req.valid("param").id;
			const secrets = actorCan(
				requireActor(c),
				"read:secrets",
				c.get("resource") as Resource,
			);
			const row = one(
				await db
					.select({ ...stackColumns, encrypted: stack.composeYamlEncrypted })
					.from(stack)
					.where(eq(stack.id, id)),
				"stack",
			);
			const services = await listServices(db, eq(service.stackId, id));
			const ids = services.map((s) => s.id);
			const [vars, mounts] = ids.length
				? await Promise.all([
						db
							.select()
							.from(envVar)
							.where(
								and(eq(envVar.scope, "service"), inArray(envVar.scopeId, ids)),
							)
							.orderBy(asc(envVar.key)),
						db
							.select()
							.from(mount)
							.where(
								and(eq(mount.kind, "volume"), inArray(mount.serviceId, ids)),
							),
					])
				: [[], []];
			const effectiveCompose = stackCompose(
				await Promise.all(
					services.map(async (s) => ({
						slug: s.slug,
						spec: s.spec,
						env: await Promise.all(
							vars
								.filter((v) => v.scopeId === s.id)
								.map(async (v) => ({
									key: v.key,
									value:
										v.isSecret && !secrets
											? null
											: await decrypt(masterKey, v.valueEncrypted),
								})),
						),
						volumes: mounts
							.filter((m) => m.serviceId === s.id && m.volumeName)
							.map((m) => ({
								name: m.volumeName as string,
								target: m.target,
								readOnly: m.readOnly,
							})),
						domains: s.domains,
					})),
				),
			);
			const { encrypted, ...rest } = row;
			return c.json(
				{
					...rest,
					composeYaml:
						encrypted && secrets ? await decrypt(masterKey, encrypted) : null,
					composeHidden: Boolean(encrypted) && !secrets,
					effectiveCompose,
					services,
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"stack.create",
			createRoute({
				method: "post",
				path: "/environments/{id}/stacks",
				tags,
				security,
				summary: "Deploy a compose file as a stack",
				description:
					// biome-ignore lint/suspicious/noTemplateCurlyInString: documents compose syntax
					"Each compose service becomes a LogiStack service named after it, so siblings reach each other by those names. Official database images become managed databases. Parts LogiStack cannot run (build, host paths, privileged, ...) are a 400 listing every one. `${VAR:-default}` takes its default; other variables are empty until set on the service.",
				middleware: [requirePermission("write", byParam("environment"))],
				request: { params: IdParam, ...body(ComposeInput) },
				responses: { 201: json(StackCreated, "Created and queued"), ...errors },
			}),
		),
		async (c) => {
			const { id: environmentId } = c.req.valid("param");
			const input = c.req.valid("json");
			check(c, "deploy", c.get("resource") as Resource);
			c.set("auditDiff", { name: input.name });
			let plan: TemplateServicePlan[];
			try {
				plan = planTemplate(
					{ inputs: [], services: fromCompose(input.composeYaml) },
					{},
				);
			} catch (e) {
				if (e instanceof Skip)
					throw new Failure(
						"validation_failed",
						"the compose file uses features LogiStack cannot run",
						e.reasons.map((r) => r.detail),
					);
				throw new Failure("validation_failed", (e as Error).message);
			}
			const created = await createStack(c, {
				environmentId,
				name: input.name,
				source: "compose",
				composeYaml: input.composeYaml,
				services: plan.map((p) => ({
					plan: {
						...p,
						env: p.env.map((e) => ({
							...e,
							isSecret: e.isSecret || looksSecret(e.key, e.value),
						})),
					},
					id: newId("svc"),
					icon: null,
				})),
			});
			c.set("auditResourceId", created.stackId);
			return c.json({ ...created, name: input.name }, 201);
		},
	)
	.openapi(
		mutation(
			"stack.delete",
			createRoute({
				method: "delete",
				path: "/stacks/{id}",
				tags,
				security,
				summary: "Delete a stack and all its services",
				description:
					"Removes the desired state of the stack and every service in it. The reconciler garbage-collects their Docker objects.",
				middleware: [requirePermission("delete", byParam("stack"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const id = c.req.valid("param").id;
			c.set("auditResourceId", id);
			await c.var.deps.db.delete(stack).where(eq(stack.id, id));
			return c.body(null, 204);
		},
	);
