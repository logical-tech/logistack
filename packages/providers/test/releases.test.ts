import { expect, test } from "bun:test";
import { latestRelease, ProviderError } from "../src/index.ts";

const release = {
	tag_name: "v0.2.0",
	name: "v0.2.0",
	body: "## Features\n- feat(web): updates page",
	html_url: "https://github.com/logical-tech/logistack/releases/tag/v0.2.0",
	published_at: "2026-11-01T10:00:00Z",
	draft: false,
	prerelease: false,
	assets: [],
};

test("latestRelease reads the public releases/latest endpoint", async () => {
	const seen: string[] = [];
	const r = await latestRelease({
		fetch: async (url, init) => {
			seen.push(`${url} ${new Headers(init?.headers).get("user-agent")}`);
			return Response.json(release);
		},
	});
	expect(seen).toEqual([
		"https://api.github.com/repos/logical-tech/logistack/releases/latest logistack",
	]);
	expect(r).toEqual({
		version: "0.2.0",
		name: "v0.2.0",
		notes: release.body,
		url: release.html_url,
		publishedAt: release.published_at,
	});
});

test("no release yet is null, anything else unexpected throws", async () => {
	const answer = (res: Response) => ({ fetch: async () => res });
	expect(
		await latestRelease(answer(new Response("{}", { status: 404 }))),
	).toBeNull();
	await expect(
		latestRelease(answer(new Response("rate limited", { status: 403 }))),
	).rejects.toBeInstanceOf(ProviderError);
	await expect(
		latestRelease(answer(Response.json({ tag_name: 1 }))),
	).rejects.toThrow("unexpected response");
});
