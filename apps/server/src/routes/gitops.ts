import { createRoute, z } from "@hono/zod-openapi";
import { ManifestChange } from "@logistack/contracts";
import { projectGitops } from "@logistack/db";
import { eq } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Failure, one } from "../errors.ts";
import {
	type GitopsLink,
	gitopsActor,
	readGitManifest,
	syncGitops,
} from "../gitops.ts";
import { applyManifest } from "../manifest.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { byParam, check, requirePermission } from "../scope.ts";

const tags = ["gitops"];

const Source = z.object({
	gitProviderId: z.string().min(1),
	repository: z.string().min(1).max(200),
	branch: z.string().min(1).max(255),
	path: z
		.string()
		.min(1)
		.max(500)
		.refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
			message: "a path inside the repository, like deploy/logistack.yaml",
		}),
});

const LinkInput = Source.extend({
	/** Apply on push; off, a push only records the plan. */
	autoApply: z.boolean().default(true),
	/** Delete what the manifest does not list. Needs `delete` on the project. */
	prune: z.boolean().default(false),
	/** Refuse manual edits to the project; the repository becomes the only way in. */
	managed: z.boolean().default(false),
});

const GitopsError = z.object({
	at: z.string(),
	commitSha: z.string().nullable(),
	message: z.string(),
	details: z.array(z.string()),
});

const Link = z
	.object({
		projectId: z.string(),
		gitProviderId: z.string(),
		repository: z.string(),
		branch: z.string(),
		path: z.string(),
		autoApply: z.boolean(),
		prune: z.boolean(),
		managed: z.boolean(),
		lastCommitSha: z.string().nullable(),
		lastSyncedAt: z.coerce.date().nullable(),
		lastStatus: z
			.enum(["applied", "unchanged", "planned", "failed"])
			.nullable(),
		lastChanges: z.int().nullable(),
		lastError: GitopsError.nullable(),
		createdAt: z.coerce.date(),
		updatedAt: z.coerce.date(),
	})
	.openapi("GitopsLink");

const Plan = z
	.object({
		changes: z.array(ManifestChange),
		warnings: z.array(z.string()),
	})
	.openapi("GitopsPlan");

const SyncResult = z
	.object({
		status: z.enum(["applied", "unchanged", "planned", "failed"]),
		commitSha: z.string().nullable(),
		changes: z.int(),
		deployments: z.array(z.string()),
		error: GitopsError.optional(),
	})
	.openapi("GitopsSyncResult");

const view = ({ organizationId: _o, createdBy: _c, ...l }: GitopsLink) => l;

export const gitops = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/projects/{id}/gitops",
			tags,
			security,
			summary: "The project's GitOps link",
			description:
				"The repository, branch and manifest path the project follows, and the outcome of the last sync. Null when the project is not linked.",
			middleware: [requirePermission("read", byParam("project"))],
			request: { params: IdParam },
			responses: { 200: json(Link.nullable(), "Link"), ...errors },
		}),
		async (c) => {
			const [row] = await c.var.deps.db
				.select()
				.from(projectGitops)
				.where(eq(projectGitops.projectId, c.req.valid("param").id));
			return c.json(row ? view(row) : null, 200);
		},
	)
	.openapi(
		mutation(
			"gitops.check",
			createRoute({
				method: "post",
				path: "/projects/{id}/gitops/check",
				tags,
				security,
				summary: "Read a manifest from git and plan it, without linking",
				description:
					"Reads the file at the branch head through the git provider, validates it as a project manifest and returns what applying it would change. Writes nothing; the link wizard's test step.",
				middleware: [requirePermission("write", byParam("project"))],
				request: {
					params: IdParam,
					...body(Source.extend({ prune: z.boolean().default(false) })),
				},
				responses: { 200: json(Plan, "Plan"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const manifest = await readGitManifest(
				c.var.deps,
				actor.organizationId,
				input,
			);
			const plan = await applyManifest(
				c.var.deps,
				await gitopsActor(c.var.deps, actor.organizationId, id),
				{ type: "project", projectId: id, manifest },
				{ prune: input.prune, dryRun: true },
			);
			return c.json({ changes: plan.changes, warnings: plan.warnings }, 200);
		},
	)
	.openapi(
		mutation(
			"gitops.link",
			createRoute({
				method: "put",
				path: "/projects/{id}/gitops",
				tags,
				security,
				summary: "Link the project to a manifest in git, or change the link",
				description:
					"The manifest must read and validate now. Nothing is applied until the next push, or `POST /projects/{id}/gitops/sync`. `prune` needs `delete` on the project. With `managed`, writes to the project through the API, the UI and MCP are refused with 409 (secrets and these settings excepted).",
				middleware: [requirePermission("write", byParam("project"))],
				request: { params: IdParam, ...body(LinkInput) },
				responses: { 200: json(Link, "Link"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const resource = c.get("resource");
			if (input.prune && resource) check(c, "delete", resource);
			await readGitManifest(c.var.deps, actor.organizationId, input);
			const values = {
				...input,
				organizationId: actor.organizationId,
				createdBy: actor.userId,
			};
			const row = one(
				await c.var.deps.db
					.insert(projectGitops)
					.values({ projectId: id, ...values })
					.onConflictDoUpdate({
						target: projectGitops.projectId,
						set: { ...input, lastError: null },
					})
					.returning(),
			);
			c.set("auditResourceId", id);
			c.set("auditDiff", input);
			return c.json(view(row), 200);
		},
	)
	.openapi(
		mutation(
			"gitops.sync",
			createRoute({
				method: "post",
				path: "/projects/{id}/gitops/sync",
				tags,
				security,
				summary: "Sync the project from git now",
				description:
					"Reads the manifest at the branch head and applies it as a push would (or only plans it when auto apply is off), then deploys the services it changed. A failure is returned and recorded on the link.",
				middleware: [requirePermission("write", byParam("project"))],
				request: { params: IdParam },
				responses: { 200: json(SyncResult, "Outcome"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const [link] = await c.var.deps.db
				.select()
				.from(projectGitops)
				.where(eq(projectGitops.projectId, id));
			if (!link)
				throw new Failure("not_found", "the project is not linked to git");
			c.set("auditResourceId", id);
			const { projectId: _p, ...out } = await syncGitops(c.var.deps, link);
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"gitops.unlink",
			createRoute({
				method: "delete",
				path: "/projects/{id}/gitops",
				tags,
				security,
				summary: "Stop following git",
				description:
					"Removes the link; the project keeps its current state and takes manual edits again.",
				middleware: [requirePermission("write", byParam("project"))],
				request: { params: IdParam },
				responses: { 204: { description: "Unlinked" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			await c.var.deps.db
				.delete(projectGitops)
				.where(eq(projectGitops.projectId, id));
			return c.body(null, 204);
		},
	);
