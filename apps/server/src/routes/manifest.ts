import { createRoute, z } from "@hono/zod-openapi";
import {
	EnvironmentColor,
	EnvironmentKind,
	Manifest,
	ManifestChange,
	manifestJsonSchema,
} from "@logistack/contracts";
import { environment } from "@logistack/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, one } from "../errors.ts";
import {
	applyManifest,
	duplicateOf,
	environmentManifest,
	snapshot,
} from "../manifest.ts";
import {
	body,
	Environment,
	errors,
	IdParam,
	json,
	Name,
	router,
	Slug,
	security,
	slugify,
} from "../openapi.ts";
import {
	actorCan,
	byParam,
	check,
	locate,
	requirePermission,
} from "../scope.ts";

const tags = ["manifests"];

const Format = z.object({
	format: z.enum(["json", "yaml"]).default("json").openapi({
		description: "`yaml` returns text/yaml with a schema modeline for editors.",
	}),
});

const ApplyInput = z.object({
	manifest: z.union([z.string().min(1).max(5_000_000), Manifest]).openapi({
		description: "The manifest, as an object or as YAML or JSON text.",
	}),
	/** Delete what the manifest does not list. Off unless asked for. */
	prune: z.boolean().default(false),
	/** Only plan: report the changes, write nothing. */
	dryRun: z.boolean().default(false),
});

const ApplyResult = z
	.object({
		applied: z.boolean(),
		changes: z.array(ManifestChange),
		warnings: z.array(z.string()),
		/** Age keys of backup policies apply created encrypted; shown once, store them. */
		backupKeys: z.array(
			z.object({
				environment: z.string(),
				service: z.string(),
				backup: z.string(),
				key: z.string(),
			}),
		),
	})
	.openapi("ManifestApplyResult");

const exported = {
	200: {
		description: "The manifest",
		content: {
			"application/json": { schema: Manifest },
			"text/yaml": { schema: z.string() },
		},
	},
	...errors,
};

function send(
	c: Context<Env>,
	manifest: Manifest,
	format: "json" | "yaml",
	name: string,
) {
	c.header(
		"content-disposition",
		`attachment; filename="${name}.logistack.${format}"`,
	);
	if (format === "json") return c.json(manifest, 200);
	const schema = `${new URL(c.req.url).origin}/api/manifest/schema.json`;
	return c.text(
		`# yaml-language-server: $schema=${schema}\n${Bun.YAML.stringify(manifest, null, 2)}`,
		200,
		{ "content-type": "text/yaml; charset=utf-8" },
	);
}

function parseManifest(input: string | Manifest): Manifest {
	if (typeof input !== "string") return input;
	let raw: unknown;
	try {
		raw = Bun.YAML.parse(input);
	} catch (e) {
		throw new Failure(
			"bad_request",
			`not YAML or JSON: ${(e as Error).message}`,
		);
	}
	const parsed = Manifest.safeParse(raw);
	if (!parsed.success)
		throw new Failure(
			"bad_request",
			"not a valid manifest",
			parsed.error.issues,
		);
	return parsed.data;
}

const DuplicateInput = z.object({
	name: Name,
	slug: Slug.optional(),
	kind: EnvironmentKind,
	color: EnvironmentColor.nullable().optional(),
	/** Copy project-wide environment variables and every service's own. */
	includeVariables: z.boolean().default(true),
});

const DuplicateResult = z
	.object({
		environment: Environment,
		changes: z.array(ManifestChange),
		warnings: z.array(z.string()),
	})
	.openapi("EnvironmentDuplicateResult");

async function environmentRow(c: Context<Env>, id: string) {
	return one(
		await c.var.deps.db
			.select({ projectId: environment.projectId, slug: environment.slug })
			.from(environment)
			.where(eq(environment.id, id)),
		"environment",
	);
}

const applyDescription =
	"Converges the target to the manifest through the same routes a person uses, so their permission checks apply (stacks need `deploy`, prune needs `delete`). Matches by slug, variable key, hostname and backup target; applying the same manifest twice changes nothing. Nothing is deleted unless `prune` is true. A secret without a value keeps its stored value; a new one without a value is a warning. With `dryRun` it only returns the plan. Nothing is deployed: changed services show a pending diff.";

export const manifests = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/manifest/schema.json",
			tags,
			summary: "JSON Schema of a LogiStack manifest, for editors",
			responses: {
				200: {
					description: "JSON Schema",
					content: {
						"application/json": { schema: z.record(z.string(), z.unknown()) },
					},
				},
			},
		}),
		(c) => c.json(manifestJsonSchema() as Record<string, unknown>, 200),
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/projects/{id}/manifest",
			tags,
			security,
			summary: "Export a project as a manifest",
			description:
				"Its environments, variables, git stacks, services, mounts, domains and backup policies. Secret values are never included; git providers, S3 destinations, DNS providers and certificates are referenced by name.",
			middleware: [requirePermission("read", byParam("project"))],
			request: { params: IdParam, query: Format },
			responses: exported,
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { manifest } = await snapshot(
				c.var.deps,
				requireActor(c).organizationId,
				id,
				false,
			);
			return send(
				c,
				manifest,
				c.req.valid("query").format,
				manifest.project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/environments/{id}/manifest",
			tags,
			security,
			summary: "Export one environment as a manifest",
			description:
				"Like the project export, for one environment. Secret values are never included.",
			middleware: [requirePermission("read", byParam("environment"))],
			request: { params: IdParam, query: Format },
			responses: exported,
		}),
		async (c) => {
			const env = await environmentRow(c, c.req.valid("param").id);
			const { manifest } = await snapshot(
				c.var.deps,
				requireActor(c).organizationId,
				env.projectId,
				false,
			);
			return send(
				c,
				environmentManifest(manifest, env.slug),
				c.req.valid("query").format,
				env.slug,
			);
		},
	)
	.openapi(
		mutation(
			"project.apply",
			createRoute({
				method: "post",
				path: "/projects/{id}/apply",
				tags,
				security,
				summary: "Plan or apply a project manifest",
				description: `${applyDescription} Environments are matched by slug and created when missing; with prune, an environment the manifest does not list is deleted.`,
				middleware: [requirePermission("write", byParam("project"))],
				request: { params: IdParam, ...body(ApplyInput) },
				responses: { 200: json(ApplyResult, "Plan or result"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const manifest = parseManifest(input.manifest);
			if (manifest.kind !== "project")
				throw new Failure(
					"bad_request",
					"this is an environment manifest: apply it to an environment",
				);
			c.set("auditResourceId", id);
			const out = await applyManifest(
				c.var.deps,
				requireActor(c),
				{ type: "project", projectId: id, manifest },
				input,
			);
			c.set("auditDiff", {
				dryRun: input.dryRun,
				prune: input.prune,
				changes: out.changes.length,
			});
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"environment.apply",
			createRoute({
				method: "post",
				path: "/environments/{id}/apply",
				tags,
				security,
				summary: "Plan or apply an environment manifest",
				description: applyDescription,
				middleware: [requirePermission("write", byParam("environment"))],
				request: { params: IdParam, ...body(ApplyInput) },
				responses: { 200: json(ApplyResult, "Plan or result"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const manifest = parseManifest(input.manifest);
			if (manifest.kind !== "environment")
				throw new Failure(
					"bad_request",
					"this is a project manifest: apply it to a project",
				);
			const env = await environmentRow(c, id);
			c.set("auditResourceId", id);
			const out = await applyManifest(
				c.var.deps,
				requireActor(c),
				{
					type: "environment",
					projectId: env.projectId,
					slug: env.slug,
					manifest,
				},
				input,
			);
			c.set("auditDiff", {
				dryRun: input.dryRun,
				prune: input.prune,
				changes: out.changes.length,
			});
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"environment.duplicate",
			createRoute({
				method: "post",
				path: "/environments/{id}/duplicate",
				tags,
				security,
				summary: "Duplicate an environment into a new one",
				description:
					"Creates a new environment in the same project with the source's stacks, services, settings and config files, applied like a manifest (needs `write` on the project). Domains, backup policies and volume data are not copied. With `includeVariables`, environment and service variables are copied, secrets included when the caller holds `read:secrets` on the source; otherwise each secret is a warning. Nothing is deployed. A taken slug is a 409 and a failed copy removes the new environment, so a retry is safe.",
				middleware: [requirePermission("read", byParam("environment"))],
				request: { params: IdParam, ...body(DuplicateInput) },
				responses: {
					201: json(DuplicateResult, "The new environment"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { deps } = c.var;
			const actor = requireActor(c);
			const source = c.get("resource");
			const reveal = !!source && actorCan(actor, "read:secrets", source);
			const src = await environmentRow(c, id);
			check(
				c,
				"write",
				await locate(deps.db, actor.organizationId, "project", src.projectId),
			);
			const { manifest } = await snapshot(
				deps,
				actor.organizationId,
				src.projectId,
				reveal,
			);
			const to = {
				name: input.name,
				slug: input.slug ?? slugify(input.name),
				kind: input.kind,
				color: input.color ?? undefined,
			};
			const copy = duplicateOf(
				environmentManifest(manifest, src.slug).environment,
				to,
				input.includeVariables,
			);
			const row = one(
				await deps.db
					.insert(environment)
					.values({ projectId: src.projectId, ...to, color: to.color ?? null })
					.returning(),
			);
			c.set("auditResourceId", row.id);
			try {
				const out = await applyManifest(
					deps,
					actor,
					{
						type: "environment",
						projectId: src.projectId,
						slug: row.slug,
						manifest: { version: 1, kind: "environment", environment: copy },
					},
					{ prune: false, dryRun: false },
				);
				c.set("auditDiff", {
					from: id,
					includeVariables: input.includeVariables,
					changes: out.changes.length,
				});
				return c.json(
					{ environment: row, changes: out.changes, warnings: out.warnings },
					201,
				);
			} catch (e) {
				// All or nothing: a half-built copy would make the retry a 409.
				await deps.db.delete(environment).where(eq(environment.id, row.id));
				throw e;
			}
		},
	);
