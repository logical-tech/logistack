import type { GitProviderKind } from "@logistack/contracts";
import { decrypt, encrypt } from "@logistack/core";
import { type Db, gitProvider, instanceSettings } from "@logistack/db";
import {
	type BitbucketConfig,
	type Deps,
	type GiteaConfig,
	type GitLabConfig,
	type GitProvider,
	gitProviders,
	Http,
	instantiate,
	ownerRepoPath,
} from "@logistack/providers";
import { and, eq } from "drizzle-orm";
import { Failure, notFound } from "../errors.ts";
import { guardedFetch, hostPolicy } from "../ssrf.ts";

export type ProviderRow = typeof gitProvider.$inferSelect;

/** The decrypted config document. GitHub rows carry the app credentials plus pending-flow fields. */
export type StoredConfig = Record<string, unknown>;

export async function loadProvider(
	db: Db,
	key: CryptoKey,
	id: string,
	organizationId?: string,
): Promise<{ row: ProviderRow; config: StoredConfig }> {
	const [row] = await db
		.select()
		.from(gitProvider)
		.where(
			organizationId
				? and(
						eq(gitProvider.id, id),
						eq(gitProvider.organizationId, organizationId),
					)
				: eq(gitProvider.id, id),
		);
	if (!row) throw notFound("git provider");
	return {
		row,
		config: JSON.parse(await decrypt(key, row.configEncrypted)),
	};
}

export const sealConfig = (key: CryptoKey, config: StoredConfig) =>
	encrypt(key, JSON.stringify(config));

export type ProviderState = "connected" | "pending";

/** A GitHub row is pending until the app exists and is installed somewhere. */
export const providerState = (
	kind: GitProviderKind,
	config: StoredConfig,
): ProviderState =>
	kind === "github" && !(config.appId && config.installationId)
		? "pending"
		: "connected";

export function client(
	kind: GitProviderKind,
	config: StoredConfig,
	deps?: Deps,
) {
	if (providerState(kind, config) === "pending")
		throw new Failure("conflict", "the GitHub App is not installed yet");
	return instantiate(gitProviders[kind], config, deps) as GitProvider;
}

/** GitLab and Gitea live wherever the user says: their calls go through the SSRF guard. */
async function guarded(db: Db, kind: GitProviderKind): Promise<Deps> {
	if (kind !== "gitlab" && kind !== "gitea") return {};
	const policy = await hostPolicy(db);
	return { fetch: (url, init = {}) => guardedFetch(url, init, policy) };
}

/** A provider client for API calls (repos, branches, tests). */
export async function connect(
	db: Db,
	kind: GitProviderKind,
	config: StoredConfig,
) {
	return client(kind, config, await guarded(db, kind));
}

export async function publicUrl(db: Db): Promise<string> {
	const [s] = await db
		.select({ publicUrl: instanceSettings.publicUrl })
		.from(instanceSettings);
	if (!s?.publicUrl)
		throw new Failure(
			"bad_request",
			"set the instance's public URL first: providers call back to it",
		);
	return s.publicUrl.replace(/\/+$/, "");
}

export const webhookUrl = (base: string, providerId: string) =>
	`${base}/api/webhooks/git/${providerId}`;

export type HookResult = {
	status: "registered" | "exists" | "not_needed" | "failed";
	message: string;
};

const BITBUCKET = "https://api.bitbucket.org/2.0";

/** Registers LogiStack's webhook on one repository unless one with the same URL is there. Idempotent. */
export async function ensureWebhook(
	db: Db,
	kind: GitProviderKind,
	config: StoredConfig,
	repo: string,
	url: string,
): Promise<HookResult> {
	if (kind === "github")
		return {
			status: "not_needed",
			message: "The GitHub App's webhook covers every installed repository.",
		};
	if (kind === "generic")
		return {
			status: "not_needed",
			message:
				"Generic SSH sources have no API: deploy by hand or call the deploy endpoint from CI.",
		};
	try {
		const http = new Http(kind, await guarded(db, kind));
		if (kind === "gitlab") {
			const c = config as GitLabConfig;
			const base = `${c.baseUrl.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(repo)}/hooks`;
			const headers = { "private-token": c.token };
			const hooks = await http.json<{ url: string }[]>("listHooks", base, {
				headers,
			});
			if (hooks.some((h) => h.url === url))
				return { status: "exists", message: "The webhook is already set up." };
			await http.postJson(
				"createHook",
				base,
				{
					url,
					token: c.webhookSecret,
					push_events: true,
					tag_push_events: true,
					releases_events: true,
					merge_requests_events: true,
					enable_ssl_verification: true,
				},
				headers,
			);
		} else if (kind === "gitea") {
			const c = config as GiteaConfig;
			const base = `${c.baseUrl.replace(/\/+$/, "")}/api/v1/repos/${ownerRepoPath("gitea", repo)}/hooks`;
			const headers = { authorization: `token ${c.token}` };
			const hooks = await http.json<{ config?: { url?: string } }[]>(
				"listHooks",
				base,
				{ headers },
			);
			if (hooks.some((h) => h.config?.url === url))
				return { status: "exists", message: "The webhook is already set up." };
			await http.postJson(
				"createHook",
				base,
				{
					type: "gitea",
					active: true,
					events: ["push", "pull_request", "release"],
					config: { url, content_type: "json", secret: c.webhookSecret },
				},
				headers,
			);
		} else {
			const c = config as BitbucketConfig;
			const base = `${BITBUCKET}/repositories/${ownerRepoPath("bitbucket", repo)}/hooks`;
			const headers = { authorization: `Bearer ${c.accessToken}` };
			const hooks = await http.json<{ values: { url: string }[] }>(
				"listHooks",
				base,
				{ headers },
			);
			if (hooks.values.some((h) => h.url === url))
				return { status: "exists", message: "The webhook is already set up." };
			await http.postJson(
				"createHook",
				base,
				{
					description: "LogiStack",
					url,
					active: true,
					secret: c.webhookSecret,
					events: [
						"repo:push",
						"pullrequest:created",
						"pullrequest:updated",
						"pullrequest:fulfilled",
					],
				},
				headers,
			);
		}
		return {
			status: "registered",
			message: "Pushes to this repository now reach LogiStack.",
		};
	} catch (e) {
		return {
			status: "failed",
			message: `Add the webhook by hand: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}
