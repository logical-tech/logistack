import { z } from "zod";
import { changedPaths, type GitEvent, type PrAction } from "./types.ts";

// GitHub and Gitea/Forgejo share the push and pull_request payload shapes; these are the fields we read.
const pushPayload = z.object({
	ref: z.string(),
	after: z.string(),
	deleted: z.boolean().optional(),
	repository: z.object({ full_name: z.string() }),
	head_commit: z
		.object({
			id: z.string(),
			message: z.string(),
			author: z.object({ name: z.string() }).optional(),
		})
		.nullish(),
	pusher: z
		.object({
			name: z.string().optional(),
			login: z.string().optional(),
			username: z.string().optional(),
		})
		.optional(),
	commits: z
		.array(
			z.object({
				added: z.array(z.string()).optional(),
				modified: z.array(z.string()).optional(),
				removed: z.array(z.string()).optional(),
			}),
		)
		.default([]),
});

const prPayload = z.object({
	action: z.string(),
	number: z.number(),
	repository: z.object({ full_name: z.string() }),
	pull_request: z.object({
		title: z.string(),
		head: z.object({ ref: z.string(), sha: z.string() }),
		base: z.object({ ref: z.string() }),
		user: z.object({ login: z.string() }).nullish(),
	}),
});

const prActions: Record<string, PrAction> = {
	opened: "opened",
	synchronize: "updated", // GitHub
	synchronized: "updated", // Gitea, Forgejo
	closed: "closed",
	reopened: "reopened",
};

/** GitHub lists at most 20 commits per push, so a list that long may be truncated. */
const COMMIT_LIST_CAP = 20;
const ZERO_SHA = /^0+$/;

export function normalizeGitHubStyle(
	event: string | null,
	body: unknown,
): GitEvent | null {
	if (event === "push") {
		const p = pushPayload.parse(body);
		if (!p.ref.startsWith("refs/heads/")) return null;
		if (p.deleted || ZERO_SHA.test(p.after)) return null;
		return {
			kind: "push",
			repo: p.repository.full_name,
			branch: p.ref.slice("refs/heads/".length),
			commitSha: p.after,
			commitMessage: p.head_commit?.message ?? "",
			author:
				p.head_commit?.author?.name ??
				p.pusher?.name ??
				p.pusher?.login ??
				p.pusher?.username ??
				"",
			changedPaths: changedPaths(
				p.commits,
				p.commits.length >= COMMIT_LIST_CAP,
			),
		};
	}
	if (event === "pull_request") {
		const p = prPayload.parse(body);
		const action = prActions[p.action];
		if (!action) return null;
		return {
			kind: "pull_request",
			repo: p.repository.full_name,
			branch: p.pull_request.base.ref,
			commitSha: p.pull_request.head.sha,
			commitMessage: p.pull_request.title,
			author: p.pull_request.user?.login ?? "",
			pr: {
				number: p.number,
				action,
				headBranch: p.pull_request.head.ref,
			},
		};
	}
	return null;
}
