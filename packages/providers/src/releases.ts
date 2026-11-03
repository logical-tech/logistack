import { GithubRelease, RELEASES_REPO } from "@logistack/contracts";
import { type Deps, Http, ProviderError } from "./http.ts";

export type Release = {
	/** Without the tag's `v`. */
	version: string;
	name: string;
	/** Markdown, as written on the GitHub release. */
	notes: string;
	url: string;
	publishedAt: string | null;
};

/**
 * The newest published release (GitHub's `releases/latest` skips drafts and prereleases).
 * Unauthenticated: 60 requests an hour per IP, so callers cache. Null when nothing is released yet.
 */
export async function latestRelease(
	deps: Deps = {},
	repo = RELEASES_REPO,
): Promise<Release | null> {
	const http = new Http("github", deps);
	let raw: unknown;
	try {
		raw = await http.json(
			"latest release",
			`https://api.github.com/repos/${repo}/releases/latest`,
			{
				headers: {
					accept: "application/vnd.github+json",
					"user-agent": "logistack",
					"x-github-api-version": "2022-11-28",
				},
			},
		);
	} catch (err) {
		if (err instanceof ProviderError && err.status === 404) return null;
		throw err;
	}
	const r = GithubRelease.safeParse(raw);
	if (!r.success)
		throw new ProviderError("github", "latest release", "unexpected response");
	return {
		version: r.data.tag_name.replace(/^v(?=\d)/, ""),
		name: r.data.name || r.data.tag_name,
		notes: r.data.body ?? "",
		url: r.data.html_url,
		publishedAt: r.data.published_at,
	};
}
