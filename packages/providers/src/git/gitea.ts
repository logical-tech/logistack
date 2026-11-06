import { z } from "zod";
import { defineProvider, Http, secret } from "../http.ts";
import { normalizeGitHubStyle } from "./github-style.ts";
import {
	type CheckState,
	type GitProvider,
	type GitRepo,
	ownerRepoPath,
	repoFilePath,
	requireHmac,
	summarizeChecks,
	withCredentials,
} from "./types.ts";

/** Gitea and Forgejo (Forgejo keeps Gitea's API and webhook headers). */
export const giteaConfig = z.object({
	baseUrl: z.url(),
	/** Access token with read access to repositories. */
	token: secret(),
	webhookSecret: secret(),
});
export type GiteaConfig = z.infer<typeof giteaConfig>;

const PAGE = 50;

const statusState: Record<string, CheckState> = {
	success: "success",
	warning: "success",
	pending: "pending",
	failure: "failure",
	error: "failure",
};

export const gitea = defineProvider({
	configSchema: giteaConfig,
	create(config, deps): GitProvider {
		const http = new Http("gitea", deps);
		const base = config.baseUrl.replace(/\/+$/, "");
		const headers = { authorization: `token ${config.token}` };

		async function all<T>(op: string, path: string): Promise<T[]> {
			const out: T[] = [];
			for (let page = 1; ; page++) {
				const res = await http.json<T[]>(
					op,
					`${base}/api/v1${path}?limit=${PAGE}&page=${page}`,
					{ headers },
				);
				out.push(...res);
				if (res.length < PAGE) return out;
			}
		}

		return {
			async listRepos() {
				const repos = await all<{
					full_name: string;
					private: boolean;
					default_branch?: string;
				}>("listRepos", "/user/repos");
				return repos.map(
					(r): GitRepo => ({
						fullName: r.full_name,
						private: r.private,
						defaultBranch: r.default_branch,
					}),
				);
			},
			async listBranches(repo) {
				const branches = await all<{ name: string }>(
					"listBranches",
					`/repos/${ownerRepoPath("gitea", repo)}/branches`,
				);
				return branches.map((b) => b.name);
			},
			async getCloneUrl(repo) {
				return withCredentials(
					`${base}/${ownerRepoPath("gitea", repo)}.git`,
					"oauth2",
					config.token,
				);
			},
			async readFile(repo, ref, path) {
				const res = await http.request(
					"readFile",
					`${base}/api/v1/repos/${ownerRepoPath("gitea", repo)}/raw/${repoFilePath("gitea", path)}?ref=${encodeURIComponent(ref)}`,
					{ headers },
				);
				return res.text();
			},
			async commitChecks(repo, ref) {
				// The combined status keeps the latest status per context; Gitea Actions report here too.
				const combined = await http.json<{
					statuses: { context: string; status: string }[] | null;
				}>(
					"commitStatus",
					`${base}/api/v1/repos/${ownerRepoPath("gitea", repo)}/commits/${encodeURIComponent(ref)}/status?limit=${PAGE}`,
					{ headers },
				);
				return summarizeChecks(
					(combined.statuses ?? []).map((s) => ({
						name: s.context,
						state: statusState[s.status] ?? "pending",
					})),
				);
			},
			async verifyWebhook(headers, rawBody) {
				const header = headers.has("x-gitea-signature")
					? "x-gitea-signature"
					: "x-forgejo-signature";
				await requireHmac(
					"gitea",
					headers,
					header,
					"",
					config.webhookSecret,
					rawBody,
				);
				return normalizeGitHubStyle(
					headers.get("x-gitea-event") ?? headers.get("x-forgejo-event"),
					JSON.parse(rawBody),
				);
			},
		};
	},
});
