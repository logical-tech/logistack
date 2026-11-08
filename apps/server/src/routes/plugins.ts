import { createRoute, z } from "@hono/zod-openapi";
import {
	type PermissionAction,
	PLUGIN_STORAGE_LIMITS,
	type PluginManifest,
	PluginPage,
	PluginPolicy,
	PluginStatus,
	permissionActions,
} from "@logistack/contracts";
import {
	decrypt,
	dockerName,
	encrypt,
	maskConfig,
	mergeConfig,
	newId,
	type Resource,
} from "@logistack/core";
import {
	apiKeyUsage,
	apikey,
	instanceSettings,
	member,
	organizationRole,
	pluginInstall,
	pluginUiStorage,
	user,
} from "@logistack/db";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { auditInTx, mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import {
	callInstall,
	type InstallRow,
	installRow,
	manifestFromImage,
	manifestFromUrl,
	signSession,
	validateConfig,
} from "../plugins.ts";
import { runQueues } from "../run-queues.ts";
import {
	actorCan,
	check,
	inOrganization,
	locate,
	organizationResource,
	requireInstanceAdmin,
	requirePermission,
} from "../scope.ts";

const Source = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("image"),
		/** Any reference; it is resolved and pinned to a digest. */
		image: z.string().trim().min(1).max(512),
		/** Credentials to pull a private image with. */
		registryId: z.string().optional(),
	}),
	z.object({
		kind: z.literal("url"),
		/** A plugin running elsewhere, for development: no container is started. */
		url: z.url().max(2048),
	}),
]);

const ManifestView = z
	.record(z.string(), z.unknown())
	.openapi("PluginManifest", {
		description:
			"The plugin's manifest (`PluginManifest` in `@logistack/contracts`).",
	});

const Inspected = z
	.object({
		manifest: ManifestView,
		/** Digest-pinned image, or null for a dev URL. */
		image: z.string().nullable(),
		devUrl: z.string().nullable(),
		/** Permissions the manifest asks for that the caller does not hold. */
		missingPermissions: z.array(z.string()),
		/** Already installed in this organization (an install would conflict). */
		installedId: z.string().nullable(),
	})
	.openapi("PluginInspection");

const InstallView = z
	.object({
		id: z.string(),
		pluginId: z.string(),
		name: z.string(),
		description: z.string(),
		version: z.string(),
		image: z.string().nullable(),
		devUrl: z.string().nullable(),
		manifest: ManifestView,
		/** Settings, secrets masked. */
		config: z.record(z.string(), z.unknown()),
		enabled: z.boolean(),
		status: PluginStatus,
		statusMessage: z.string().nullable(),
		serviceAccountId: z.string().nullable(),
		/** Docker service name; null for a dev URL. */
		serviceName: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi("PluginInstall");

const Contribution = z
	.object({
		installId: z.string(),
		pluginId: z.string(),
		pluginName: z.string(),
		author: z.string().nullable(),
		/** Not from a reviewed marketplace entry; always true until the marketplace ships. */
		unlisted: z.boolean(),
		pages: z.array(PluginPage),
	})
	.openapi("PluginContribution");

const TestResult = z
	.object({
		ok: z.boolean(),
		health: z.object({ ok: z.boolean(), error: z.string().optional() }),
		/** null: the plugin has no `/v1/config/validate`. */
		config: z
			.object({ ok: z.boolean(), error: z.string().optional() })
			.nullable(),
	})
	.openapi("PluginTestResult");

const StorageKey = z.object({
	id: z.string(),
	key: z.string().min(1).max(PLUGIN_STORAGE_LIMITS.keyLength),
});

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The machine user's role: a colon keeps it out of the custom-role namespace (`[a-z0-9-]`). */
export const pluginRoleName = (installId: string) =>
	`plugin:${dockerName("plg", installId).slice("ls-plg-".length)}`;

/** Nudges the worker to converge plugin services now instead of on its next 30 s pass. */
const converge = (c: Context<Env>) =>
	runQueues(c.var.deps.config.REDIS_URL)
		.maintenance.add("plugins", {}, { removeOnComplete: true })
		.catch(() => {});

async function policy(c: Context<Env>): Promise<PluginPolicy> {
	const [s] = await c.var.deps.db
		.select({ p: instanceSettings.pluginPolicy })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return s?.p ?? "any";
}

/** Installs follow the instance policy; `verified` needs a marketplace entry, which phase 1 has none of. */
async function assertPolicyAllows(c: Context<Env>) {
	const p = await policy(c);
	if (p === "off")
		throw new Failure(
			"forbidden",
			"plugins are turned off on this instance; an instance admin can change the policy",
		);
	if (p === "verified")
		throw new Failure(
			"forbidden",
			"this instance only allows verified marketplace plugins",
		);
}

/** A plugin cannot get a permission its installer does not hold on the organization. */
function missingPermissions(c: Context<Env>, manifest: PluginManifest) {
	const actor = requireActor(c);
	const org = organizationResource(actor.organizationId);
	return manifest.permissions.filter((a) => !actorCan(actor, a, org));
}

async function resolveSource(
	c: Context<Env>,
	source: z.infer<typeof Source>,
): Promise<{
	manifest: PluginManifest;
	image: string | null;
	devUrl: string | null;
	registryId: string | null;
}> {
	const { db, masterKey } = c.var.deps;
	if (source.kind === "url")
		return {
			manifest: await manifestFromUrl(db, source.url),
			image: null,
			devUrl: source.url.replace(/\/+$/, ""),
			registryId: null,
		};
	const r = await manifestFromImage(
		db,
		masterKey,
		requireActor(c).organizationId,
		source.image,
		source.registryId,
	);
	return { ...r, devUrl: null, registryId: source.registryId ?? null };
}

async function view(c: Context<Env>, row: InstallRow) {
	const config = JSON.parse(
		await decrypt(c.var.deps.masterKey, row.configEncrypted),
	) as Record<string, unknown>;
	return {
		id: row.id,
		pluginId: row.pluginId,
		name: row.manifest.name,
		description: row.manifest.description,
		version: row.version,
		image: row.image,
		devUrl: row.devUrl,
		manifest: row.manifest as Record<string, unknown>,
		config: maskConfig(config, row.manifest.config),
		enabled: row.enabled,
		status: row.status,
		statusMessage: row.statusMessage,
		serviceAccountId: row.serviceAccountId,
		serviceName: row.image ? dockerName("plg", row.id) : null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

const byInstall = (c: Context<Env>) =>
	installRow(
		c.var.deps.db,
		requireActor(c).organizationId,
		c.req.param("id") ?? "",
	);

/** The resource a page's context names, checked to be the caller's; the organization otherwise. */
async function contextResource(
	c: Context<Env>,
	ctx: { serviceId?: string; projectId?: string },
): Promise<Resource> {
	const orgId = requireActor(c).organizationId;
	if (ctx.serviceId)
		return locate(c.var.deps.db, orgId, "service", ctx.serviceId);
	if (ctx.projectId)
		return locate(c.var.deps.db, orgId, "project", ctx.projectId);
	return organizationResource(orgId);
}

const ToolView = z
	.object({
		installId: z.string(),
		pluginId: z.string(),
		pluginName: z.string(),
		name: z.string(),
		description: z.string(),
		inputSchema: z.record(z.string(), z.unknown()),
		/** Run it with `POST /plugins/{id}/tools/{name}/destructive`, which asks for confirmation. */
		destructive: z.boolean(),
	})
	.openapi("PluginTool");

const ToolParams = z.object({ id: z.string(), name: z.string() });
const ToolInput = z.object({
	input: z.record(z.string(), z.unknown()).default({}),
});
const ToolOutput = z
	.object({ output: z.unknown() })
	.openapi("PluginToolOutput");

/** Calls a contributed tool after checking it exists, its kind and its input schema. */
async function runTool(c: Context<Env>, destructive: boolean) {
	const row = await byInstall(c);
	const { name } = c.req.valid("param" as never) as { name: string };
	const { input } = c.req.valid("json" as never) as {
		input: Record<string, unknown>;
	};
	c.set("auditResourceId", row.id);
	if (!row.enabled) throw new Failure("conflict", "the plugin is disabled");
	const tool = row.manifest.contributes.tools.find((t) => t.name === name);
	if (!tool)
		throw new Failure(
			"not_found",
			`${row.manifest.name} has no tool '${name}'`,
		);
	if (tool.destructive !== destructive)
		throw new Failure(
			"bad_request",
			destructive
				? `'${name}' is not destructive; call /tools/${name}`
				: `'${name}' is destructive; call /tools/${name}/destructive`,
		);
	validateConfig(tool.inputSchema, input);
	const actor = requireActor(c);
	c.set("auditDiff", { tool: name, input });
	try {
		const r = await callInstall<{ output?: unknown }>(
			c.var.deps,
			row,
			`/v1/tools/${name}`,
			{ input, caller: { userId: actor.userId, kind: actor.kind } },
			{ timeoutMs: 60_000 },
		);
		return { output: r?.output ?? null };
	} catch (e) {
		throw new Failure("bad_request", errMsg(e));
	}
}

export const plugins = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins",
			tags: ["plugins"],
			security,
			summary: "Plugins installed in the organization",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(InstallView), "Installs"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(pluginInstall)
				.where(eq(pluginInstall.organizationId, requireActor(c).organizationId))
				.orderBy(asc(pluginInstall.createdAt));
			return c.json(await Promise.all(rows.map((r) => view(c, r))), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins/contributions",
			tags: ["plugins"],
			security,
			summary: "Pages of enabled plugins, for the dashboard's navigation",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.array(Contribution), "Contributions"),
				...errors,
			},
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(pluginInstall)
				.where(
					and(
						eq(pluginInstall.organizationId, requireActor(c).organizationId),
						eq(pluginInstall.enabled, true),
					),
				)
				.orderBy(asc(pluginInstall.createdAt));
			return c.json(
				rows.map((r) => ({
					installId: r.id,
					pluginId: r.pluginId,
					pluginName: r.manifest.name,
					author: r.manifest.author?.name ?? null,
					unlisted: true,
					pages: r.manifest.contributes.pages,
				})),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins/tools",
			tags: ["plugins"],
			security,
			summary:
				"Tools that enabled plugins contribute, with their input schemas",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(ToolView), "Tools"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(pluginInstall)
				.where(
					and(
						eq(pluginInstall.organizationId, requireActor(c).organizationId),
						eq(pluginInstall.enabled, true),
					),
				)
				.orderBy(asc(pluginInstall.createdAt));
			return c.json(
				rows.flatMap((r) =>
					r.manifest.contributes.tools.map((t) => ({
						installId: r.id,
						pluginId: r.pluginId,
						pluginName: r.manifest.name,
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema as Record<string, unknown>,
						destructive: t.destructive,
					})),
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"plugin.tool_call",
			createRoute({
				method: "post",
				path: "/plugins/{id}/tools/{name}",
				tags: ["plugins"],
				security,
				summary: "Run a plugin's tool",
				description:
					"List tools and their input schemas with `GET /plugins/tools`. The plugin runs it with its own scoped key; destructive tools go through `/destructive`.",
				middleware: [requirePermission("write", inOrganization)],
				request: { params: ToolParams, ...body(ToolInput) },
				responses: { 200: json(ToolOutput, "Output"), ...errors },
			}),
		),
		async (c) => c.json(await runTool(c, false), 200),
	)
	.openapi(
		mutation(
			"plugin.tool_call_destructive",
			createRoute({
				method: "post",
				path: "/plugins/{id}/tools/{name}/destructive",
				tags: ["plugins"],
				security,
				summary: "Run a plugin's destructive tool",
				description:
					"For tools the plugin marks destructive. Needs the `delete` action; the Agent asks the user first.",
				middleware: [requirePermission("delete", inOrganization)],
				request: { params: ToolParams, ...body(ToolInput) },
				responses: { 200: json(ToolOutput, "Output"), ...errors },
			}),
		),
		async (c) => c.json(await runTool(c, true), 200),
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins/policy",
			tags: ["plugins"],
			security,
			summary: "Who may install plugins on this instance",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.object({ policy: PluginPolicy }), "Policy"),
				...errors,
			},
		}),
		async (c) => c.json({ policy: await policy(c) }, 200),
	)
	.openapi(
		mutation(
			"plugin.policy_update",
			createRoute({
				method: "put",
				path: "/plugins/policy",
				tags: ["plugins"],
				security,
				summary: "Set who may install plugins on this instance",
				description:
					"`off`: no installs. `verified`: marketplace-reviewed plugins only. `any`: any image or dev URL. Existing installs keep running.",
				middleware: [requireInstanceAdmin],
				request: body(z.object({ policy: PluginPolicy })),
				responses: {
					200: json(z.object({ policy: PluginPolicy }), "Policy"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { policy: next } = c.req.valid("json");
			const before = await policy(c);
			await c.var.deps.db
				.update(instanceSettings)
				.set({ pluginPolicy: next })
				.where(eq(instanceSettings.id, "singleton"));
			c.set("auditDiff", {
				before: { policy: before },
				after: { policy: next },
			});
			return c.json({ policy: next }, 200);
		},
	)
	.openapi(
		mutation(
			"plugin.inspect",
			createRoute({
				method: "post",
				path: "/plugins/inspect",
				tags: ["plugins"],
				security,
				summary: "Read a plugin's manifest from an image or a dev URL",
				description:
					"Resolves the image to a digest and reads its `io.logistack.plugin.manifest` label without pulling it. Nothing is installed.",
				middleware: [requirePermission("plugins", inOrganization)],
				request: body(Source),
				responses: { 200: json(Inspected, "Manifest"), ...errors },
			}),
		),
		async (c) => {
			await assertPolicyAllows(c);
			const r = await resolveSource(c, c.req.valid("json"));
			const [existing] = await c.var.deps.db
				.select({ id: pluginInstall.id })
				.from(pluginInstall)
				.where(
					and(
						eq(pluginInstall.organizationId, requireActor(c).organizationId),
						eq(pluginInstall.pluginId, r.manifest.id),
					),
				);
			return c.json(
				{
					manifest: r.manifest as Record<string, unknown>,
					image: r.image,
					devUrl: r.devUrl,
					missingPermissions: missingPermissions(c, r.manifest),
					installedId: existing?.id ?? null,
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"plugin.install",
			createRoute({
				method: "post",
				path: "/plugins",
				tags: ["plugins"],
				security,
				summary: "Install a plugin in the organization",
				description:
					"Creates a service account holding exactly the manifest's permissions (each must be held by the caller), an API key for it, and the install row; the worker starts the container. A dev URL starts nothing.",
				middleware: [requirePermission("plugins", inOrganization)],
				request: body(
					z.object({
						source: Source,
						config: z.record(z.string(), z.unknown()).default({}),
					}),
				),
				responses: {
					201: json(
						InstallView.extend({
							/** Only for a dev-URL install, only here: what the plugin running elsewhere needs. */
							devCredentials: z
								.object({ token: z.string(), signingSecret: z.string() })
								.optional(),
						}),
						"Installed",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			await assertPolicyAllows(c);
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const { db, masterKey, auth } = c.var.deps;
			const r = await resolveSource(c, input.source);
			const missing = missingPermissions(c, r.manifest);
			if (missing.length)
				throw new Failure(
					"forbidden",
					`the plugin asks for ${missing.join(", ")}, which you do not hold`,
					{ missing },
				);
			const config = validateConfig(r.manifest.config, input.config);
			const installId = newId("plg");
			const accountId = crypto.randomUUID();
			const role = pluginRoleName(installId);
			const signingSecret = Buffer.from(
				crypto.getRandomValues(new Uint8Array(32)),
			).toString("base64url");
			const ordered = permissionActions.filter((a) =>
				r.manifest.permissions.includes(a),
			);
			await db.transaction(async (tx) => {
				const [dup] = await tx
					.select({ id: pluginInstall.id })
					.from(pluginInstall)
					.where(
						and(
							eq(pluginInstall.organizationId, actor.organizationId),
							eq(pluginInstall.pluginId, r.manifest.id),
						),
					);
				if (dup)
					throw new Failure(
						"conflict",
						`${r.manifest.name} is already installed; update it instead`,
					);
				await tx.insert(organizationRole).values({
					id: crypto.randomUUID(),
					organizationId: actor.organizationId,
					role,
					permission: JSON.stringify({ logistack: ordered }),
				});
				await tx.insert(user).values({
					id: accountId,
					name: `Plugin · ${r.manifest.name}`,
					email: `${accountId}@service-accounts.invalid`,
					kind: "machine",
				});
				await tx.insert(member).values({
					id: crypto.randomUUID(),
					organizationId: actor.organizationId,
					userId: accountId,
					role,
					createdAt: new Date(),
				});
				await tx.insert(pluginInstall).values({
					id: installId,
					organizationId: actor.organizationId,
					pluginId: r.manifest.id,
					version: r.manifest.version,
					image: r.image,
					devUrl: r.devUrl,
					manifest: r.manifest,
					registryId: r.registryId,
					configEncrypted: await encrypt(masterKey, JSON.stringify(config)),
					serviceAccountId: accountId,
					signingSecretEncrypted: await encrypt(masterKey, signingSecret),
					status: "pending",
					installedBy: actor.userId,
				});
				await auditInTx(c, tx, {
					resourceId: installId,
					diff: {
						pluginId: r.manifest.id,
						version: r.manifest.version,
						image: r.image,
						devUrl: r.devUrl,
						permissions: ordered,
					},
				});
			});
			// better-auth writes the key through its own adapter, outside the transaction above;
			// if it fails, undo the rows so a retry starts clean.
			const key = await auth.api
				.createApiKey({
					body: {
						userId: accountId,
						name: "plugin",
						expiresIn: null,
						metadata: { organizationId: actor.organizationId },
					},
				})
				.catch(async (e: unknown) => {
					await db.transaction(async (tx) => {
						await tx
							.delete(pluginInstall)
							.where(eq(pluginInstall.id, installId));
						await tx.delete(user).where(eq(user.id, accountId));
						await tx
							.delete(organizationRole)
							.where(
								and(
									eq(organizationRole.organizationId, actor.organizationId),
									eq(organizationRole.role, role),
								),
							);
					});
					throw e;
				});
			const [row] = await db
				.update(pluginInstall)
				.set({ tokenEncrypted: await encrypt(masterKey, key.key) })
				.where(eq(pluginInstall.id, installId))
				.returning();
			await converge(c);
			return c.json(
				{
					...(await view(c, one(row ? [row] : [], "plugin"))),
					...(r.devUrl
						? { devCredentials: { token: key.key, signingSecret } }
						: {}),
				},
				201,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins/self",
			tags: ["plugins"],
			security,
			summary: "The calling plugin's own install and settings",
			description:
				"For a plugin's own API key only. Returns its settings with secrets in clear, so a settings change needs no restart.",
			responses: {
				200: json(
					z.object({
						installId: z.string(),
						pluginId: z.string(),
						enabled: z.boolean(),
						config: z.record(z.string(), z.unknown()),
					}),
					"Install",
				),
				...errors,
			},
		}),
		async (c) => {
			const actor = requireActor(c);
			const [row] =
				actor.kind === "machine"
					? await c.var.deps.db
							.select()
							.from(pluginInstall)
							.where(
								and(
									eq(pluginInstall.serviceAccountId, actor.userId),
									eq(pluginInstall.organizationId, actor.organizationId),
								),
							)
					: [];
			if (!row)
				throw new Failure("forbidden", "only a plugin's own key can read this");
			return c.json(
				{
					installId: row.id,
					pluginId: row.pluginId,
					enabled: row.enabled,
					config: JSON.parse(
						await decrypt(c.var.deps.masterKey, row.configEncrypted),
					) as Record<string, unknown>,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins/{id}",
			tags: ["plugins"],
			security,
			summary: "One install",
			middleware: [requirePermission("read", inOrganization)],
			request: { params: IdParam },
			responses: { 200: json(InstallView, "Install"), ...errors },
		}),
		async (c) => c.json(await view(c, await byInstall(c)), 200),
	)
	.openapi(
		mutation(
			"plugin.update",
			createRoute({
				method: "patch",
				path: "/plugins/{id}",
				tags: ["plugins"],
				security,
				summary: "Change a plugin's settings, or turn it off and on",
				description:
					"`enabled: false` is the kill switch: the container scales to zero and its pages, events and tools disappear. A masked secret in `config` keeps the stored value.",
				middleware: [requirePermission("plugins", inOrganization)],
				request: {
					params: IdParam,
					...body(
						z.object({
							config: z.record(z.string(), z.unknown()).optional(),
							enabled: z.boolean().optional(),
						}),
					),
				},
				responses: { 200: json(InstallView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const row = await byInstall(c);
			c.set("auditResourceId", row.id);
			const { db, masterKey } = c.var.deps;
			const patch: Partial<typeof pluginInstall.$inferInsert> = {};
			if (input.config) {
				const stored = JSON.parse(
					await decrypt(masterKey, row.configEncrypted),
				) as Record<string, unknown>;
				const merged = validateConfig(
					row.manifest.config,
					mergeConfig(stored, input.config, row.manifest.config),
				);
				patch.configEncrypted = await encrypt(
					masterKey,
					JSON.stringify(merged),
				);
			}
			if (input.enabled !== undefined) {
				patch.enabled = input.enabled;
				patch.status = "pending";
			}
			c.set("auditDiff", {
				before: { enabled: row.enabled },
				after: {
					enabled: input.enabled ?? row.enabled,
					config: input.config
						? maskConfig(input.config, row.manifest.config)
						: undefined,
				},
			});
			const [updated] = Object.keys(patch).length
				? await db
						.update(pluginInstall)
						.set(patch)
						.where(eq(pluginInstall.id, row.id))
						.returning()
				: [row];
			await converge(c);
			return c.json(await view(c, updated ?? row), 200);
		},
	)
	.openapi(
		mutation(
			"plugin.uninstall",
			createRoute({
				method: "delete",
				path: "/plugins/{id}",
				tags: ["plugins"],
				security,
				summary: "Uninstall a plugin",
				description:
					"Removes the install, its service account and keys, and its pages' stored UI state; the worker removes the container. The data volume is kept.",
				middleware: [requirePermission("plugins", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Uninstalled" }, ...errors },
			}),
		),
		async (c) => {
			const row = await byInstall(c);
			c.set("auditResourceId", row.id);
			await c.var.deps.db.transaction(async (tx) => {
				if (row.serviceAccountId) {
					const keys = await tx
						.select({ id: apikey.id })
						.from(apikey)
						.where(eq(apikey.referenceId, row.serviceAccountId));
					if (keys.length) {
						await tx.delete(apiKeyUsage).where(
							inArray(
								apiKeyUsage.keyId,
								keys.map((k) => k.id),
							),
						);
						await tx
							.delete(apikey)
							.where(eq(apikey.referenceId, row.serviceAccountId));
					}
					// Membership, grants and sessions cascade with the user.
					await tx
						.delete(user)
						.where(
							and(eq(user.id, row.serviceAccountId), eq(user.kind, "machine")),
						);
				}
				await tx
					.delete(organizationRole)
					.where(
						and(
							eq(organizationRole.organizationId, row.organizationId),
							eq(organizationRole.role, pluginRoleName(row.id)),
						),
					);
				await tx.delete(pluginInstall).where(eq(pluginInstall.id, row.id));
				await auditInTx(c, tx, {
					diff: { pluginId: row.pluginId, version: row.version },
				});
			});
			await converge(c);
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"plugin.test",
			createRoute({
				method: "post",
				path: "/plugins/{id}/test",
				tags: ["plugins"],
				security,
				summary: "Check that a plugin answers and accepts its settings",
				description:
					"Calls `GET /v1/health`, then `POST /v1/config/validate` with the stored settings when the plugin has it.",
				middleware: [requirePermission("plugins", inOrganization)],
				request: { params: IdParam },
				responses: { 200: json(TestResult, "Result"), ...errors },
			}),
		),
		async (c) => {
			const row = await byInstall(c);
			c.set("auditResourceId", row.id);
			const deps = c.var.deps;
			let health: { ok: boolean; error?: string } = { ok: true };
			try {
				await callInstall(deps, row, "/v1/health", null, {
					method: "GET",
					timeoutMs: 5_000,
				});
			} catch (e) {
				health = { ok: false, error: errMsg(e) };
			}
			let config: { ok: boolean; error?: string } | null = null;
			if (health.ok) {
				const settings = JSON.parse(
					await decrypt(deps.masterKey, row.configEncrypted),
				);
				try {
					const r = await callInstall<{ ok?: boolean; error?: string }>(
						deps,
						row,
						"/v1/config/validate",
						{ config: settings },
					);
					config =
						r?.ok === false
							? {
									ok: false,
									error: r.error ?? "the plugin refused the settings",
								}
							: { ok: true };
				} catch (e) {
					const status = (e as { status?: number }).status;
					config = status === 404 ? null : { ok: false, error: errMsg(e) };
				}
			}
			return c.json(
				{ ok: health.ok && config?.ok !== false, health, config },
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins/{id}/session",
			tags: ["plugins"],
			security,
			summary: "A 5-minute token a plugin page sends its own backend",
			description:
				"Carries the viewer, the organization and the viewer's actions on the page's context (a service or project for tabs). It is not accepted by this API.",
			middleware: [requirePermission("read", inOrganization)],
			request: {
				params: IdParam,
				query: z.object({
					serviceId: z.string().optional(),
					projectId: z.string().optional(),
				}),
			},
			responses: {
				200: json(
					z.object({ token: z.string(), expiresAt: z.string() }),
					"Token",
				),
				...errors,
			},
		}),
		async (c) => {
			const row = await byInstall(c);
			if (!row.enabled) throw new Failure("conflict", "the plugin is disabled");
			const ctx = c.req.valid("query");
			const resource = await contextResource(c, ctx);
			const actor = check(c, "read", resource);
			const [u] = await c.var.deps.db
				.select({ name: user.name })
				.from(user)
				.where(eq(user.id, actor.userId));
			const permissions = permissionActions.filter((a: PermissionAction) =>
				actorCan(actor, a, resource),
			);
			return c.json(
				await signSession(c.var.deps.config.BETTER_AUTH_SECRET, {
					userId: actor.userId,
					name: u?.name ?? "",
					organizationId: actor.organizationId,
					installId: row.id,
					permissions,
					context: {
						...(ctx.serviceId ? { serviceId: ctx.serviceId } : {}),
						...(ctx.projectId ? { projectId: ctx.projectId } : {}),
					},
				}),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins/{id}/storage/{key}",
			tags: ["plugins"],
			security,
			summary: "A plugin page's stored UI value for the caller",
			middleware: [requirePermission("read", inOrganization)],
			request: { params: StorageKey },
			responses: {
				200: json(z.object({ value: z.unknown() }), "Value, null when unset"),
				...errors,
			},
		}),
		async (c) => {
			const row = await byInstall(c);
			const { key } = c.req.valid("param");
			const [v] = await c.var.deps.db
				.select({ value: pluginUiStorage.value })
				.from(pluginUiStorage)
				.where(
					and(
						eq(pluginUiStorage.installId, row.id),
						eq(pluginUiStorage.userId, requireActor(c).userId),
						eq(pluginUiStorage.key, key),
					),
				);
			return c.json({ value: v?.value ?? null }, 200);
		},
	)
	.openapi(
		mutation(
			"plugin.storage_set",
			createRoute({
				method: "put",
				path: "/plugins/{id}/storage/{key}",
				tags: ["plugins"],
				security,
				summary: "Store a plugin page's UI value for the caller",
				description: `Values up to ${PLUGIN_STORAGE_LIMITS.valueBytes / 1024} KB, ${PLUGIN_STORAGE_LIMITS.keys} keys per user and plugin. Not for secrets.`,
				middleware: [requirePermission("read", inOrganization)],
				request: {
					params: StorageKey,
					...body(z.object({ value: z.unknown() })),
				},
				responses: { 204: { description: "Stored" }, ...errors },
			}),
		),
		async (c) => {
			const row = await byInstall(c);
			c.set("auditResourceId", row.id);
			const { key } = c.req.valid("param");
			const { value } = c.req.valid("json");
			const userId = requireActor(c).userId;
			if (
				new TextEncoder().encode(JSON.stringify(value ?? null)).length >
				PLUGIN_STORAGE_LIMITS.valueBytes
			)
				throw new Failure("bad_request", "the value is larger than 16 KB");
			const { db } = c.var.deps;
			await db.transaction(async (tx) => {
				const [n] = await tx
					.select({ n: count() })
					.from(pluginUiStorage)
					.where(
						and(
							eq(pluginUiStorage.installId, row.id),
							eq(pluginUiStorage.userId, userId),
						),
					);
				const [exists] = await tx
					.select({ key: pluginUiStorage.key })
					.from(pluginUiStorage)
					.where(
						and(
							eq(pluginUiStorage.installId, row.id),
							eq(pluginUiStorage.userId, userId),
							eq(pluginUiStorage.key, key),
						),
					);
				if (!exists && (n?.n ?? 0) >= PLUGIN_STORAGE_LIMITS.keys)
					throw new Failure(
						"conflict",
						`a plugin page may keep ${PLUGIN_STORAGE_LIMITS.keys} keys`,
					);
				await tx
					.insert(pluginUiStorage)
					.values({ installId: row.id, userId, key, value: value ?? null })
					.onConflictDoUpdate({
						target: [
							pluginUiStorage.installId,
							pluginUiStorage.userId,
							pluginUiStorage.key,
						],
						set: { value: value ?? null, updatedAt: new Date() },
					});
				await auditInTx(c, tx, { diff: { key } });
			});
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"plugin.storage_delete",
			createRoute({
				method: "delete",
				path: "/plugins/{id}/storage/{key}",
				tags: ["plugins"],
				security,
				summary: "Delete a plugin page's UI value for the caller",
				middleware: [requirePermission("read", inOrganization)],
				request: { params: StorageKey },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const row = await byInstall(c);
			c.set("auditResourceId", row.id);
			const { key } = c.req.valid("param");
			await c.var.deps.db
				.delete(pluginUiStorage)
				.where(
					and(
						eq(pluginUiStorage.installId, row.id),
						eq(pluginUiStorage.userId, requireActor(c).userId),
						eq(pluginUiStorage.key, key),
					),
				);
			c.set("auditDiff", { key });
			return c.body(null, 204);
		},
	);
