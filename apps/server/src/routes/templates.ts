import { readFileSync } from "node:fs";
import { createRoute, z } from "@hono/zod-openapi";
import {
	Hostname,
	Template,
	TemplateCategory,
	TemplateDeployInput,
	TemplateSummary,
} from "@logistack/contracts";
import {
	encrypt,
	generateInput,
	newId,
	planTemplate,
	type Resource,
	type TemplateServicePlan,
} from "@logistack/core";
import {
	deployment,
	domain,
	envVar,
	instanceSettings,
	mount,
	service,
} from "@logistack/db";
import { catalogIndex, logoPath, readTemplate } from "@logistack/templates";
import { and, eq, inArray, like } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { envelope } from "../events.ts";
import { guardHostSettings } from "../host-settings.ts";
import { log } from "../log.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { publicIp } from "../probe.ts";
import { requestProxySync } from "../redis.ts";
import { byParam, check, inOrganization, requirePermission } from "../scope.ts";
import { generatedHostname } from "./domains.ts";

const tags = ["templates"];

const DeployedService = z.object({
	id: z.string(),
	name: z.string(),
	kind: z.enum(["application", "database"]),
	/** null for a service deployed before; poll its deployments instead. */
	deploymentId: z.string().nullable(),
	hostname: z.string().nullable(),
});

const DeployResult = z
	.object({
		/** false when this environment already had the instance: nothing was created. */
		created: z.boolean(),
		name: z.string(),
		templateId: z.string(),
		services: z.array(DeployedService),
	})
	.openapi("TemplateDeployResult");

/** Provenance kept on each created service: `template:<templateId>:<instance>/<service>`. */
const provenance = (templateId: string, name: string, svc: string) =>
	`template:${templateId}:${name}/${svc}`;

/** Services of an instance already in the environment, in the shape a deploy returns. */
async function existingInstance(
	c: Context<Env>,
	environmentId: string,
	name: string,
) {
	const { db } = c.var.deps;
	const rows = await db
		.select({
			id: service.id,
			slug: service.slug,
			kind: service.kind,
			importedFrom: service.importedFrom,
		})
		.from(service)
		.where(
			and(
				eq(service.environmentId, environmentId),
				like(service.importedFrom, `template:%:${name}/%`),
			),
		);
	if (!rows.length) return undefined;
	const hosts = await db
		.select({ serviceId: domain.serviceId, hostname: domain.hostname })
		.from(domain)
		.where(
			inArray(
				domain.serviceId,
				rows.map((r) => r.id),
			),
		);
	return {
		templateId:
			/^template:([^:]+):/.exec(rows[0]?.importedFrom ?? "")?.[1] ?? "",
		services: rows.map((r) => ({
			id: r.id,
			name: r.slug,
			kind: r.kind as "application" | "database",
			deploymentId: null,
			hostname: hosts.find((h) => h.serviceId === r.id)?.hostname ?? null,
		})),
	};
}

/** Every caller-facing problem with the values, before anything is generated. */
function checkInputs(t: Template, given: Record<string, string>) {
	const issues: string[] = [];
	const keys = new Set(t.inputs.map((i) => i.key));
	for (const k of Object.keys(given))
		if (!keys.has(k)) issues.push(`${k}: not an input of ${t.id}`);
	for (const i of t.inputs) {
		const v = given[i.key]?.trim() ?? "";
		if (
			i.type === "domain" &&
			v &&
			(!Hostname.safeParse(v).success || v.startsWith("*."))
		)
			issues.push(`${i.key}: not a hostname`);
		if (i.type === "text" && i.default === undefined && !v)
			issues.push(`${i.key}: required`);
	}
	if (issues.length)
		throw new Failure("validation_failed", "invalid template inputs", issues);
}

export const templates = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/templates",
			tags,
			security,
			summary: "The template catalog",
			description:
				"Every template, or those whose name, id, tags or description contain all words of `q`.",
			middleware: [requirePermission("read", inOrganization)],
			request: {
				query: z.object({
					q: z.string().max(200).optional(),
					category: TemplateCategory.optional(),
				}),
			},
			responses: {
				200: json(z.array(TemplateSummary), "Templates"),
				...errors,
			},
		}),
		(c) => {
			const { q, category } = c.req.valid("query");
			const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const hits = catalogIndex().filter(
				(t) =>
					(!category || t.category === category) &&
					words.every((w) =>
						[t.id, t.name, t.description, ...t.tags].some((f) =>
							f.toLowerCase().includes(w),
						),
					),
			);
			return c.json(hits, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/templates/{id}",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			request: { params: z.object({ id: z.string() }) },
			responses: { 200: json(Template, "Template"), ...errors },
		}),
		(c) => {
			const t = readTemplate(c.req.valid("param").id);
			if (!t) throw notFound("template");
			return c.json(t, 200);
		},
	)
	.openapi(
		mutation(
			"template.deploy",
			createRoute({
				method: "post",
				path: "/environments/{id}/templates/{templateId}",
				tags,
				security,
				summary: "Deploy a template into an environment",
				description:
					"Generates missing secrets server-side, creates every service with its env vars, volumes, files and domain in one transaction (dependencies first), then queues a deployment per service. A repeat with the same instance `name` in the same environment returns the first result. Service slugs are the template's service names, so siblings reach each other by those names; a name already taken in the environment is a 409.",
				middleware: [requirePermission("write", byParam("environment"))],
				request: {
					params: z.object({ id: z.string(), templateId: z.string() }),
					...body(TemplateDeployInput),
				},
				responses: {
					200: json(DeployResult, "Already deployed"),
					201: json(DeployResult, "Created and queued"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id: environmentId, templateId } = c.req.valid("param");
			const input = c.req.valid("json");
			const actor = requireActor(c);
			check(c, "deploy", c.get("resource") as Resource);
			const t = readTemplate(templateId);
			if (!t) throw notFound("template");
			const name = input.name ?? t.id;
			c.set("auditResourceId", environmentId);
			c.set("auditDiff", {
				templateId,
				name,
				// Keys only: values may be credentials whatever their name.
				inputs: Object.keys(input.inputs),
			});

			const again = await existingInstance(c, environmentId, name);
			if (again) return c.json({ created: false, name, ...again }, 200);
			checkInputs(t, input.inputs);

			const { db, masterKey, config } = c.var.deps;
			const taken = await db
				.select({ slug: service.slug })
				.from(service)
				.where(
					and(
						eq(service.environmentId, environmentId),
						inArray(
							service.slug,
							t.services.map((s) => s.name),
						),
					),
				);
			if (taken.length)
				throw new Failure(
					"conflict",
					`this environment already has services named ${taken.map((s) => s.slug).join(", ")}; deploy the template into another environment`,
					{ conflicts: taken.map((s) => s.slug) },
				);

			// Ids first: a generated hostname is derived from its service's id.
			const ids = new Map(t.services.map((s) => [s.name, newId("svc")]));
			const values: Record<string, string> = {};
			const generated = new Set<string>();
			const needsHost = t.inputs.some(
				(i) => i.type === "domain" && !input.inputs[i.key]?.trim(),
			);
			const [settings] = needsHost
				? await db.select().from(instanceSettings)
				: [undefined];
			const ip = needsHost
				? ((await publicIp(config)) ?? undefined)
				: undefined;
			for (const i of t.inputs) {
				const given = input.inputs[i.key]?.trim();
				if (given)
					values[i.key] = i.type === "domain" ? given.toLowerCase() : given;
				else if (i.type === "domain") {
					const owner = t.services.find(
						(s) => s.kind === "application" && s.public?.domain === i.key,
					) as (typeof t.services)[number];
					values[i.key] = generatedHostname({
						slug: owner.name,
						serviceId: ids.get(owner.name) as string,
						base: settings?.generatedDomainBase ?? "sslip",
						ip,
						customWildcard: settings?.customWildcard,
					});
					generated.add(values[i.key] as string);
				} else values[i.key] = generateInput(i) ?? "";
			}
			const plan = planTemplate(t, values);
			const nodeIds = new Map<string, string | null | undefined>();
			for (const p of plan)
				nodeIds.set(
					p.name,
					await guardHostSettings(c, { spec: p.spec, nodeId: null }),
				);

			let created: {
				plan: TemplateServicePlan;
				id: string;
				deploymentId: string;
			}[];
			try {
				created = await db.transaction(async (tx) => {
					const out: typeof created = [];
					for (const p of plan) {
						const id = ids.get(p.name) as string;
						await tx.insert(service).values({
							id,
							environmentId,
							name: p.name,
							slug: p.name,
							kind: p.spec.kind,
							spec: p.spec,
							nodeId: nodeIds.get(p.name) ?? null,
							createdBy: actor.userId,
							importedFrom: provenance(t.id, name, p.name),
						});
						if (p.env.length)
							await tx.insert(envVar).values(
								await Promise.all(
									p.env.map(async (e) => ({
										scope: "service" as const,
										scopeId: id,
										key: e.key,
										valueEncrypted: await encrypt(masterKey, e.value),
										isSecret: e.isSecret,
									})),
								),
							);
						for (const m of p.mounts)
							await tx.insert(mount).values({
								serviceId: id,
								kind: m.kind,
								target: m.target,
								readOnly: m.readOnly,
								...(m.kind === "volume"
									? { volumeName: m.volumeName }
									: { contentEncrypted: await encrypt(masterKey, m.content) }),
							});
						if (p.domain)
							await tx.insert(domain).values({
								serviceId: id,
								hostname: p.domain.hostname,
								port: p.domain.port,
								isGenerated: generated.has(p.domain.hostname),
							});
						const [d] = await tx
							.insert(deployment)
							.values({
								serviceId: id,
								trigger: actor.kind === "user" ? "manual" : "api",
							})
							.returning({ id: deployment.id });
						out.push({ plan: p, id, deploymentId: d?.id as string });
					}
					return out;
				});
			} catch (err) {
				// A concurrent request with the same name won the slugs: return what it made.
				const raced = await existingInstance(c, environmentId, name);
				if (raced) return c.json({ created: false, name, ...raced }, 200);
				throw err;
			}

			for (const s of created)
				await c.var.deps.bus.publishEvent(
					envelope(
						"deployment.queued",
						actor.organizationId,
						{ type: "deployment", id: s.deploymentId },
						{
							serviceId: s.id,
							trigger: actor.kind === "user" ? "manual" : "api",
						},
					),
				);
			if (created.some((s) => s.plan.domain))
				await requestProxySync(config.REDIS_URL, "template deployed").catch(
					(err: unknown) =>
						log("warn", "proxy sync request failed", { error: String(err) }),
				);
			return c.json(
				{
					created: true,
					name,
					templateId: t.id,
					services: created.map((s) => ({
						id: s.id,
						name: s.plan.name,
						kind: s.plan.spec.kind as "application" | "database",
						deploymentId: s.deploymentId,
						hostname: s.plan.domain?.hostname ?? null,
					})),
				},
				201,
			);
		},
	)
	.get(
		"/templates/:id/logo",
		requirePermission("read", inOrganization),
		(c) => {
			const entry = catalogIndex().find((t) => t.id === c.req.param("id"));
			const path = entry?.logo && logoPath(entry.logo);
			if (!path) throw notFound("logo");
			const type = path.endsWith(".svg")
				? "image/svg+xml"
				: path.endsWith(".png")
					? "image/png"
					: path.endsWith(".webp")
						? "image/webp"
						: "image/jpeg";
			return c.body(readFileSync(path), 200, {
				"content-type": type,
				"cache-control": "private, max-age=86400",
				// An SVG opened directly must not run script on this origin.
				"content-security-policy":
					"default-src 'none'; style-src 'unsafe-inline'",
			});
		},
	);
