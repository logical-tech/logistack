import type { GitRefKind } from "@logistack/contracts";
import { hmacSha256, ProviderError, safeEqual } from "../http.ts";

export type GitRepo = {
	/** `owner/name` (GitLab: the full namespace path). */
	fullName: string;
	private: boolean;
	defaultBranch?: string;
};

export type PrAction = "opened" | "updated" | "closed" | "reopened";

/**
 * A branch push, a tag push or a published release, normalised from any provider. Releases come
 * from GitHub, Gitea/Forgejo and GitLab; Bitbucket has no releases.
 */
export type PushEvent = {
	kind: "push";
	repo: string;
	ref: { kind: GitRefKind; name: string };
	/** The head commit. Undefined for a GitHub or Gitea release, whose payload names only the tag. */
	commitSha?: string;
	commitMessage: string;
	author: string;
	/** Branch pushes only. Undefined when the provider does not list files or truncated the commit list: deploy as if anything changed. */
	changedPaths?: string[];
};

export type PullRequestEvent = {
	kind: "pull_request";
	repo: string;
	/** The base (target) branch. */
	branch: string;
	commitSha: string;
	commitMessage: string;
	author: string;
	pr: {
		number: number;
		action: PrAction;
		headBranch: string;
		/** The head lives in another repository. True when the provider cannot tell: a fork is the unsafe case. */
		fromFork: boolean;
		/** The pull request's web page. */
		url?: string;
	};
};

export type GitEvent = PushEvent | PullRequestEvent;

export type CheckState = "pending" | "success" | "failure";

/** The context LogiStack reports its own deployments under; never counted as one of the commit's checks. */
export const LOGISTACK_CHECK = "LogiStack";

export type ChecksSummary = {
	/** `none`: the provider knows no check for the commit (yet). */
	state: CheckState | "none";
	failed: string[];
	pending: string[];
};

/** Pure: any failed check fails the commit; otherwise any pending one keeps it pending. */
export function summarizeChecks(
	checks: readonly { name: string; state: CheckState }[],
): ChecksSummary {
	const counted = checks.filter((c) => c.name !== LOGISTACK_CHECK);
	const named = (state: CheckState) =>
		counted.filter((c) => c.state === state).map((c) => c.name);
	const failed = named("failure");
	const pending = named("pending");
	return {
		state: failed.length
			? "failure"
			: pending.length
				? "pending"
				: counted.length
					? "success"
					: "none",
		failed,
		pending,
	};
}

export interface GitProvider {
	listRepos(): Promise<GitRepo[]>;
	listBranches(repo: string): Promise<string[]>;
	/** HTTPS clone URL carrying a short-lived (or the configured) token. Never log it. */
	getCloneUrl(repo: string): Promise<string>;
	/**
	 * Authenticates and parses a webhook delivery. Throws WebhookRejectedError when the
	 * signature is missing or wrong; returns null for authentic events LogiStack ignores
	 * (ping, branch or tag deletion, PR label edits, unpublished releases).
	 */
	verifyWebhook(headers: Headers, rawBody: string): Promise<GitEvent | null>;
	/** CI checks and commit statuses on `ref` (a commit SHA, or a tag name for a release). */
	commitChecks(repo: string, ref: string): Promise<ChecksSummary>;
	/** A file's text at `ref` (branch, tag or SHA); `path` is relative to the repository root. */
	readFile(repo: string, ref: string, path: string): Promise<string>;
	/**
	 * Edits comment `commentId` on pull request `number`, or posts a new one when there is none (or it
	 * was deleted); returns the comment's id. GitHub only so far.
	 */
	commentOnPullRequest?(
		repo: string,
		number: number,
		body: string,
		commentId?: string,
	): Promise<string>;
}

export type WebhookRejection =
	| "missing_signature"
	| "invalid_signature"
	| "not_configured";

export class WebhookRejectedError extends Error {
	constructor(
		readonly provider: string,
		readonly reason: WebhookRejection,
	) {
		super(`${provider} webhook rejected: ${reason}`);
		this.name = "WebhookRejectedError";
	}
}

/** Checks `<prefix><hex HMAC-SHA256(secret, body)>` in `header` in constant time. */
export async function requireHmac(
	provider: string,
	headers: Headers,
	header: string,
	prefix: string,
	secret: string,
	rawBody: string,
): Promise<void> {
	const got = headers.get(header);
	if (!got) throw new WebhookRejectedError(provider, "missing_signature");
	const want = `${prefix}${(await hmacSha256(secret, rawBody)).toHex()}`;
	if (!safeEqual(got.toLowerCase(), want))
		throw new WebhookRejectedError(provider, "invalid_signature");
}

const REF_PREFIXES: [string, GitRefKind][] = [
	["refs/heads/", "branch"],
	["refs/tags/", "tag"],
];

/** A `refs/heads/*` or `refs/tags/*` ref; anything else (notes, pull refs) is not deployable. */
export function refOf(
	ref: string,
): { kind: GitRefKind; name: string } | undefined {
	for (const [prefix, kind] of REF_PREFIXES)
		if (ref.startsWith(prefix)) return { kind, name: ref.slice(prefix.length) };
	return undefined;
}

/** Sorted union of added/modified/removed, or undefined when the list may be truncated. */
export function changedPaths(
	commits: { added?: string[]; modified?: string[]; removed?: string[] }[],
	truncated: boolean,
): string[] | undefined {
	if (truncated) return undefined;
	const paths = new Set<string>();
	for (const c of commits)
		for (const p of [
			...(c.added ?? []),
			...(c.modified ?? []),
			...(c.removed ?? []),
		])
			paths.add(p);
	return [...paths].sort();
}

/** Validates `owner/name` and returns it path-encoded, so a repo string cannot escape its API path. */
export function ownerRepoPath(provider: string, repo: string): string {
	const parts = repo.split("/");
	if (
		parts.length !== 2 ||
		!parts.every((p) => /^[\w.-]+$/.test(p) && p !== "." && p !== "..")
	)
		throw new ProviderError(
			provider,
			"repo",
			`not an owner/name repo: ${JSON.stringify(repo)}`,
		);
	return parts.map(encodeURIComponent).join("/");
}

/** Validates a repository-relative file path and returns it with each segment encoded. */
export function repoFilePath(provider: string, path: string): string {
	const parts = path.replace(/^\.?\/+/, "").split("/");
	if (!parts.every((p) => p && p !== "." && p !== ".." && !p.includes("\0")))
		throw new ProviderError(
			provider,
			"readFile",
			`not a path inside the repository: ${JSON.stringify(path)}`,
		);
	return parts.map(encodeURIComponent).join("/");
}

/** Puts a token into an HTTPS clone URL as basic-auth credentials (the URL setters percent-encode). */
export function withCredentials(
	cloneUrl: string,
	username: string,
	token: string,
): string {
	const u = new URL(cloneUrl);
	u.username = username;
	u.password = token;
	return u.toString();
}
