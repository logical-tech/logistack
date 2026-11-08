import {
	GithubRelease,
	RELEASES_REPO,
	type ReleaseChannel,
} from "@logistack/contracts";
import { compareVersions, onChannel } from "@logistack/core";
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
 * Published releases on `channel` (see `onChannel`), newest first, from the most recent 100 on
 * GitHub. Drafts and tags that aren't versions are skipped. Unauthenticated: 60 requests an hour
 * per IP, so callers cache. Empty when nothing is released yet.
 */
export async function listReleases(
	deps: Deps = {},
	{
		channel = "stable",
		repo = RELEASES_REPO,
	}: { channel?: ReleaseChannel; repo?: string } = {},
): Promise<Release[]> {
	const http = new Http("github", deps);
	let raw: unknown;
	try {
		raw = await http.json(
			"releases",
			`https://api.github.com/repos/${repo}/releases?per_page=100`,
			{
				headers: {
					accept: "application/vnd.github+json",
					"user-agent": "logistack",
					"x-github-api-version": "2022-11-28",
				},
			},
		);
	} catch (err) {
		if (err instanceof ProviderError && err.status === 404) return [];
		throw err;
	}
	const list = z.array(GithubRelease).safeParse(raw);
	if (!list.success)
		throw new ProviderError("github", "releases", "unexpected response");
	return list.data
		.filter((r) => !r.draft && onChannel(r.tag_name, channel))
		.sort((a, b) => compareVersions(b.tag_name, a.tag_name))
		.map(view);
}

/** The newest release on `channel`, or null when nothing is released yet. */
export async function latestRelease(
	deps: Deps = {},
	opts: { channel?: ReleaseChannel; repo?: string } = {},
): Promise<Release | null> {
	return (await listReleases(deps, opts))[0] ?? null;
}
