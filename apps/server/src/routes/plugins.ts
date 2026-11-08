import { createRoute, z } from "@hono/zod-openapi";
import {
	type PermissionAction,
	PLUGIN_STORAGE_LIMITS,
	PluginIndexPayload,
	type PluginManifest,
	PluginPage,
	PluginPolicy,
	PluginStatus,
	permissionActions,
} from "@logistack/contracts";
import {
	compareVersions,
	decrypt,
	dockerName,
	encrypt,
	isReleaseVersion,
	manifestDiff,
	maskConfig,
	mergeConfig,
	newId,
	normalizeVersion,
	type Resource,
	satisfiesRange,
} from "@logistack/core";
import {
	apiKeyUsage,
	apikey,
	instanceSettings,
	member,
	organizationRole,
	pluginIndex,
	pluginInstall,
	pluginUiStorage,
	user,
} from "@logistack/db";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { auditInTx, mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, one } from "../errors.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import {
	ensureOfficialIndex,
	fetchSigned,
	INDEX_STALE_MS,
	type IndexRow,
	indexRow,
	indexVersion,
	pingInstall,
	pluginVersions,
	refreshIndex,
} from "../plugin-index.ts";
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
	z.object({
		kind: z.literal("index"),
		/** A marketplace index this instance trusts (`GET /plugins/indexes`). */
		indexId: z.string(),
		pluginId: z.string().max(128),
		version: z.string().max(64),
	}),
]);
type Source = z.infer<typeof Source>;

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
		/** The marketplace index it comes from; null: an image or dev URL ("Unlisted"). */
		indexId: z.string().nullable(),
		/** The index marks this version reviewed by a maintainer. */
		verified: z.boolean(),
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
		/** The marketplace index it came from; null: an image or dev URL ("Unlisted"). */
		indexId: z.string().nullable(),
		verified: z.boolean(),
		/** The index yanked this version (as of its last refresh). The plugin keeps running. */
		yanked: z.boolean(),
		/** What `POST /plugins/{id}/rollback` goes back to; null before the first update. */
		previousVersion: z.string().nullable(),
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
		/** Not installed from a marketplace index. */
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

async function settings(c: Context<Env>) {
	const [s] = await c.var.deps.db
		.select({
			policy: instanceSettings.pluginPolicy,
			installPing: instanceSettings.pluginInstallPing,
		})
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return { policy: s?.policy ?? "any", installPing: s?.installPing ?? false };
}

const policy = async (c: Context<Env>): Promise<PluginPolicy> =>
	(await settings(c)).policy;

const PolicyView = z
	.object({
		policy: PluginPolicy,
		/** Opt-in: tell the index on each marketplace install (plugin id and version only). */
		installPing: z.boolean(),
	})
	.openapi("PluginPolicySettings");

/**
 * Installs follow the instance policy; `verified` allows only versions a trusted index marks
 * verified. Called once before resolving a source (`verified` unknown) and once after.
 */
async function assertPolicyAllows(
	c: Context<Env>,
	source: Pick<Source, "kind">,
	verified?: boolean,
) {
	const p = await policy(c);
	if (p === "off")
		throw new Failure(
			"forbidden",
			"plugins are turned off on this instance; an instance admin can change the policy",
		);
	if (p === "verified" && (source.kind !== "index" || verified === false))
		throw new Failure(
			"forbidden",
			"this instance only allows verified marketplace plugins",
		);
}

/** The manifest's `logistack` range must include this server's version; a dev build skips the check. */
function assertCompatible(c: Context<Env>, manifest: PluginManifest) {
	const v = normalizeVersion(c.var.deps.config.LOGISTACK_VERSION);
	if (!compatible(v, manifest))
		throw new Failure(
			"conflict",
			`${manifest.name} ${manifest.version} needs LogiStack ${manifest.logistack}; this server runs ${v}`,
		);
}

const compatible = (serverVersion: string, manifest: PluginManifest) =>
	!manifest.logistack ||
	!isReleaseVersion(serverVersion) ||
	satisfiesRange(serverVersion, manifest.logistack);

/** A plugin cannot get a permission its installer does not hold on the organization. */
function missingPermissions(c: Context<Env>, manifest: PluginManifest) {
	const actor = requireActor(c);
	const org = organizationResource(actor.organizationId);
	return manifest.permissions.filter((a) => !actorCan(actor, a, org));
}

type Resolved = {
	manifest: PluginManifest;
	image: string | null;
	devUrl: string | null;
	registryId: string | null;
	indexId: string | null;
	verified: boolean;
};

const digestOf = (image: string) => image.slice(image.indexOf("@") + 1);

/**
 * A version from a trusted index: image and manifest as the index signed them, after checking
 * that the registry serves that digest with the same manifest label.
 */
async function resolveIndexVersion(
	c: Context<Env>,
	index: IndexRow,
	pluginId: string,
	version: string,
): Promise<Resolved> {
	const { db, masterKey } = c.var.deps;
	const v = await indexVersion(db, index, pluginId, version);
	// Before touching the registry: the policy may refuse it on the index's word alone.
	await assertPolicyAllows(c, { kind: "index" }, v.verified);
	if (v.yanked)
		throw new Failure(
			"conflict",
			`${pluginId} ${version} was yanked by the index; pick another version`,
		);
	if (v.manifest.id !== pluginId || v.manifest.version !== v.version)
		throw new Failure(
			"conflict",
			"the index entry's manifest names another plugin or version",
		);
	const live = await manifestFromImage(
		db,
		masterKey,
		requireActor(c).organizationId,
		v.image,
	);
	if (digestOf(live.image) !== digestOf(v.image))
		throw new Failure(
			"conflict",
			"the registry serves another digest than the index signed",
		);
	if (!Bun.deepEquals(live.manifest, v.manifest))
		throw new Failure(
			"conflict",
			"the image's manifest label differs from the manifest the index signed",
		);
	return {
		manifest: v.manifest,
		image: v.image,
		devUrl: null,
		registryId: null,
		indexId: index.id,
		verified: v.verified,
	};
}

async function resolveSource(
	c: Context<Env>,
	source: Source,
): Promise<Resolved> {
	const { db, masterKey } = c.var.deps;
	if (source.kind === "index") {
		const index = await indexRow(db, source.indexId);
		return resolveIndexVersion(c, index, source.pluginId, source.version);
	}
	if (source.kind === "url")
		return {
			manifest: await manifestFromUrl(db, source.url),
			image: null,
			devUrl: source.url.replace(/\/+$/, ""),
			registryId: null,
			indexId: null,
			verified: false,
		};
	const r = await manifestFromImage(
		db,
		masterKey,
		requireActor(c).organizationId,
		source.image,
		source.registryId,
	);
	return {
		...r,
		devUrl: null,
		registryId: source.registryId ?? null,
		indexId: null,
		verified: false,
	};
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
		indexId: row.indexId,
		verified: row.verified,
		yanked: row.yanked,
		previousVersion: row.previousVersion,
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

const IndexView = z
	.object({
		id: z.string(),
		url: z.string(),
		name: z.string(),
		/** The official index, configured by the server; it cannot be removed. */
		builtin: z.boolean(),
		/** Ids of the signing keys this instance trusts for it. */
		keyIds: z.array(z.string()),
		fetchedAt: z.string().nullable(),
		lastError: z.string().nullable(),
		plugins: z.number(),
	})
	.openapi("PluginIndex");

const indexView = (r: IndexRow) => ({
	id: r.id,
	url: r.url,
	name: r.name,
	builtin: r.builtin,
	keyIds: Object.keys(r.publicKeys).filter((k) => r.publicKeys[k]),
	fetchedAt: r.fetchedAt?.toISOString() ?? null,
	lastError: r.lastError,
	plugins: r.entries.length,
});

const Diff = z.object({
	added: z.array(z.string()),
	removed: z.array(z.string()),
});

const MarketEntry = z
	.object({
		indexId: z.string(),
		indexName: z.string(),
		id: z.string(),
		name: z.string(),
		description: z.string(),
		author: z.string().nullable(),
		iconUrl: z.string().nullable(),
		verified: z.boolean(),
		latest: z.object({
			version: z.string(),
			image: z.string(),
			changelog: z.string().nullable(),
			publishedAt: z.string(),
			yanked: z.boolean(),
			manifest: ManifestView,
		}),
		/** The manifest's `logistack` range includes this server's version. */
		compatible: z.boolean(),
		/** This organization's install of the plugin, from any source. */
		installed: z
			.object({
				installId: z.string(),
				version: z.string(),
				indexId: z.string().nullable(),
			})
			.nullable(),
	})
	.openapi("PluginMarketEntry");

const UpdateView = z
	.object({
		version: z.string(),
		changelog: z.string().nullable(),
		publishedAt: z.string(),
		verified: z.boolean(),
		compatible: z.boolean(),
		/** Against the installed version: added permissions need `acceptPermissions: true`. */
		permissions: Diff,
		egress: Diff,
		/** Permissions the caller does not hold; the update is refused until someone who does runs it. */
		missingPermissions: z.array(z.string()),
	})
	.openapi("PluginUpdate");

const PublicKeys = z
	.record(z.string().min(1).max(128), z.string().max(256))
	.refine(
		(keys) =>
			Object.keys(keys).length > 0 &&
			Object.values(keys).every((k) => Buffer.from(k, "base64").length === 32),
		"at least one key; each a base64 raw Ed25519 public key (32 bytes)",
	);

/**
 * Moves an install to another version: the role's actions follow the new manifest and the
 * plugin gets a fresh API token (the old one is deleted), so a version never runs with a key
 * minted for another. The current version is kept for rollback.
 */
async function switchVersion(
	c: Context<Env>,
	row: InstallRow,
	next: Pick<Resolved, "image" | "manifest" | "verified">,
) {
	const { db, masterKey, auth } = c.var.deps;
	if (!row.serviceAccountId)
		throw new Failure(
			"conflict",
			"the install has no service account; reinstall it",
		);
	const accountId = row.serviceAccountId;
	const ordered = permissionActions.filter((a) =>
		next.manifest.permissions.includes(a),
	);
	const key = await auth.api.createApiKey({
		body: {
			userId: accountId,
			name: "plugin",
			expiresIn: null,
			metadata: { organizationId: row.organizationId },
		},
	});
	try {
		const [updated] = await db.transaction(async (tx) => {
			await tx
				.update(organizationRole)
				.set({ permission: JSON.stringify({ logistack: ordered }) })
				.where(
					and(
						eq(organizationRole.organizationId, row.organizationId),
						eq(organizationRole.role, pluginRoleName(row.id)),
					),
				);
			const old = await tx
				.select({ id: apikey.id })
				.from(apikey)
				.where(and(eq(apikey.referenceId, accountId), ne(apikey.id, key.id)));
			if (old.length) {
				const ids = old.map((k) => k.id);
				await tx.delete(apiKeyUsage).where(inArray(apiKeyUsage.keyId, ids));
				await tx.delete(apikey).where(inArray(apikey.id, ids));
			}
			return tx
				.update(pluginInstall)
				.set({
					image: next.image,
					version: next.manifest.version,
					manifest: next.manifest,
					verified: next.verified,
					yanked: false,
					previousImage: row.image,
					previousVersion: row.version,
					previousManifest: row.manifest,
					tokenEncrypted: await encrypt(masterKey, key.key),
					status: "pending",
					statusMessage: null,
				})
				.where(eq(pluginInstall.id, row.id))
				.returning();
		});
		await converge(c);
		return one(updated ? [updated] : [], "plugin");
	} catch (e) {
		await db.delete(apikey).where(eq(apikey.id, key.id));
		throw e;
	}
}

/** What every version change checks: policy, compatibility, and the caller holding each permission. */
async function assertCanSwitch(c: Context<Env>, r: Resolved) {
	await assertPolicyAllows(c, { kind: "index" }, r.verified);
	assertCompatible(c, r.manifest);
	const missing = missingPermissions(c, r.manifest);
	if (missing.length)
		throw new Failure(
			"forbidden",
			`${r.manifest.version} asks for ${missing.join(", ")}, which you do not hold`,
			{ missing },
		);
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
					unlisted: !r.indexId,
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
			responses: { 200: json(PolicyView, "Policy"), ...errors },
		}),
		async (c) => c.json(await settings(c), 200),
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
					"`off`: no installs. `verified`: versions a trusted index marks verified. `any`: any image or dev URL. Existing installs keep running. `installPing` (default off) lets marketplace installs tell the index the plugin id and version, nothing else.",
				middleware: [requireInstanceAdmin],
				request: body(
					z.object({
						policy: PluginPolicy.optional(),
						installPing: z.boolean().optional(),
					}),
				),
				responses: { 200: json(PolicyView, "Policy"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const before = await settings(c);
			await c.var.deps.db
				.update(instanceSettings)
				.set({
					...(input.policy ? { pluginPolicy: input.policy } : {}),
					...(input.installPing !== undefined
						? { pluginInstallPing: input.installPing }
						: {}),
				})
				.where(eq(instanceSettings.id, "singleton"));
			const after = await settings(c);
			c.set("auditDiff", { before, after });
			return c.json(after, 200);
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
			const source = c.req.valid("json");
			await assertPolicyAllows(c, source);
			const r = await resolveSource(c, source);
			await assertPolicyAllows(c, source, r.verified);
			assertCompatible(c, r.manifest);
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
					indexId: r.indexId,
					verified: r.verified,
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
			const input = c.req.valid("json");
			await assertPolicyAllows(c, input.source);
			const actor = requireActor(c);
			const { db, masterKey, auth } = c.var.deps;
			const r = await resolveSource(c, input.source);
			await assertPolicyAllows(c, input.source, r.verified);
			assertCompatible(c, r.manifest);
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
					indexId: r.indexId,
					verified: r.verified,
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
			if (r.indexId && input.source.kind === "index")
				void pingInstall(
					c.var.deps,
					await indexRow(db, r.indexId),
					r.manifest.id,
					r.manifest.version,
				).catch(() => {});
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
			path: "/plugins/indexes",
			tags: ["plugins"],
			security,
			summary: "Marketplace indexes this instance trusts",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(IndexView), "Indexes"), ...errors },
		}),
		async (c) => {
			const { db, config } = c.var.deps;
			await ensureOfficialIndex(db, config);
			const rows = await db
				.select()
				.from(pluginIndex)
				.orderBy(desc(pluginIndex.builtin), asc(pluginIndex.createdAt));
			return c.json(rows.map(indexView), 200);
		},
	)
	.openapi(
		mutation(
			"plugin.index_create",
			createRoute({
				method: "post",
				path: "/plugins/indexes",
				tags: ["plugins"],
				security,
				summary: "Trust a private marketplace index",
				description:
					"Fetches `GET {url}/v1/index` and checks its signature with the given keys before saving, so a wrong URL or key is refused. Instance admins only.",
				middleware: [requireInstanceAdmin],
				request: body(
					z.object({
						url: z.url().max(2048),
						/** Defaults to the name the index gives itself. */
						name: z.string().trim().min(1).max(80).optional(),
						/** `keyId` to base64 raw Ed25519 public key. */
						publicKeys: PublicKeys,
					}),
				),
				responses: { 201: json(IndexView, "Added"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const url = input.url.replace(/\/+$/, "");
			if (!/^https?:$/.test(new URL(url).protocol))
				throw new Failure("bad_request", "the index URL must be http or https");
			const index = await fetchSigned(
				db,
				{ url, publicKeys: input.publicKeys },
				"/v1/index",
				PluginIndexPayload,
			);
			const [row] = await db
				.insert(pluginIndex)
				.values({
					url,
					name: input.name ?? index.indexName,
					publicKeys: input.publicKeys,
					entries: index.plugins,
					fetchedAt: new Date(),
				})
				.returning();
			const created = one(row ? [row] : [], "plugin index");
			c.set("auditResourceId", created.id);
			c.set("auditDiff", { url, keyIds: Object.keys(input.publicKeys) });
			return c.json(indexView(created), 201);
		},
	)
	.openapi(
		mutation(
			"plugin.index_delete",
			createRoute({
				method: "delete",
				path: "/plugins/indexes/{id}",
				tags: ["plugins"],
				security,
				summary: "Stop trusting a private marketplace index",
				description:
					"Plugins installed from it keep running and become Unlisted. The official index cannot be removed.",
				middleware: [requireInstanceAdmin],
				request: { params: IdParam },
				responses: { 204: { description: "Removed" }, ...errors },
			}),
		),
		async (c) => {
			const row = await indexRow(c.var.deps.db, c.req.valid("param").id);
			c.set("auditResourceId", row.id);
			if (row.builtin)
				throw new Failure("conflict", "the official index cannot be removed");
			await c.var.deps.db.delete(pluginIndex).where(eq(pluginIndex.id, row.id));
			c.set("auditDiff", { url: row.url });
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"plugin.index_refresh",
			createRoute({
				method: "post",
				path: "/plugins/indexes/{id}/refresh",
				tags: ["plugins"],
				security,
				summary: "Fetch an index again",
				description:
					"Fetches and verifies the listing and every version of the plugins installed from it, and flags installs of yanked versions. Indexes are never fetched on a schedule.",
				middleware: [requirePermission("plugins", inOrganization)],
				request: { params: IdParam },
				responses: { 200: json(IndexView, "Refreshed"), ...errors },
			}),
		),
		async (c) => {
			const { db, config } = c.var.deps;
			await ensureOfficialIndex(db, config);
			const row = await indexRow(db, c.req.valid("param").id);
			c.set("auditResourceId", row.id);
			return c.json(indexView(await refreshIndex(db, row)), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins/marketplace",
			tags: ["plugins"],
			security,
			summary:
				"Plugins in every trusted index, with this organization's installs",
			description:
				"Served from each index's cache; an index whose cache is older than an hour is fetched first. A failed fetch keeps the cache and shows in `indexes[].lastError`.",
			middleware: [requirePermission("plugins", inOrganization)],
			responses: {
				200: json(
					z.object({
						policy: PluginPolicy,
						indexes: z.array(IndexView),
						entries: z.array(MarketEntry),
					}),
					"Marketplace",
				),
				...errors,
			},
		}),
		async (c) => {
			const { db, config } = c.var.deps;
			await ensureOfficialIndex(db, config);
			const order = [desc(pluginIndex.builtin), asc(pluginIndex.createdAt)];
			let rows = await db
				.select()
				.from(pluginIndex)
				.orderBy(...order);
			const stale = rows.filter(
				(r) =>
					!r.fetchedAt || Date.now() - r.fetchedAt.getTime() > INDEX_STALE_MS,
			);
			if (stale.length) {
				await Promise.all(
					stale.map((r) => refreshIndex(db, r).catch(() => {})),
				);
				rows = await db
					.select()
					.from(pluginIndex)
					.orderBy(...order);
			}
			const installs = await db
				.select({
					id: pluginInstall.id,
					pluginId: pluginInstall.pluginId,
					version: pluginInstall.version,
					indexId: pluginInstall.indexId,
				})
				.from(pluginInstall)
				.where(
					eq(pluginInstall.organizationId, requireActor(c).organizationId),
				);
			const server = normalizeVersion(config.LOGISTACK_VERSION);
			const entries = rows.flatMap((r) =>
				r.entries.map((e) => {
					const i = installs.find((x) => x.pluginId === e.id);
					return {
						indexId: r.id,
						indexName: r.name,
						id: e.id,
						name: e.name,
						description: e.description,
						author: e.author ?? null,
						iconUrl: e.iconUrl ?? null,
						verified: e.verified,
						latest: {
							version: e.latest.version,
							image: e.latest.image,
							changelog: e.latest.changelog ?? null,
							publishedAt: e.latest.publishedAt,
							yanked: e.latest.yanked,
							manifest: e.latest.manifest as Record<string, unknown>,
						},
						compatible: compatible(server, e.latest.manifest),
						installed: i
							? { installId: i.id, version: i.version, indexId: i.indexId }
							: null,
					};
				}),
			);
			return c.json(
				{ policy: await policy(c), indexes: rows.map(indexView), entries },
				200,
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
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/plugins/{id}/updates",
			tags: ["plugins"],
			security,
			summary: "Newer versions of a marketplace plugin",
			description:
				"From the index's cache (refresh the index to see new releases), newest first, yanked versions left out. Each carries its changelog and what it changes in permissions and declared egress.",
			middleware: [requirePermission("plugins", inOrganization)],
			request: { params: IdParam },
			responses: {
				200: json(
					z.object({
						current: z.string(),
						yanked: z.boolean(),
						previousVersion: z.string().nullable(),
						versions: z.array(UpdateView),
					}),
					"Updates",
				),
				...errors,
			},
		}),
		async (c) => {
			const row = await byInstall(c);
			const { db, config } = c.var.deps;
			const versions = row.indexId
				? await pluginVersions(
						db,
						await indexRow(db, row.indexId),
						row.pluginId,
					)
				: [];
			const server = normalizeVersion(config.LOGISTACK_VERSION);
			return c.json(
				{
					current: row.version,
					yanked: row.yanked,
					previousVersion: row.previousVersion,
					versions: versions
						.filter(
							(v) => !v.yanked && compareVersions(v.version, row.version) > 0,
						)
						.sort((a, b) => compareVersions(b.version, a.version))
						.map((v) => ({
							version: v.version,
							changelog: v.changelog ?? null,
							publishedAt: v.publishedAt,
							verified: v.verified,
							compatible: compatible(server, v.manifest),
							...manifestDiff(row.manifest, v.manifest),
							missingPermissions: missingPermissions(c, v.manifest),
						})),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"plugin.version_update",
			createRoute({
				method: "post",
				path: "/plugins/{id}/update",
				tags: ["plugins"],
				security,
				summary: "Update a marketplace plugin to another version",
				description:
					"Reads the version from the index cache, checks the registry serves the signed digest and manifest, then switches the container. Permissions the new version adds need `acceptPermissions: true`. The plugin gets a new API token; the current version is kept for rollback.",
				middleware: [requirePermission("plugins", inOrganization)],
				request: {
					params: IdParam,
					...body(
						z.object({
							version: z.string().max(64),
							acceptPermissions: z.boolean().default(false),
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
			if (!row.indexId)
				throw new Failure(
					"conflict",
					"only plugins installed from a marketplace index update here; reinstall it from the new image",
				);
			if (input.version === row.version)
				throw new Failure(
					"conflict",
					`${row.manifest.name} is already at ${row.version}`,
				);
			await assertPolicyAllows(c, { kind: "index" });
			const r = await resolveIndexVersion(
				c,
				await indexRow(c.var.deps.db, row.indexId),
				row.pluginId,
				input.version,
			);
			await assertCanSwitch(c, r);
			const diff = manifestDiff(row.manifest, r.manifest);
			if (diff.permissions.added.length && !input.acceptPermissions)
				throw new Failure(
					"conflict",
					`${input.version} also asks for ${diff.permissions.added.join(", ")}; accept the new permissions to update`,
					diff,
				);
			const stored = JSON.parse(
				await decrypt(c.var.deps.masterKey, row.configEncrypted),
			) as Record<string, unknown>;
			try {
				validateConfig(r.manifest.config, stored);
			} catch (e) {
				throw new Failure(
					"conflict",
					`the current settings do not fit ${input.version}'s form`,
					e instanceof Failure ? e.details : undefined,
				);
			}
			c.set("auditDiff", {
				before: { version: row.version, image: row.image },
				after: { version: r.manifest.version, image: r.image },
				...diff,
			});
			return c.json(await view(c, await switchVersion(c, row, r)), 200);
		},
	)
	.openapi(
		mutation(
			"plugin.rollback",
			createRoute({
				method: "post",
				path: "/plugins/{id}/rollback",
				tags: ["plugins"],
				security,
				summary: "Go back to the version before the last update",
				description:
					"Reinstalls the previous digest with its manifest and permissions, and a new API token. Rolling back again returns to the newer version.",
				middleware: [requirePermission("plugins", inOrganization)],
				request: { params: IdParam },
				responses: { 200: json(InstallView, "Rolled back"), ...errors },
			}),
		),
		async (c) => {
			const row = await byInstall(c);
			c.set("auditResourceId", row.id);
			const { db } = c.var.deps;
			const previous = row.previousManifest;
			if (!row.previousImage || !previous)
				throw new Failure(
					"conflict",
					"there is no previous version to go back to",
				);
			// The index's word on the old version; an unreachable index or a dropped version is not verified.
			const verified = row.indexId
				? await indexRow(db, row.indexId)
						.then((ix) => indexVersion(db, ix, row.pluginId, previous.version))
						.then((v) => v.verified)
						.catch(() => false)
				: false;
			const r: Resolved = {
				manifest: previous,
				image: row.previousImage,
				devUrl: null,
				registryId: null,
				indexId: row.indexId,
				verified,
			};
			await assertCanSwitch(c, r);
			c.set("auditDiff", {
				before: { version: row.version, image: row.image },
				after: { version: previous.version, image: r.image },
			});
			return c.json(await view(c, await switchVersion(c, row, r)), 200);
		},
	);
