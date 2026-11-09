import { z } from "zod";
import { defineProvider, Http, safeEqual, secret } from "../http.ts";
import {
	type CheckState,
	changedPaths,
	type GitEvent,
	type GitProvider,
	type GitRepo,
	type PrAction,
	refOf,
	repoFilePath,
	summarizeChecks,
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
	object_kind: z.enum(["push", "tag_push"]),
	ref: z.string(),
	after: z.string(),
	/** The commit a tag points at (`after` is the tag object for an annotated tag). */
	checkout_sha: z.string().nullish(),
	user_name: z.string().optional(),
	project: z.object({
		path_with_namespace: z.string(),
		default_branch: z.string().optional(),
	}),
	total_commits_count: z.number().optional(),
	commits: z
		.array(
			z.object({
				id: z.string(),
				message: z.string(),
				url: z.string().optional(),
				author: z.object({ name: z.string() }).optional(),
				added: z.array(z.string()).optional(),
				modified: z.array(z.string()).optional(),
				removed: z.array(z.string()).optional(),
			}),
		)
		.default([]),
});

const releasePayload = z.object({
	object_kind: z.literal("release"),
	action: z.string(),
	tag: z.string(),
	name: z.string().nullish(),
	project: z.object({ path_with_namespace: z.string() }),
	commit: z.object({
		id: z.string(),
		message: z.string(),
		author: z.object({ name: z.string() }).optional(),
	}),
});

const mrPayload = z.object({
	object_kind: z.literal("merge_request"),
	user: z.object({ name: z.string() }).optional(),
	project: z.object({
		path_with_namespace: z.string(),
		default_branch: z.string().optional(),
	}),
	object_attributes: z.object({
		iid: z.number(),
		action: z.string().optional(),
		title: z.string(),
		description: z.string().nullish(),
		/** opened, closed, merged, locked. */
		state: z.string().optional(),
		source_branch: z.string(),
		target_branch: z.string(),
		source_project_id: z.number().optional(),
		target_project_id: z.number().optional(),
		url: z.string().optional(),
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

// A manual job never runs on its own and a skipped one never will: neither holds a deployment back.
const jobState: Record<string, CheckState> = {
	success: "success",
	manual: "success",
	skipped: "success",
	failed: "failure",
	canceled: "failure",
};

function normalize(event: string | null, body: unknown): GitEvent | null {
	if (event === "Push Hook" || event === "Tag Push Hook") {
		const p = pushPayload.parse(body);
		const ref = refOf(p.ref);
		if (!ref || ZERO_SHA.test(p.after)) return null;
		const sha = p.checkout_sha ?? p.after;
		const head = p.commits.find((c) => c.id === sha) ?? p.commits.at(-1);
		return {
			kind: "push",
			repo: p.project.path_with_namespace,
			ref,
			commitSha: sha,
			commitMessage: head?.message ?? "",
			author: head?.author?.name ?? p.user_name ?? "",
			// GitLab lists at most 20 commits; total_commits_count says whether it cut some.
			changedPaths:
				ref.kind === "branch"
					? changedPaths(
							p.commits,
							(p.total_commits_count ?? p.commits.length) > p.commits.length,
						)
					: undefined,
			commits: p.commits.map((c) => ({
				sha: c.id,
				message: c.message,
				...(c.url && { url: c.url }),
				author: c.author?.name ?? "",
			})),
			...(p.project.default_branch && {
				defaultBranch: p.project.default_branch,
			}),
		};
	}
	if (event === "Release Hook") {
		const p = releasePayload.parse(body);
		if (p.action !== "create") return null;
		return {
			kind: "push",
			repo: p.project.path_with_namespace,
			ref: { kind: "release", name: p.tag },
			commitSha: p.commit.id,
			commitMessage: p.commit.message,
			author: p.commit.author?.name ?? "",
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
			pr: {
				number: a.iid,
				action,
				headBranch: a.source_branch,
				fromFork:
					a.source_project_id === undefined ||
					a.source_project_id !== a.target_project_id,
				...(a.url && { url: a.url }),
				...(a.description && { body: a.description }),
				merged: a.state === "merged" || a.action === "merge",
				state:
					a.state === "merged" || a.action === "merge"
						? "merged"
						: a.state === "closed" || a.action === "close"
							? "closed"
							: "open",
			},
			...(p.project.default_branch && {
				defaultBranch: p.project.default_branch,
			}),
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
			async readFile(repo, ref, path) {
				// GitLab takes the file path as one encoded segment.
				const file = encodeURIComponent(
					decodeURIComponent(repoFilePath("gitlab", path)),
				);
				const res = await http.request(
					"readFile",
					`${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/files/${file}/raw?ref=${encodeURIComponent(ref)}`,
					{ headers: { "private-token": config.token } },
				);
				return res.text();
			},
			async commitChecks(repo, ref) {
				const statuses = await all<{
					name: string;
					status: string;
					allow_failure?: boolean;
				}>(
					"commitStatuses",
					`/projects/${encodeURIComponent(repo)}/repository/commits/${encodeURIComponent(ref)}/statuses`,
				);
				return summarizeChecks(
					statuses.map((s) => {
						const state = jobState[s.status] ?? "pending";
						return {
							name: s.name,
							state: state === "failure" && s.allow_failure ? "success" : state,
						};
					}),
				);
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
