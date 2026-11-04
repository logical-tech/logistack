import { GithubRelease, RELEASES_REPO } from "@logistack/contracts";
import { compareVersions, isReleaseVersion } from "@logistack/core";
import { z } from "zod";
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

const view = (r: GithubRelease): Release => ({
	version: r.tag_name.replace(/^v(?=\d)/, ""),
	name: r.name || r.tag_name,
	notes: r.body ?? "",
	url: r.html_url,
	publishedAt: r.published_at,
});

/**
 * The newest published release (GitHub's `releases/latest` skips drafts and prereleases). With
 * `beta`, the newest of the recent releases including prereleases, the builds of `staging`.
 * Unauthenticated: 60 requests an hour per IP, so callers cache. Null when nothing is released yet.
 */
export async function latestRelease(
	deps: Deps = {},
	{
		beta = false,
		repo = RELEASES_REPO,
	}: { beta?: boolean; repo?: string } = {},
): Promise<Release | null> {
	const http = new Http("github", deps);
	const base = `https://api.github.com/repos/${repo}/releases`;
	let raw: unknown;
	try {
		raw = await http.json(
			"latest release",
			beta ? `${base}?per_page=30` : `${base}/latest`,
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
	if (!beta) {
		const r = GithubRelease.safeParse(raw);
		if (!r.success)
			throw new ProviderError(
				"github",
				"latest release",
				"unexpected response",
			);
		return view(r.data);
	}
	const list = z.array(GithubRelease).safeParse(raw);
	if (!list.success)
		throw new ProviderError("github", "latest release", "unexpected response");
	const newest = list.data
		.filter((r) => !r.draft && isReleaseVersion(r.tag_name))
		.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
	return newest ? view(newest) : null;
}
