import { z } from "zod";
import { defineProvider, Http, safeEqual, secret } from "../http.ts";
import {
	changedPaths,
	type GitEvent,
	type GitProvider,
	type GitRepo,
	type PrAction,
	WebhookRejectedError,
	withCredentials,
} from "./types.ts";

export const gitlabConfig = z.object({
	/** gitlab.com or a self-hosted instance root. */
	baseUrl: z.url().default("https://gitlab.com"),
	/** Personal, group or project access token with `read_api` and `read_repository`. */
	token: secret(),
	/** The webhook's secret token, sent back verbatim in `X-Gitlab-Token`. */
	webhookSecret: secret(),
});
export type GitLabConfig = z.infer<typeof gitlabConfig>;

const pushPayload = z.object({
	object_kind: z.literal("push"),
	ref: z.string(),
	after: z.string(),
	user_name: z.string().optional(),
	project: z.object({ path_with_namespace: z.string() }),
	total_commits_count: z.number().optional(),
	commits: z
		.array(
			z.object({
				id: z.string(),
				message: z.string(),
				author: z.object({ name: z.string() }).optional(),
				added: z.array(z.string()).optional(),
				modified: z.array(z.string()).optional(),
				removed: z.array(z.string()).optional(),
			}),
		)
		.default([]),
});

const mrPayload = z.object({
	object_kind: z.literal("merge_request"),
	user: z.object({ name: z.string() }).optional(),
	project: z.object({ path_with_namespace: z.string() }),
	object_attributes: z.object({
		iid: z.number(),
		action: z.string().optional(),
		title: z.string(),
		source_branch: z.string(),
		target_branch: z.string(),
		/** Present on `update` only when new commits were pushed. */
		oldrev: z.string().optional(),
		last_commit: z.object({ id: z.string(), message: z.string() }),
	}),
});

const mrActions: Record<string, PrAction> = {
	open: "opened",
	reopen: "reopened",
	close: "closed",
	merge: "closed",
};

const ZERO_SHA = /^0+$/;

function normalize(event: string | null, body: unknown): GitEvent | null {
	if (event === "Push Hook") {
		const p = pushPayload.parse(body);
		if (!p.ref.startsWith("refs/heads/") || ZERO_SHA.test(p.after)) return null;
		const head = p.commits.find((c) => c.id === p.after) ?? p.commits.at(-1);
		return {
			kind: "push",
			repo: p.project.path_with_namespace,
			branch: p.ref.slice("refs/heads/".length),
			commitSha: p.after,
			commitMessage: head?.message ?? "",
			author: head?.author?.name ?? p.user_name ?? "",
			// GitLab lists at most 20 commits; total_commits_count says whether it cut some.
			changedPaths: changedPaths(
				p.commits,
				(p.total_commits_count ?? p.commits.length) > p.commits.length,
			),
		};
	}
	if (event === "Merge Request Hook") {
		const p = mrPayload.parse(body);
		const a = p.object_attributes;
		const action =
			a.action === "update"
				? a.oldrev
					? "updated"
					: undefined
				: mrActions[a.action ?? ""];
		if (!action) return null;
		return {
			kind: "pull_request",
			repo: p.project.path_with_namespace,
			branch: a.target_branch,
			commitSha: a.last_commit.id,
			commitMessage: a.title,
			author: p.user?.name ?? "",
			pr: { number: a.iid, action, headBranch: a.source_branch },
		};
	}
	return null;
}

export const gitlab = defineProvider({
	configSchema: gitlabConfig,
	create(config, deps): GitProvider {
		const http = new Http("gitlab", deps);
		const base = config.baseUrl.replace(/\/+$/, "");

		async function all<T>(op: string, path: string): Promise<T[]> {
			const out: T[] = [];
			for (let page = "1"; page; ) {
				const res = await http.request(
					op,
					`${base}/api/v4${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
					{ headers: { "private-token": config.token } },
				);
				out.push(...((await res.json()) as T[]));
				page = res.headers.get("x-next-page") ?? "";
			}
			return out;
		}

		return {
			async listRepos() {
				const projects = await all<{
					path_with_namespace: string;
					visibility?: string;
					default_branch?: string | null;
				}>("listRepos", "/projects?membership=true&simple=true&archived=false");
				return projects.map(
					(p): GitRepo => ({
						fullName: p.path_with_namespace,
						private: p.visibility !== "public",
						defaultBranch: p.default_branch ?? undefined,
					}),
				);
			},
			async listBranches(repo) {
				const branches = await all<{ name: string }>(
					"listBranches",
					`/projects/${encodeURIComponent(repo)}/repository/branches`,
				);
				return branches.map((b) => b.name);
			},
			async getCloneUrl(repo) {
				const path = repo.split("/").map(encodeURIComponent).join("/");
				return withCredentials(`${base}/${path}.git`, "oauth2", config.token);
			},
			async verifyWebhook(headers, rawBody) {
				const token = headers.get("x-gitlab-token");
				if (!token)
					throw new WebhookRejectedError("gitlab", "missing_signature");
				if (!safeEqual(token, config.webhookSecret))
					throw new WebhookRejectedError("gitlab", "invalid_signature");
				return normalize(headers.get("x-gitlab-event"), JSON.parse(rawBody));
			},
		};
	},
});
