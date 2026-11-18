import { createRoute, z } from "@hono/zod-openapi";
import {
	type ApplicationSpec,
	LsdcInstance,
	LsdcInstanceUpdate,
	type LsdcLimits,
	LsdcProvisionInput,
	LsdcProvisionResult,
	LsdcUsage,
} from "@logistack/contracts";
import {
	decrypt,
	encrypt,
	newId,
	planTemplate,
	type Resource,
} from "@logistack/core";
import {
	domain,
	environment,
	envVar,
	lsdcInstance,
	project,
	service,
	stack,
} from "@logistack/db";
import { readTemplate } from "@logistack/templates";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import {
	actorCan,
	byParam,
	check,
	inOrganization,
	locate,
	requirePermission,
} from "../scope.ts";
import { guardedFetch, hostPolicy } from "../ssrf.ts";
import { actorTrigger, queueDeployment } from "./service-ops.ts";
import { createStack } from "./stacks.ts";
import { checkInputs, provenance, templateValues } from "./templates.ts";

const tags = ["lsdc"];
const TEMPLATE_ID = "lsdc";
const KEY_ENV = "LSDC_MANAGEMENT_KEY";

/** The env a managed instance runs with; CPU and RAM are also the container's limits. */
const limitEnv = (l: LsdcLimits) => ({
	LSDC_ENV_TYPE: "managed",
	LSDC_CPU_LIMIT: String(l.cpu),
	LSDC_RAM_LIMIT: String(l.ramMb),
	LSDC_STORAGE_LIMIT: String(l.storageMb),
});

/** `Acme S.r.l.` → `lsdc-acme-s-r-l`: a DNS label, so it can be the stack and service slug. */
export const instanceSlug = (customer: string) =>
	`lsdc-${
		customer
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 50)
			.replace(/-+$/, "") || "instance"
	}`;

const lsdcTemplate = () => {
	const t = readTemplate(TEMPLATE_ID);
	if (!t) throw new Failure("internal", "the lsdc template is missing");
	return t;
};

const positive = (raw: string | undefined) => {
	const n = Number(raw);
	return raw && Number.isFinite(n) && n > 0 ? n : null;
};

/** Every LSDC stack in the organization the actor may read, oldest first; `ids` narrows it. */
async function listInstances(
	c: Context<Env>,
	ids?: string[],
): Promise<LsdcInstance[]> {
	const actor = requireActor(c);
	const { db, masterKey } = c.var.deps;
	const rows = await db
		.select({
			stack,
			service,
			environmentName: environment.name,
			projectId: project.id,
			projectName: project.name,
			meta: lsdcInstance,
		})
		.from(stack)
		.innerJoin(service, eq(service.stackId, stack.id))
		.innerJoin(environment, eq(environment.id, stack.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.leftJoin(lsdcInstance, eq(lsdcInstance.stackId, stack.id))
		.where(
			and(
				eq(stack.templateId, TEMPLATE_ID),
				eq(project.organizationId, actor.organizationId),
				...(ids ? [inArray(stack.id, ids)] : []),
			),
		)
		.orderBy(asc(stack.createdAt));
	const readable: typeof rows = [];
	for (const r of rows)
		if (
			actorCan(
				actor,
				"read",
				await locate(db, actor.organizationId, "service", r.service.id),
			)
		)
			readable.push(r);
	if (!readable.length) return [];
	const serviceIds = readable.map((r) => r.service.id);
	const [hosts, vars] = await Promise.all([
		db
			.select({ serviceId: domain.serviceId, hostname: domain.hostname })
			.from(domain)
			.where(inArray(domain.serviceId, serviceIds))
			.orderBy(asc(domain.createdAt)),
		db
			.select()
			.from(envVar)
			.where(
				and(
					eq(envVar.scope, "service"),
					inArray(envVar.scopeId, serviceIds),
					inArray(envVar.key, ["LSDC_ENV_TYPE", "LSDC_STORAGE_LIMIT"]),
				),
			),
	]);
	const out: LsdcInstance[] = [];
	for (const r of readable) {
		const env: Record<string, string> = {};
		for (const v of vars.filter((v) => v.scopeId === r.service.id))
			env[v.key] = await decrypt(masterKey, v.valueEncrypted);
		const resources =
			r.service.spec.kind === "application"
				? r.service.spec.resources
				: undefined;
		out.push({
			id: r.stack.id,
			serviceId: r.service.id,
			name: r.stack.name,
			projectId: r.projectId,
			projectName: r.projectName,
			environmentId: r.stack.environmentId,
			environmentName: r.environmentName,
			hostname:
				hosts.find((h) => h.serviceId === r.service.id)?.hostname ?? null,
			desiredState: r.service.desiredState,
			customer: r.meta?.customer ?? null,
			priceCents: r.meta?.priceCents ?? null,
			currency: r.meta?.currency ?? "EUR",
			limits: {
				cpu: resources?.cpu ?? null,
				ramMb: resources?.memoryMb ?? null,
				storageMb: positive(env.LSDC_STORAGE_LIMIT),
			},
			managed: env.LSDC_ENV_TYPE === "managed",
			createdAt: r.stack.createdAt.toISOString(),
		});
	}
	return out;
}

async function oneInstance(c: Context<Env>, id: string) {
	const [found] = await listInstances(c, [id]);
	if (!found) throw notFound("LSDC instance");
	return found;
}

/** Writes service env vars, replacing a key that is already set. */
async function setEnv(
	c: Context<Env>,
	serviceId: string,
	values: Record<string, string>,
) {
	const { db, masterKey } = c.var.deps;
	for (const [key, value] of Object.entries(values)) {
		const valueEncrypted = await encrypt(masterKey, value);
		await db
			.insert(envVar)
			.values({ scope: "service", scopeId: serviceId, key, valueEncrypted })
			.onConflictDoUpdate({
				target: [envVar.scope, envVar.scopeId, envVar.key],
				set: { valueEncrypted },
			});
	}
}

export const lsdc = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/lsdc/instances",
			tags,
			security,
			summary: "LSDC instances",
			description:
				"Every stack deployed from the lsdc template that the caller may read, with its customer, monthly price and limits. Live usage is per instance: GET /lsdc/instances/{id}/usage.",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(LsdcInstance), "Instances"), ...errors },
		}),
		async (c) => c.json(await listInstances(c), 200),
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/lsdc/instances/{id}/usage",
			tags,
			security,
			summary: "Live usage of an LSDC instance",
			description:
				"Asks the instance (`GET /api/instance/usage` on its domain) with its management key. `reachable: false` when it does not answer, has no domain or no key.",
			middleware: [requirePermission("read", byParam("stack"))],
			request: { params: IdParam },
			responses: { 200: json(LsdcUsage, "Usage"), ...errors },
		}),
		async (c) => {
			const inst = await oneInstance(c, c.req.valid("param").id);
			const { db, masterKey } = c.var.deps;
			const [key] = await db
				.select({ value: envVar.valueEncrypted })
				.from(envVar)
				.where(
					and(
						eq(envVar.scope, "service"),
						eq(envVar.scopeId, inst.serviceId),
						eq(envVar.key, KEY_ENV),
					),
				);
			const down = (reason: string) =>
				c.json({ reachable: false as const, reason }, 200);
			if (!inst.hostname) return down("no domain");
			if (!key) return down(`no ${KEY_ENV}`);
			try {
				// The hostname is user-set: resolve it, refuse private addresses unless allowed, pin it.
				const res = await guardedFetch(
					`https://${inst.hostname}/api/instance/usage`,
					{
						headers: {
							authorization: `Bearer ${await decrypt(masterKey, key.value)}`,
						},
						signal: AbortSignal.timeout(8000),
					},
					await hostPolicy(db),
				);
				if (!res.ok) return down(`the instance answered ${res.status}`);
				const body = z
					.object({
						usage: z.object({
							cpu: z.number().nullable(),
							ramMb: z.number().nullable(),
							storageMb: z.number(),
						}),
					})
					.parse(await res.json());
				return c.json({ reachable: true as const, ...body.usage }, 200);
			} catch (err) {
				return down(err instanceof Error ? err.message : String(err));
			}
		},
	)
	.openapi(
		mutation(
			"lsdc.provision",
			createRoute({
				method: "post",
				path: "/environments/{id}/lsdc",
				tags,
				security,
				summary: "Provision an LSDC instance",
				description:
					"Deploys the lsdc template as a managed instance for one customer: CPU and RAM limits on the container, the same limits and the storage quota in LSDC_* env, a generated management key, the first admin when adminEmail is set. The stack and service are named after the customer (`lsdc-<customer>`); a name already taken in the environment is a 409.",
				middleware: [requirePermission("write", byParam("environment"))],
				request: { params: IdParam, ...body(LsdcProvisionInput) },
				responses: {
					201: json(LsdcProvisionResult, "Provisioned and queued"),
					...errors,
				},
			}),
		),
		async (c) => {
			const environmentId = c.req.valid("param").id;
			const input = c.req.valid("json");
			check(c, "deploy", c.get("resource") as Resource);
			const t = lsdcTemplate();
			const name = instanceSlug(input.customer);
			c.set("auditResourceId", environmentId);
			c.set("auditDiff", {
				name,
				customer: input.customer,
				limits: input.limits,
				priceCents: input.priceCents,
			});
			const given = {
				appDomain: input.domain,
				adminEmail: input.adminEmail,
				blueprintUrl: input.blueprintUrl,
			};
			checkInputs(t, given);
			const ids = new Map([[t.services[0]?.name ?? TEMPLATE_ID, newId("svc")]]);
			const { values, generated } = await templateValues(c, t, given, ids);
			const plans = planTemplate(t, values).map((p) => ({
				plan: {
					...p,
					name,
					spec: {
						...(p.spec as ApplicationSpec),
						resources: {
							cpu: input.limits.cpu,
							memoryMb: input.limits.ramMb,
						},
					},
					env: [
						...p.env,
						...Object.entries(limitEnv(input.limits)).map(([key, value]) => ({
							key,
							value,
							isSecret: false,
						})),
					],
				},
				id: ids.get(p.name) as string,
				icon: null,
			}));
			const created = await createStack(c, {
				environmentId,
				name,
				source: "template",
				templateId: t.id,
				services: plans,
				generated,
				provenance: (svc) => provenance(t.id, name, svc),
			});
			await c.var.deps.db.insert(lsdcInstance).values({
				stackId: created.stackId,
				customer: input.customer,
				priceCents: input.priceCents,
				currency: input.currency,
			});
			return c.json(
				{
					instance: await oneInstance(c, created.stackId),
					adminPassword: input.adminEmail
						? (values.adminPassword ?? null)
						: null,
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"lsdc.update",
			createRoute({
				method: "patch",
				path: "/lsdc/instances/{id}",
				tags,
				security,
				summary: "Change an LSDC instance's customer, price or limits",
				description:
					"Customer and price are LogiStack's own records. New limits are written to the container resources and the LSDC_* env (making the instance managed) and redeploy it.",
				middleware: [requirePermission("write", byParam("stack"))],
				request: { params: IdParam, ...body(LsdcInstanceUpdate) },
				responses: { 200: json(LsdcInstance, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const id = c.req.valid("param").id;
			const input = c.req.valid("json");
			const inst = await oneInstance(c, id);
			const { db } = c.var.deps;
			c.set("auditDiff", input);
			const { limits, ...meta } = input;
			if (Object.keys(meta).length)
				await db
					.insert(lsdcInstance)
					.values({ stackId: id, ...meta })
					.onConflictDoUpdate({ target: lsdcInstance.stackId, set: meta });
			if (limits) {
				const actor = requireActor(c);
				const target = await locate(
					db,
					actor.organizationId,
					"service",
					inst.serviceId,
				);
				if (!actorCan(actor, "deploy", target))
					throw new Failure(
						"forbidden",
						"missing permission 'deploy' on service",
					);
				const [svc] = await db
					.select({ spec: service.spec })
					.from(service)
					.where(eq(service.id, inst.serviceId));
				if (svc?.spec.kind !== "application")
					throw new Failure("conflict", "the instance is not an application");
				await db
					.update(service)
					.set({
						spec: {
							...svc.spec,
							resources: { cpu: limits.cpu, memoryMb: limits.ramMb },
						},
					})
					.where(eq(service.id, inst.serviceId));
				await setEnv(c, inst.serviceId, limitEnv(limits));
				await queueDeployment(c, {
					serviceId: inst.serviceId,
					trigger: actorTrigger(actor),
				});
			}
			return c.json(await oneInstance(c, id), 200);
		},
	);
