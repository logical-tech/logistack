import { readFileSync } from "node:fs";
import { createRoute, z } from "@hono/zod-openapi";
import {
	Hostname,
	isServiceIcon,
	Template,
	TemplateCategory,
	TemplateDeployInput,
	TemplateSummary,
} from "@logistack/contracts";
import {
	generateInput,
	newId,
	planTemplate,
	type Resource,
} from "@logistack/core";
import { domain, instanceSettings, service, stack } from "@logistack/db";
import { catalogIndex, logoPath, readTemplate } from "@logistack/templates";
import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { publicIp } from "../probe.ts";
import { byParam, check, inOrganization, requirePermission } from "../scope.ts";
import { generatedHostname } from "./domains.ts";
import { createStack, DeployedService } from "./stacks.ts";

const tags = ["templates"];

const DeployResult = z
	.object({
		/** false when this environment already had the instance: nothing was created. */
		created: z.boolean(),
		name: z.string(),
		templateId: z.string(),
		stackId: z.string(),
		services: z.array(DeployedService),
	})
	.openapi("TemplateDeployResult");

/** Provenance kept on each created service: `template:<templateId>:<instance>/<service>`. */
const provenance = (templateId: string, name: string, svc: string) =>
	`template:${templateId}:${name}/${svc}`;

/** The stack an earlier deploy of instance `name` created, in the shape a deploy returns. */
async function existingInstance(
	c: Context<Env>,
	environmentId: string,
	name: string,
) {
	const { db } = c.var.deps;
	const [st] = await db
		.select({ id: stack.id, templateId: stack.templateId })
		.from(stack)
		.where(and(eq(stack.environmentId, environmentId), eq(stack.name, name)));
	if (!st) return undefined;
	const rows = await db
		.select({ id: service.id, slug: service.slug, kind: service.kind })
		.from(service)
		.where(eq(service.stackId, st.id));
	const hosts = rows.length
		? await db
				.select({ serviceId: domain.serviceId, hostname: domain.hostname })
				.from(domain)
				.where(
					inArray(
						domain.serviceId,
						rows.map((r) => r.id),
					),
				)
		: [];
	return {
		stackId: st.id,
		templateId: st.templateId ?? "",
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

/** `uptime-kuma` → `uptimekuma`, when the template is a brand we draw. */
const templateIcon = (id: string) => {
	const slug = id.replace(/-/g, "");
	return isServiceIcon(slug) ? slug : null;
};

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

			const { db, config } = c.var.deps;
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

			let created: Awaited<ReturnType<typeof createStack>>;
			try {
				created = await createStack(c, {
					environmentId,
					name,
					source: "template",
					templateId: t.id,
					services: planTemplate(t, values).map((p) => ({
						plan: p,
						id: ids.get(p.name) as string,
						icon: templateIcon(t.id),
					})),
					generated,
					provenance: (svc) => provenance(t.id, name, svc),
				});
			} catch (err) {
				// A concurrent request with the same name won the stack: return what it made.
				const raced = await existingInstance(c, environmentId, name);
				if (raced) return c.json({ created: false, name, ...raced }, 200);
				throw err;
			}
			return c.json({ created: true, name, templateId: t.id, ...created }, 201);
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
