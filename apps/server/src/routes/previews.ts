import { createRoute } from "@hono/zod-openapi";
import { PreviewSettings } from "@logistack/contracts";
import {
	environment,
	instanceSettings,
	project,
	service,
	stack,
} from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { mutation } from "../audit.ts";
import { Failure, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { readSettings, sealSettings } from "../previews.ts";
import { byParam, requirePermission } from "../scope.ts";

const tags = ["previews"];

const Settings = PreviewSettings;

/** Secret override values never leave the server. */
const shown = (s: PreviewSettings): PreviewSettings => ({
	...s,
	variables: s.variables.map(({ value, ...v }) =>
		v.secret ? v : { ...v, value },
	),
});

const stored = async (
	c: { var: { deps: Parameters<typeof readSettings>[0] } },
	id: string,
) => {
	const [row] = await c.var.deps.db
		.select({ sealed: project.previewSettingsEncrypted })
		.from(project)
		.where(eq(project.id, id));
	return row?.sealed ? readSettings(c.var.deps, row.sealed) : null;
};

export const previews = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/projects/{id}/previews",
			tags,
			security,
			summary: "A project's pull request preview settings",
			description:
				"Null until previews are set up. Secret override values are omitted. The previews themselves are the project's environments with a `preview` field.",
			middleware: [requirePermission("read", byParam("project"))],
			request: { params: IdParam },
			responses: {
				200: json(Settings.nullable(), "Settings"),
				...errors,
			},
		}),
		async (c) => {
			const s = await stored(c, c.req.valid("param").id);
			return c.json(s && shown(s), 200);
		},
	)
	.openapi(
		mutation(
			"project.previews_update",
			createRoute({
				method: "put",
				path: "/projects/{id}/previews",
				tags,
				security,
				summary: "Set up pull request previews",
				description:
					"Each pull request on the followed services' or stacks' repository gets a `preview` environment `pr-<number>` cloned from the source environment, with fresh volumes and databases, the followed services building the pull request's head commit, the followed git stacks reading their compose file from its branch, and the override variables winning over the source's. Every stack is copied with its own services; each exposed service gets a host from `domainPattern` (or a generated one), and every preview container gets `LOGISTACK_PREVIEW_URL` and `LOGISTACK_PREVIEW_URL_<SERVICE>`. Closing the pull request, or `ttlHours` without an event, deletes it. Forks are refused unless `allowForks`: their code would run with the preview's secrets. A secret override sent without a value keeps the stored one.",
				middleware: [requirePermission("admin", byParam("project"))],
				request: { params: IdParam, ...body(Settings) },
				responses: { 200: json(Settings, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const id = c.req.valid("param").id;
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const [source] = await db
				.select()
				.from(environment)
				.where(
					and(
						eq(environment.id, input.sourceEnvironmentId),
						eq(environment.projectId, id),
					),
				);
			if (!source || source.preview)
				throw new Failure(
					"bad_request",
					"the source environment must be one of this project's own environments, not a preview",
				);
			const svcs = await db
				.select({ slug: service.slug, spec: service.spec })
				.from(service)
				.where(eq(service.environmentId, source.id));
			for (const slug of input.services) {
				const spec = svcs.find((s) => s.slug === slug)?.spec;
				if (
					spec?.kind !== "application" ||
					spec.source.type !== "git" ||
					!spec.source.gitProviderId
				)
					throw new Failure(
						"bad_request",
						`${slug} is not a service of ${source.name} that builds from a connected git repository`,
					);
			}
			const stacks = input.stacks.length
				? await db
						.select({ name: stack.name, git: stack.git })
						.from(stack)
						.where(eq(stack.environmentId, source.id))
				: [];
			for (const name of input.stacks)
				if (!stacks.find((s) => s.name === name)?.git)
					throw new Failure(
						"bad_request",
						`${name} is not a stack of ${source.name} deployed from a git repository`,
					);
			if (input.domainPattern?.includes("{wildcard}")) {
				const [s] = await db
					.select({ w: instanceSettings.customWildcard })
					.from(instanceSettings);
				if (!s?.w?.startsWith("*."))
					throw new Failure(
						"bad_request",
						"{wildcard} needs the instance's custom wildcard domain: set it in the instance settings",
					);
			}
			const keys = new Set<string>();
			const before = await stored(c, id);
			const variables = input.variables.map((v) => {
				if (keys.has(v.key))
					throw new Failure("bad_request", `variable ${v.key} is listed twice`);
				keys.add(v.key);
				const value =
					v.value ??
					(v.secret
						? before?.variables.find((b) => b.key === v.key && b.secret)?.value
						: undefined);
				if (value === undefined)
					throw new Failure("bad_request", `variable ${v.key} needs a value`);
				return { ...v, value };
			});
			const settings = { ...input, variables };
			one(
				await db
					.update(project)
					.set({
						previewSettingsEncrypted: await sealSettings(c.var.deps, settings),
					})
					.where(eq(project.id, id))
					.returning({ id: project.id }),
				"project",
			);
			return c.json(shown(settings), 200);
		},
	);
