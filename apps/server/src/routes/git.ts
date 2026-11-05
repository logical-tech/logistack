import { createRoute, z } from "@hono/zod-openapi";
import {
	GitProviderKind,
	GitTrigger,
	type GitProviderKind as Kind,
} from "@logistack/contracts";
import { DEFAULT_GIT_TRIGGER, decrypt } from "@logistack/core";
import {
	gitProvider,
	serviceGitTrigger,
	serviceWatchPaths,
	sshKey,
} from "@logistack/db";
import {
	buildGitHubAppManifest,
	exchangeGitHubManifestCode,
	gitProviders,
	Http,
	importRsaPrivateKey,
	signGitHubAppJwt,
} from "@logistack/providers";
import { and, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import {
	connect,
	ensureWebhook,
	loadProvider,
	providerState,
	publicUrl,
	type StoredConfig,
	sealConfig,
	webhookUrl,
} from "../git/providers.ts";
import { lsRemoteSsh } from "../git/ssh.ts";
import {
	body,
	errors,
	IdParam,
	json,
	Name,
	router,
	security,
} from "../openapi.ts";
import { byParam, inOrganization, requirePermission } from "../scope.ts";
import { hostPolicy } from "../ssrf.ts";

const SourceCheck = z
	.object({
		ok: z.boolean(),
		message: z.string(),
		detail: z.string().optional(),
	})
	.openapi("GitCheck");

const GitProviderItem = z
	.object({
		id: z.string(),
		kind: GitProviderKind,
		name: z.string(),
		/** `pending`: a GitHub App not created or not installed yet. `error`: its API did not answer. */
		state: z.enum(["connected", "pending", "error"]),
		message: z.string().nullable(),
		repoCount: z.int().nullable(),
		webhookUrl: z.string().nullable(),
		/** GitHub: the app's page and where to install it. */
		appUrl: z.string().nullable(),
		installUrl: z.string().nullable(),
		createdAt: z.string(),
	})
	.openapi("GitProvider");

const Repo = z.object({
	fullName: z.string(),
	private: z.boolean(),
	defaultBranch: z.string().optional(),
});

/** What a person types to connect a token-based provider; LogiStack generates the webhook secret. */
const Connect = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("gitlab"),
		baseUrl: z.url().default("https://gitlab.com"),
		token: z.string().min(1),
	}),
	z.object({
		kind: z.literal("gitea"),
		baseUrl: z.url(),
		token: z.string().min(1),
	}),
	z.object({
		kind: z.literal("bitbucket"),
		workspace: z.string().regex(/^[\w.-]+$/),
		accessToken: z.string().min(1),
	}),
	z.object({
		kind: z.literal("generic"),
		repoUrl: z.string().min(1),
		sshKeyId: z.string().min(1),
		knownHosts: z.string().optional(),
	}),
]);
type Connect = z.infer<typeof Connect>;

const WatchPaths = z.object({
	paths: z.array(z.string().trim().min(1).max(200)).max(50),
});

const randomSecret = () =>
	crypto
		.getRandomValues(new Uint8Array(32))
		.toBase64({ alphabet: "base64url" });

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Parses the person's input with the provider's own schema, so a bad config never reaches the database. */
function providerConfig(input: Connect, webhookSecret: string): StoredConfig {
	const { kind, ...fields } = input;
	const config = {
		...fields,
		...(kind === "generic" ? {} : { webhookSecret }),
	};
	const parsed = gitProviders[kind].configSchema.safeParse(config);
	if (!parsed.success)
		throw new Failure(
			"validation_failed",
			"invalid provider settings",
			parsed.error.issues,
		);
	return parsed.data as StoredConfig;
}

async function sshPrivateKey(c: Context<Env>, id: string) {
	const rows = await c.var.deps.db
		.select()
		.from(sshKey)
		.where(
			and(
				eq(sshKey.id, id),
				eq(sshKey.organizationId, requireActor(c).organizationId),
			),
		);
	return decrypt(
		c.var.deps.masterKey,
		one(rows, "ssh key").privateKeyEncrypted,
	);
}

/** Lists repositories as the connection test; generic SSH runs `git ls-remote` with the deploy key. */
async function testConnection(
	c: Context<Env>,
	kind: Kind,
	config: StoredConfig,
	branch?: string,
): Promise<z.infer<typeof SourceCheck>> {
	if (kind === "generic") {
		const g = config as {
			repoUrl: string;
			sshKeyId: string;
			knownHosts?: string;
		};
		return lsRemoteSsh({
			url: g.repoUrl,
			privateKey: await sshPrivateKey(c, g.sshKeyId),
			policy: await hostPolicy(c.var.deps.db),
			...(branch ? { branch } : {}),
			...(g.knownHosts ? { knownHosts: g.knownHosts } : {}),
		});
	}
	try {
		const repos = await (
			await connect(c.var.deps.db, kind, config)
		).listRepos();
		return {
			ok: true,
			message: `Connected: ${repos.length} ${repos.length === 1 ? "repository" : "repositories"} visible`,
			...(repos.length === 0
				? { detail: "The token works but sees no repositories." }
				: {}),
		};
	} catch (e) {
		return {
			ok: false,
			message: "The provider rejected the request",
			detail: errorText(e),
		};
	}
}

const GITHUB_API = "https://api.github.com";
const githubHeaders = {
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
	"user-agent": "LogiStack",
};

/** Calls the GitHub API as the app itself (JWT), for installation lookups. */
async function asApp<T>(config: StoredConfig, op: string, path: string) {
	if (typeof config.appId !== "string" || typeof config.privateKey !== "string")
		throw new Failure("conflict", "the GitHub App has not been created yet");
	const jwt = await signGitHubAppJwt(
		config.appId,
		await importRsaPrivateKey(config.privateKey),
	);
	return new Http("github").json<T>(op, `${GITHUB_API}${path}`, {
		headers: { ...githubHeaders, authorization: `Bearer ${jwt}` },
	});
}

/** `<providerId>.<random>`: names the pending row and proves the redirect came from our own form. */
async function pendingGitHub(c: Context<Env>, state: string) {
	const [id, nonce] = state.split(".");
	if (!id || !nonce) throw new Failure("bad_request", "malformed state");
	const p = await loadProvider(
		c.var.deps.db,
		c.var.deps.masterKey,
		id,
		requireActor(c).organizationId,
	);
	if (p.row.kind !== "github" || p.config.state !== nonce)
		throw new Failure("forbidden", "this GitHub redirect is not ours");
	return p;
}

/** No state: the pending app whose own JWT can see the installation owns it. */
async function adoptInstallation(c: Context<Env>, installationId: string) {
	const { db, masterKey } = c.var.deps;
	const rows = await db
		.select()
		.from(gitProvider)
		.where(
			and(
				eq(gitProvider.organizationId, requireActor(c).organizationId),
				eq(gitProvider.kind, "github"),
			),
		);
	for (const row of rows) {
		const config: StoredConfig = JSON.parse(
			await decrypt(masterKey, row.configEncrypted),
		);
		if (providerState(row.kind, config) !== "pending") continue;
		try {
			await asApp(
				config,
				"installation",
				`/app/installations/${installationId}`,
			);
		} catch {
			continue;
		}
		await saveConfig(c, row.id, { ...config, installationId });
		c.set("auditResourceId", row.id);
		return wizard(row.id, "test");
	}
	return "/integrations/git";
}

const wizard = (providerId: string, step: string, error?: string) =>
	`/integrations/git/new?${new URLSearchParams({
		kind: "github",
		provider: providerId,
		step,
		...(error ? { error } : {}),
	})}`;

async function saveConfig(c: Context<Env>, id: string, config: StoredConfig) {
	await c.var.deps.db
		.update(gitProvider)
		.set({ configEncrypted: await sealConfig(c.var.deps.masterKey, config) })
		.where(eq(gitProvider.id, id));
}

export const git = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/git-providers",
			tags: ["git"],
			security,
			summary: "Connected Git providers with their state and repository count",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.array(GitProviderItem), "Providers"),
				...errors,
			},
		}),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const rows = await db
				.select()
				.from(gitProvider)
				.where(eq(gitProvider.organizationId, requireActor(c).organizationId))
				.orderBy(desc(gitProvider.createdAt));
			const base = await publicUrl(db).catch(() => null);
			const items = await Promise.all(
				rows.map(async (row) => {
					const config: StoredConfig = JSON.parse(
						await decrypt(masterKey, row.configEncrypted),
					);
					const state = providerState(row.kind, config);
					const htmlUrl =
						typeof config.htmlUrl === "string" ? config.htmlUrl : null;
					let repoCount: number | null = null;
					let message: string | null = null;
					let error = false;
					if (state === "connected" && row.kind !== "generic")
						try {
							repoCount = (
								await Promise.race([
									connect(db, row.kind, config).then((p) => p.listRepos()),
									Bun.sleep(8_000).then(() => {
										throw new Error("timed out after 8 s");
									}),
								])
							).length;
						} catch (e) {
							error = true;
							message = errorText(e);
						}
					if (row.kind === "generic") repoCount = 1;
					if (state === "pending")
						message = htmlUrl
							? "Install the app on an account to finish"
							: "The app was never created on GitHub";
					return {
						id: row.id,
						kind: row.kind,
						name: row.name,
						state: error ? ("error" as const) : state,
						message,
						repoCount,
						webhookUrl:
							base && row.kind !== "generic" ? webhookUrl(base, row.id) : null,
						appUrl: htmlUrl,
						// The state rides along so GitHub's setup redirect finds this provider again.
						installUrl: htmlUrl
							? `${htmlUrl}/installations/new${
									state === "pending" && typeof config.state === "string"
										? `?state=${encodeURIComponent(`${row.id}.${config.state}`)}`
										: ""
								}`
							: null,
						createdAt: row.createdAt.toISOString(),
					};
				}),
			);
			return c.json(items, 200);
		},
	)
	.openapi(
		mutation(
			"git_provider.test",
			createRoute({
				method: "post",
				path: "/git-providers/test",
				tags: ["git"],
				security,
				summary: "Test provider settings before saving them",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(Connect),
				responses: { 200: json(SourceCheck, "Result"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const config = providerConfig(input, "unused-during-test");
			return c.json(await testConnection(c, input.kind, config), 200);
		},
	)
	.openapi(
		mutation(
			"git_provider.create",
			createRoute({
				method: "post",
				path: "/git-providers",
				tags: ["git"],
				security,
				summary:
					"Connect GitLab, Gitea/Forgejo, Bitbucket or a generic SSH remote",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(z.object({ name: Name, provider: Connect })),
				responses: {
					201: json(z.object({ id: z.string() }), "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { name, provider } = c.req.valid("json");
			const config = providerConfig(provider, randomSecret());
			const row = one(
				await c.var.deps.db
					.insert(gitProvider)
					.values({
						organizationId: requireActor(c).organizationId,
						kind: provider.kind,
						name,
						configEncrypted: await sealConfig(c.var.deps.masterKey, config),
					})
					.returning({ id: gitProvider.id }),
			);
			c.set("auditResourceId", row.id);
			return c.json(row, 201);
		},
	)
	.openapi(
		mutation(
			"git_provider.github_manifest",
			createRoute({
				method: "post",
				path: "/git-providers/github/manifest",
				tags: ["git"],
				security,
				summary: "Start the GitHub App manifest flow",
				description:
					"Creates a pending provider and returns the manifest and the GitHub URL to POST it to (as the `manifest` form field). GitHub redirects back to the callback.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(
					z.object({
						name: z.string().trim().min(1).max(34),
						/** GitHub organization login; omit for a personal account. */
						organization: z
							.string()
							.regex(/^[a-z\d](?:[a-z\d-]{0,38})$/i)
							.optional(),
					}),
				),
				responses: {
					201: json(
						z.object({
							providerId: z.string(),
							action: z.string(),
							manifest: z.record(z.string(), z.unknown()),
						}),
						"Pending provider",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const base = await publicUrl(db);
			const nonce = randomSecret();
			const row = one(
				await db
					.insert(gitProvider)
					.values({
						organizationId: requireActor(c).organizationId,
						kind: "github",
						name: input.name,
						configEncrypted: await sealConfig(masterKey, { state: nonce }),
					})
					.returning({ id: gitProvider.id }),
			);
			c.set("auditResourceId", row.id);
			const state = `${row.id}.${nonce}`;
			const manifest = buildGitHubAppManifest({
				name: input.name,
				url: base,
				webhookUrl: webhookUrl(base, row.id),
				redirectUrl: `${base}/api/git-providers/github/callback`,
				setupUrl: `${base}/api/git-providers/github/setup`,
			});
			const owner = input.organization
				? `organizations/${encodeURIComponent(input.organization)}/`
				: "";
			return c.json(
				{
					providerId: row.id,
					action: `https://github.com/${owner}settings/apps/new?state=${encodeURIComponent(state)}`,
					manifest,
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"git_provider.github_callback",
			createRoute({
				method: "get",
				path: "/git-providers/github/callback",
				tags: ["git"],
				security,
				summary: "GitHub's redirect after the app is created",
				description:
					"Exchanges the one-time code for the app's id, private key and webhook secret, stores them encrypted, and sends the browser to the install step.",
				middleware: [requirePermission("admin", inOrganization)],
				request: {
					query: z.object({ code: z.string().min(1), state: z.string() }),
				},
				responses: { 302: { description: "Back to the wizard" }, ...errors },
			}),
		),
		async (c) => {
			const { code, state } = c.req.valid("query");
			const { row, config } = await pendingGitHub(c, state);
			c.set("auditResourceId", row.id);
			try {
				const app = await exchangeGitHubManifestCode(code);
				await saveConfig(c, row.id, { ...config, ...app });
				return c.redirect(wizard(row.id, "install"), 302);
			} catch (e) {
				return c.redirect(wizard(row.id, "create", errorText(e)), 302);
			}
		},
	)
	.openapi(
		mutation(
			"git_provider.github_setup",
			createRoute({
				method: "get",
				path: "/git-providers/github/setup",
				tags: ["git"],
				security,
				summary: "GitHub's redirect after the app is installed",
				middleware: [requirePermission("admin", inOrganization)],
				request: {
					query: z.object({
						installation_id: z.string().regex(/^\d+$/),
						// Missing when the app was installed from GitHub's own pages.
						state: z.string().optional(),
						setup_action: z.string().optional(),
					}),
				},
				responses: { 302: { description: "Back to the wizard" }, ...errors },
			}),
		),
		async (c) => {
			const { installation_id, state } = c.req.valid("query");
			if (!state)
				return c.redirect(await adoptInstallation(c, installation_id), 302);
			const { row, config } = await pendingGitHub(c, state);
			c.set("auditResourceId", row.id);
			try {
				// A forged installation id of some other app fails here: the app's own JWT can't see it.
				await asApp(
					config,
					"installation",
					`/app/installations/${installation_id}`,
				);
				await saveConfig(c, row.id, {
					...config,
					installationId: installation_id,
				});
				return c.redirect(wizard(row.id, "test"), 302);
			} catch (e) {
				return c.redirect(wizard(row.id, "install", errorText(e)), 302);
			}
		},
	)
	.openapi(
		mutation(
			"git_provider.github_installation",
			createRoute({
				method: "post",
				path: "/git-providers/{id}/github/installation",
				tags: ["git"],
				security,
				summary: "Pick up the app's newest installation",
				description:
					"For an app installed from GitHub's own pages, where the setup redirect carried no state.",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: {
					200: json(z.object({ installationId: z.string() }), "Installed"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { row, config } = await loadProvider(
				c.var.deps.db,
				c.var.deps.masterKey,
				c.req.valid("param").id,
				requireActor(c).organizationId,
			);
			if (row.kind !== "github")
				throw new Failure("bad_request", "not a GitHub provider");
			const installs = await asApp<{ id: number; created_at: string }[]>(
				config,
				"installations",
				"/app/installations?per_page=100",
			);
			const newest = installs.sort((a, b) =>
				b.created_at.localeCompare(a.created_at),
			)[0];
			if (!newest)
				throw new Failure("conflict", "the app is not installed anywhere yet");
			const installationId = String(newest.id);
			await saveConfig(c, row.id, { ...config, installationId });
			return c.json({ installationId }, 200);
		},
	)
	.openapi(
		mutation(
			"git_provider.test_saved",
			createRoute({
				method: "post",
				path: "/git-providers/{id}/test",
				tags: ["git"],
				security,
				summary: "Test a saved provider",
				middleware: [requirePermission("read", inOrganization)],
				request: { params: IdParam },
				responses: { 200: json(SourceCheck, "Result"), ...errors },
			}),
		),
		async (c) => {
			const { row, config } = await loadProvider(
				c.var.deps.db,
				c.var.deps.masterKey,
				c.req.valid("param").id,
				requireActor(c).organizationId,
			);
			if (providerState(row.kind, config) === "pending")
				return c.json(
					{
						ok: false,
						message: "The app isn't installed yet",
						detail: "Install it on an account, then test again.",
					},
					200,
				);
			return c.json(await testConnection(c, row.kind, config), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/git-providers/{id}/repos",
			tags: ["git"],
			security,
			middleware: [requirePermission("read", inOrganization)],
			request: { params: IdParam },
			responses: { 200: json(z.array(Repo), "Repositories"), ...errors },
		}),
		async (c) => {
			const { row, config } = await loadProvider(
				c.var.deps.db,
				c.var.deps.masterKey,
				c.req.valid("param").id,
				requireActor(c).organizationId,
			);
			const repos = await (
				await connect(c.var.deps.db, row.kind, config)
			).listRepos();
			return c.json(
				repos.sort((a, b) => a.fullName.localeCompare(b.fullName)),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/git-providers/{id}/branches",
			tags: ["git"],
			security,
			middleware: [requirePermission("read", inOrganization)],
			request: {
				params: IdParam,
				query: z.object({ repo: z.string().min(1) }),
			},
			responses: { 200: json(z.array(z.string()), "Branch names"), ...errors },
		}),
		async (c) => {
			const { row, config } = await loadProvider(
				c.var.deps.db,
				c.var.deps.masterKey,
				c.req.valid("param").id,
				requireActor(c).organizationId,
			);
			if (row.kind === "generic") return c.json([], 200);
			const branches = await (
				await connect(c.var.deps.db, row.kind, config)
			).listBranches(c.req.valid("query").repo);
			return c.json(branches, 200);
		},
	)
	.openapi(
		mutation(
			"git_provider.check_source",
			createRoute({
				method: "post",
				path: "/git-providers/{id}/check",
				tags: ["git"],
				security,
				summary:
					"Check a repository and branch are reachable with the provider's credentials",
				middleware: [requirePermission("read", inOrganization)],
				request: {
					params: IdParam,
					...body(
						z.object({
							repository: z.string().min(1),
							branch: z.string().min(1),
						}),
					),
				},
				responses: { 200: json(SourceCheck, "Result"), ...errors },
			}),
		),
		async (c) => {
			const { repository, branch } = c.req.valid("json");
			const { row, config } = await loadProvider(
				c.var.deps.db,
				c.var.deps.masterKey,
				c.req.valid("param").id,
				requireActor(c).organizationId,
			);
			if (row.kind === "generic")
				return c.json(await testConnection(c, row.kind, config, branch), 200);
			try {
				const branches = await (
					await connect(c.var.deps.db, row.kind, config)
				).listBranches(repository);
				return c.json(
					branches.includes(branch)
						? { ok: true, message: `Found ${repository}@${branch}` }
						: {
								ok: false,
								message: `Branch ${branch} not found`,
								detail: `${repository} has ${branches.slice(0, 5).join(", ") || "no branches"}${branches.length > 5 ? "…" : ""}.`,
							},
					200,
				);
			} catch (e) {
				return c.json(
					{
						ok: false,
						message: `Couldn't read ${repository}`,
						detail: errorText(e),
					},
					200,
				);
			}
		},
	)
	.openapi(
		mutation(
			"git_provider.webhook",
			createRoute({
				method: "post",
				path: "/git-providers/{id}/webhooks",
				tags: ["git"],
				security,
				summary:
					"Register LogiStack's push webhook on a repository (idempotent)",
				middleware: [requirePermission("write", inOrganization)],
				request: {
					params: IdParam,
					...body(z.object({ repository: z.string().min(1) })),
				},
				responses: {
					200: json(
						z.object({
							status: z.enum(["registered", "exists", "not_needed", "failed"]),
							message: z.string(),
						}),
						"Outcome",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const { row, config } = await loadProvider(
				db,
				masterKey,
				c.req.valid("param").id,
				requireActor(c).organizationId,
			);
			const url = webhookUrl(await publicUrl(db), row.id);
			return c.json(
				await ensureWebhook(
					db,
					row.kind,
					config,
					c.req.valid("json").repository,
					url,
				),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"git_provider.delete",
			createRoute({
				method: "delete",
				path: "/git-providers/{id}",
				tags: ["git"],
				security,
				summary: "Remove a provider",
				description:
					"Services that build from it keep their spec; their next deployment fails until another provider is chosen. The GitHub App itself stays on GitHub.",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const id = c.req.valid("param").id;
			c.set("auditResourceId", id);
			const rows = await c.var.deps.db
				.delete(gitProvider)
				.where(
					and(
						eq(gitProvider.id, id),
						eq(gitProvider.organizationId, requireActor(c).organizationId),
					),
				)
				.returning({ id: gitProvider.id });
			if (!rows.length) throw notFound("git provider");
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/watch-paths",
			tags: ["git"],
			security,
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(WatchPaths, "Watch paths"), ...errors },
		}),
		async (c) => {
			const [row] = await c.var.deps.db
				.select({ paths: serviceWatchPaths.paths })
				.from(serviceWatchPaths)
				.where(eq(serviceWatchPaths.serviceId, c.req.valid("param").id));
			return c.json({ paths: row?.paths ?? [] }, 200);
		},
	)
	.openapi(
		mutation(
			"service.watch_paths",
			createRoute({
				method: "put",
				path: "/services/{id}/watch-paths",
				tags: ["git"],
				security,
				summary: "Deploy on push only when these paths change",
				description:
					"Globs (`apps/web/**`) or directory prefixes (`apps/web`). An empty list deploys on every push.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(WatchPaths) },
				responses: { 200: json(WatchPaths, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const serviceId = c.req.valid("param").id;
			const paths = [
				...new Set(c.req.valid("json").paths.map((p) => p.replace(/^\/+/, ""))),
			].filter(Boolean);
			const { db } = c.var.deps;
			if (paths.length)
				await db
					.insert(serviceWatchPaths)
					.values({ serviceId, paths })
					.onConflictDoUpdate({
						target: serviceWatchPaths.serviceId,
						set: { paths },
					});
			else
				await db
					.delete(serviceWatchPaths)
					.where(eq(serviceWatchPaths.serviceId, serviceId));
			return c.json({ paths }, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/git-trigger",
			tags: ["git"],
			security,
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(GitTrigger, "Trigger rules"), ...errors },
		}),
		async (c) => {
			const [row] = await c.var.deps.db
				.select({
					on: serviceGitTrigger.on,
					tagPattern: serviceGitTrigger.tagPattern,
					waitForChecks: serviceGitTrigger.waitForChecks,
					checksTimeoutMinutes: serviceGitTrigger.checksTimeoutMinutes,
				})
				.from(serviceGitTrigger)
				.where(eq(serviceGitTrigger.serviceId, c.req.valid("param").id));
			return c.json(row ?? DEFAULT_GIT_TRIGGER, 200);
		},
	)
	.openapi(
		mutation(
			"service.git_trigger",
			createRoute({
				method: "put",
				path: "/services/{id}/git-trigger",
				tags: ["git"],
				security,
				summary: "Choose which git events deploy the service",
				description:
					"`branch` deploys pushes to the source branch (narrowed by watch paths), `tag` deploys tag pushes whose name matches `tagPattern` (a glob such as `v*.*.*`), `release` deploys published releases (GitHub, GitLab, Gitea/Forgejo) whose tag matches. Commits whose message contains `[skip ci]`, `[ci skip]` or `[skip deploy]` never deploy. With `waitForChecks` the deployment waits in `awaiting_checks` until the commit's CI checks pass, and is skipped when one fails or `checksTimeoutMinutes` passes.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(GitTrigger) },
				responses: { 200: json(GitTrigger, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const serviceId = c.req.valid("param").id;
			const rules = c.req.valid("json");
			await c.var.deps.db
				.insert(serviceGitTrigger)
				.values({ serviceId, ...rules })
				.onConflictDoUpdate({
					target: serviceGitTrigger.serviceId,
					set: rules,
				});
			return c.json(rules, 200);
		},
	);
