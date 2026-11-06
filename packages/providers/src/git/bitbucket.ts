import { z } from "zod";
import { defineProvider, Http, secret } from "../http.ts";
import {
	type CheckState,
	type GitEvent,
	type GitProvider,
	type GitRepo,
	ownerRepoPath,
	type PrAction,
	repoFilePath,
	requireHmac,
	summarizeChecks,
	WebhookRejectedError,
	withCredentials,
} from "./types.ts";

const API = "https://api.bitbucket.org/2.0";

/** Bitbucket Cloud with a workspace or repository access token. */
export const bitbucketConfig = z.object({
	workspace: z.string().regex(/^[\w.-]+$/),
	accessToken: secret(),
	/** Without a secret Bitbucket sends unsigned webhooks, which are always rejected. */
	webhookSecret: secret().optional(),
});
export type BitbucketConfig = z.infer<typeof bitbucketConfig>;

const commit = z.object({
	hash: z.string(),
	message: z.string().optional(),
	author: z
		.object({
			raw: z.string().optional(),
			user: z.object({ display_name: z.string() }).optional(),
		})
		.optional(),
});

const pushPayload = z.object({
	repository: z.object({ full_name: z.string() }),
	actor: z.object({ display_name: z.string() }).optional(),
	push: z.object({
		changes: z.array(
			z.object({
				new: z
					.object({ type: z.string(), name: z.string(), target: commit })
					.nullable(),
			}),
		),
	}),
});

const prPayload = z.object({
	repository: z.object({ full_name: z.string() }),
	pullrequest: z.object({
		id: z.number(),
		title: z.string(),
		author: z.object({ display_name: z.string() }).optional(),
		source: z.object({
			branch: z.object({ name: z.string() }),
			// Bitbucket sends the 12-character short hash here.
			commit: z.object({ hash: z.string() }),
		}),
		destination: z.object({ branch: z.object({ name: z.string() }) }),
	}),
});

const statusState: Record<string, CheckState> = {
	SUCCESSFUL: "success",
	INPROGRESS: "pending",
	FAILED: "failure",
	STOPPED: "failure",
};

const prActions: Record<string, PrAction> = {
	"pullrequest:created": "opened",
	"pullrequest:updated": "updated",
	"pullrequest:fulfilled": "closed",
	"pullrequest:rejected": "closed",
};

function normalize(event: string | null, body: unknown): GitEvent | null {
	if (event === "repo:push") {
		const p = pushPayload.parse(body);
		// shortcut: a push touching several refs reports only the first, enough for one-ref deploy rules.
		const change = p.push.changes.find(
			(c) => c.new?.type === "branch" || c.new?.type === "tag",
		)?.new;
		if (!change) return null;
		return {
			kind: "push",
			repo: p.repository.full_name,
			ref: {
				kind: change.type === "tag" ? "tag" : "branch",
				name: change.name,
			},
			commitSha: change.target.hash,
			commitMessage: change.target.message ?? "",
			author:
				change.target.author?.user?.display_name ??
				change.target.author?.raw ??
				p.actor?.display_name ??
				"",
			// Push payloads list no files.
			changedPaths: undefined,
		};
	}
	const action = event ? prActions[event] : undefined;
	if (action) {
		const { repository, pullrequest: pr } = prPayload.parse(body);
		return {
			kind: "pull_request",
			repo: repository.full_name,
			branch: pr.destination.branch.name,
			commitSha: pr.source.commit.hash,
			commitMessage: pr.title,
			author: pr.author?.display_name ?? "",
			pr: { number: pr.id, action, headBranch: pr.source.branch.name },
		};
	}
	return null;
}

export const bitbucket = defineProvider({
	configSchema: bitbucketConfig,
	create(config, deps): GitProvider {
		const http = new Http("bitbucket", deps);
		const headers = { authorization: `Bearer ${config.accessToken}` };

		async function all<T>(op: string, url: string): Promise<T[]> {
			const out: T[] = [];
			for (let next: string | undefined = url; next; ) {
				const res: { values: T[]; next?: string } = await http.json(op, next, {
					headers,
				});
				out.push(...res.values);
				// Only follow pagination links that stay on the API host.
				next = res.next?.startsWith(`${API}/`) ? res.next : undefined;
			}
			return out;
		}

		return {
			async listRepos() {
				const repos = await all<{
					full_name: string;
					is_private: boolean;
					mainbranch?: { name: string } | null;
				}>(
					"listRepos",
					`${API}/repositories/${encodeURIComponent(config.workspace)}?pagelen=100`,
				);
				return repos.map(
					(r): GitRepo => ({
						fullName: r.full_name,
						private: r.is_private,
						defaultBranch: r.mainbranch?.name,
					}),
				);
			},
			async listBranches(repo) {
				const refs = await all<{ name: string }>(
					"listBranches",
					`${API}/repositories/${ownerRepoPath("bitbucket", repo)}/refs/branches?pagelen=100`,
				);
				return refs.map((r) => r.name);
			},
			async getCloneUrl(repo) {
				return withCredentials(
					`https://bitbucket.org/${ownerRepoPath("bitbucket", repo)}.git`,
					"x-token-auth",
					config.accessToken,
				);
			},
			async readFile(repo, ref, path) {
				const res = await http.request(
					"readFile",
					`${API}/repositories/${ownerRepoPath("bitbucket", repo)}/src/${encodeURIComponent(ref)}/${repoFilePath("bitbucket", path)}`,
					{ headers },
				);
				return res.text();
			},
			async commitChecks(repo, ref) {
				const statuses = await all<{
					key: string;
					name?: string;
					state: string;
				}>(
					"commitStatuses",
					`${API}/repositories/${ownerRepoPath("bitbucket", repo)}/commit/${encodeURIComponent(ref)}/statuses?pagelen=100`,
				);
				return summarizeChecks(
					statuses.map((s) => ({
						name: s.name || s.key,
						state: statusState[s.state] ?? "pending",
					})),
				);
			},
			async verifyWebhook(headers, rawBody) {
				if (!config.webhookSecret)
					throw new WebhookRejectedError("bitbucket", "not_configured");
				await requireHmac(
					"bitbucket",
					headers,
					"x-hub-signature",
					"sha256=",
					config.webhookSecret,
					rawBody,
				);
				return normalize(headers.get("x-event-key"), JSON.parse(rawBody));
			},
		};
	},
});
