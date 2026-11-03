import { hmacSha256, ProviderError, safeEqual } from "../http.ts";

export type GitRepo = {
	/** `owner/name` (GitLab: the full namespace path). */
	fullName: string;
	private: boolean;
	defaultBranch?: string;
};

export type PrAction = "opened" | "updated" | "closed" | "reopened";

type Commit = {
	repo: string;
	/** Push: the pushed branch. Pull request: the base (target) branch. */
	branch: string;
	commitSha: string;
	commitMessage: string;
	author: string;
};

export type GitEvent =
	| (Commit & {
			kind: "push";
			/** Undefined when the provider does not list files or truncated the commit list: deploy as if anything changed. */
			changedPaths?: string[];
	  })
	| (Commit & {
			kind: "pull_request";
			pr: { number: number; action: PrAction; headBranch: string };
	  });

export interface GitProvider {
	listRepos(): Promise<GitRepo[]>;
	listBranches(repo: string): Promise<string[]>;
	/** HTTPS clone URL carrying a short-lived (or the configured) token. Never log it. */
	getCloneUrl(repo: string): Promise<string>;
	/**
	 * Authenticates and parses a webhook delivery. Throws WebhookRejectedError when the
	 * signature is missing or wrong; returns null for authentic events LogiStack ignores
	 * (ping, tag push, branch deletion, PR label edits).
	 */
	verifyWebhook(headers: Headers, rawBody: string): Promise<GitEvent | null>;
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
