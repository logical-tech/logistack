import { z } from "zod";
import { changedPaths, type GitEvent, type PrAction, refOf } from "./types.ts";

// GitHub and Gitea/Forgejo share the push and pull_request payload shapes; these are the fields we read.
const pushPayload = z.object({
	ref: z.string(),
	after: z.string(),
	deleted: z.boolean().optional(),
	repository: z.object({
		full_name: z.string(),
		default_branch: z.string().optional(),
	}),
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
				id: z.string().optional(),
				message: z.string().optional(),
				url: z.string().optional(),
				author: z
					.object({
						name: z.string().optional(),
						username: z.string().optional(),
					})
					.optional(),
				added: z.array(z.string()).optional(),
				modified: z.array(z.string()).optional(),
				removed: z.array(z.string()).optional(),
			}),
		)
		.default([]),
});

const releasePayload = z.object({
	action: z.string(),
	repository: z.object({ full_name: z.string() }),
	release: z.object({
		tag_name: z.string(),
		name: z.string().nullish(),
		author: z.object({ login: z.string() }).nullish(),
	}),
	sender: z.object({ login: z.string() }).nullish(),
});

const prPayload = z.object({
	action: z.string(),
	number: z.number(),
	repository: z.object({
		full_name: z.string(),
		default_branch: z.string().optional(),
	}),
	pull_request: z.object({
		title: z.string(),
		html_url: z.string().optional(),
		body: z.string().nullish(),
		state: z.string().optional(),
		merged: z.boolean().nullish(),
		// `head.repo` is null once a fork is deleted.
		head: z.object({
			ref: z.string(),
			sha: z.string(),
			repo: z.object({ full_name: z.string() }).nullish(),
		}),
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
		const ref = refOf(p.ref);
		if (!ref || p.deleted || ZERO_SHA.test(p.after)) return null;
		return {
			kind: "push",
			repo: p.repository.full_name,
			ref,
			// An annotated tag's `after` is the tag object; head_commit is the commit it points at.
			commitSha: p.head_commit?.id ?? p.after,
			commitMessage: p.head_commit?.message ?? "",
			author:
				p.head_commit?.author?.name ??
				p.pusher?.name ??
				p.pusher?.login ??
				p.pusher?.username ??
				"",
			changedPaths:
				ref.kind === "branch"
					? changedPaths(p.commits, p.commits.length >= COMMIT_LIST_CAP)
					: undefined,
			commits: p.commits.flatMap((c) =>
				c.id
					? [
							{
								sha: c.id,
								message: c.message ?? "",
								...(c.url && { url: c.url }),
								author: c.author?.name ?? c.author?.username ?? "",
							},
						]
					: [],
			),
			...(p.repository.default_branch && {
				defaultBranch: p.repository.default_branch,
			}),
		};
	}
	if (event === "release") {
		const p = releasePayload.parse(body);
		if (p.action !== "published") return null;
		return {
			kind: "push",
			repo: p.repository.full_name,
			ref: { kind: "release", name: p.release.tag_name },
			commitMessage: p.release.name || p.release.tag_name,
			author: p.release.author?.login ?? p.sender?.login ?? "",
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
				fromFork:
					p.pull_request.head.repo?.full_name.toLowerCase() !==
					p.repository.full_name.toLowerCase(),
				...(p.pull_request.html_url && { url: p.pull_request.html_url }),
				...(p.pull_request.body && { body: p.pull_request.body }),
				merged: p.pull_request.merged === true,
				state:
					p.pull_request.merged === true
						? "merged"
						: p.pull_request.state === "closed"
							? "closed"
							: "open",
			},
			...(p.repository.default_branch && {
				defaultBranch: p.repository.default_branch,
			}),
		};
	}
	return null;
}
