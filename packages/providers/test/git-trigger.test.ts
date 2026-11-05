import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { GitTrigger } from "@logistack/contracts";
import {
	DEFAULT_GIT_TRIGGER,
	evaluateTrigger,
	type TriggerDecision,
} from "@logistack/core";
import {
	type GitProvider,
	gitProviders,
	instantiate,
	type PushEvent,
	summarizeChecks,
} from "../src/index.ts";
import * as fx from "./fixtures/git.ts";
import { mockFetch } from "./helpers.ts";

const SECRET = "whsec_0123456789";
const hmac = (raw: string) =>
	createHmac("sha256", SECRET).update(raw).digest("hex");

type Kind = "github" | "gitlab" | "gitea" | "bitbucket";

const configs: Record<Kind, unknown> = {
	github: {
		appId: "1",
		privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
		webhookSecret: SECRET,
		installationId: "2",
	},
	gitlab: { token: "glpat-x", webhookSecret: SECRET },
	gitea: {
		baseUrl: "https://git.example.com",
		token: "t",
		webhookSecret: SECRET,
	},
	bitbucket: { workspace: "team", accessToken: "t", webhookSecret: SECRET },
};

const provider = (kind: Kind, fetch = mockFetch()) =>
	instantiate(gitProviders[kind], configs[kind], fetch) as GitProvider;

/** Signs `body` the way `kind` does and runs it through that provider's webhook boundary. */
async function deliver(kind: Kind, event: string, body: unknown) {
	const raw = JSON.stringify(body);
	const headers: Record<Kind, Record<string, string>> = {
		github: {
			"x-github-event": event,
			"x-hub-signature-256": `sha256=${hmac(raw)}`,
		},
		gitlab: { "x-gitlab-event": event, "x-gitlab-token": SECRET },
		gitea: { "x-gitea-event": event, "x-gitea-signature": hmac(raw) },
		bitbucket: {
			"x-event-key": event,
			"x-hub-signature": `sha256=${hmac(raw)}`,
		},
	};
	return provider(kind).verifyWebhook(new Headers(headers[kind]), raw);
}

type Case = {
	name: string;
	provider: Kind;
	event: string;
	body: unknown;
	rules: Partial<GitTrigger> & { branch?: string; watchPaths?: string[] };
	normalised: Partial<PushEvent>;
	decision: TriggerDecision;
};

const withMessage = <T extends { head_commit: object }>(
	p: T,
	message: string,
) => ({
	...p,
	head_commit: { ...p.head_commit, message },
});

const cases: Case[] = [
	{
		name: "branch push touching a watched path deploys",
		provider: "github",
		event: "push",
		body: fx.githubPush,
		rules: { branch: "main", watchPaths: ["apps/web"] },
		normalised: { ref: { kind: "branch", name: "main" } },
		decision: { action: "deploy", waitForChecks: false },
	},
	{
		name: "branch push outside the watch paths is skipped",
		provider: "github",
		event: "push",
		body: fx.githubPush,
		rules: { branch: "main", watchPaths: ["apps/api/**"] },
		normalised: {},
		decision: { action: "skip", reason: "No watched path changed" },
	},
	{
		name: "[skip ci] in the head commit skips",
		provider: "github",
		event: "push",
		body: withMessage(fx.githubPush, "docs: typo\n\n[SKIP CI]"),
		rules: { branch: "main" },
		normalised: {},
		decision: { action: "skip", reason: "Commit message contains [skip ci]" },
	},
	{
		name: "a push to another branch is not this service's business",
		provider: "github",
		event: "push",
		body: fx.githubPush,
		rules: { branch: "develop" },
		normalised: {},
		decision: { action: "ignore", reason: "Tracks develop, not main" },
	},
	{
		name: "tag push matching the pattern deploys after checks",
		provider: "github",
		event: "push",
		body: fx.githubTagPush,
		rules: { on: "tag", tagPattern: "v*.*.*", waitForChecks: true },
		normalised: {
			ref: { kind: "tag", name: "v1.4.0" },
			commitSha: "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c",
			changedPaths: undefined,
		},
		decision: { action: "deploy", waitForChecks: true },
	},
	{
		name: "tag push to a branch-push service is ignored",
		provider: "github",
		event: "push",
		body: fx.githubTagPush,
		rules: { branch: "main" },
		normalised: {},
		decision: {
			action: "ignore",
			reason: "Deploys on branch events, not tag events",
		},
	},
	{
		name: "published release deploys; the payload names no commit",
		provider: "github",
		event: "release",
		body: fx.githubRelease,
		rules: { on: "release", tagPattern: "v*" },
		normalised: {
			ref: { kind: "release", name: "v1.4.0" },
			commitSha: undefined,
			commitMessage: "1.4.0",
		},
		decision: { action: "deploy", waitForChecks: false },
	},
	{
		name: "branch push with watch paths deploys",
		provider: "gitlab",
		event: "Push Hook",
		body: fx.gitlabPush,
		rules: { branch: "master", watchPaths: ["app"] },
		normalised: { ref: { kind: "branch", name: "master" } },
		decision: { action: "deploy", waitForChecks: false },
	},
	{
		name: "tag push resolves the tagged commit",
		provider: "gitlab",
		event: "Tag Push Hook",
		body: fx.gitlabTagPush,
		rules: { on: "tag", tagPattern: "v*.*.*", watchPaths: ["never/matches"] },
		normalised: {
			ref: { kind: "tag", name: "v1.0.0" },
			commitSha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
		},
		decision: { action: "deploy", waitForChecks: false },
	},
	{
		name: "release whose commit says [skip deploy] is skipped",
		provider: "gitlab",
		event: "Release Hook",
		body: fx.gitlabRelease,
		rules: { on: "release", tagPattern: "v*" },
		normalised: {
			ref: { kind: "release", name: "v1.1" },
			commitSha: "ee0f8b1c6f9a6d7b4ab2bfd5a9ee6a4a7a1b1e36",
		},
		decision: {
			action: "skip",
			reason: "Commit message contains [skip deploy]",
		},
	},
	{
		name: "branch push deploys",
		provider: "gitea",
		event: "push",
		body: fx.giteaPush,
		rules: { branch: "develop", watchPaths: ["services/web"] },
		normalised: { ref: { kind: "branch", name: "develop" } },
		decision: { action: "deploy", waitForChecks: false },
	},
	{
		name: "tag push deploys",
		provider: "gitea",
		event: "push",
		body: fx.giteaTagPush,
		rules: { on: "tag", tagPattern: "v*.*.*" },
		normalised: { ref: { kind: "tag", name: "v2.0.0" } },
		decision: { action: "deploy", waitForChecks: false },
	},
	{
		name: "a release outside the tag pattern is skipped",
		provider: "gitea",
		event: "release",
		body: fx.giteaRelease,
		rules: { on: "release", tagPattern: "v[0-9].[0-9].[0-9]" },
		normalised: { ref: { kind: "release", name: "v2.0.0-rc.1" } },
		decision: {
			action: "skip",
			reason: "Tag v2.0.0-rc.1 does not match v[0-9].[0-9].[0-9]",
		},
	},
	{
		name: "branch push lists no files, so watch paths cannot hold it back",
		provider: "bitbucket",
		event: "repo:push",
		body: fx.bitbucketPush,
		rules: { branch: "main", watchPaths: ["apps/web"] },
		normalised: {
			ref: { kind: "branch", name: "main" },
			changedPaths: undefined,
		},
		decision: { action: "deploy", waitForChecks: false },
	},
	{
		name: "tag push with [ci skip] is skipped",
		provider: "bitbucket",
		event: "repo:push",
		body: fx.bitbucketTagPush,
		rules: { on: "tag", tagPattern: "v*" },
		normalised: { ref: { kind: "tag", name: "v3.1.0" } },
		decision: { action: "skip", reason: "Commit message contains [ci skip]" },
	},
	{
		name: "a release service ignores tag pushes (Bitbucket has no releases)",
		provider: "bitbucket",
		event: "repo:push",
		body: fx.bitbucketTagPush,
		rules: { on: "release" },
		normalised: {},
		decision: {
			action: "ignore",
			reason: "Deploys on release events, not tag events",
		},
	},
];

describe("trigger rules over real provider payloads", () => {
	for (const c of cases)
		test(`${c.provider}: ${c.name}`, async () => {
			const event = await deliver(c.provider, c.event, c.body);
			if (event?.kind !== "push") throw new Error("expected a push event");
			for (const [field, value] of Object.entries(c.normalised))
				expect(event[field as keyof PushEvent]).toEqual(value);
			const { branch = "main", watchPaths = [], ...trigger } = c.rules;
			expect(
				evaluateTrigger(event, {
					...DEFAULT_GIT_TRIGGER,
					...trigger,
					branch,
					watchPaths,
				}),
			).toEqual(c.decision);
		});

	test("only a published release counts", async () => {
		expect(
			await deliver("github", "release", {
				...fx.githubRelease,
				action: "created",
			}),
		).toBeNull();
		expect(
			await deliver("gitlab", "Release Hook", {
				...fx.gitlabRelease,
				action: "update",
			}),
		).toBeNull();
	});

	test("a deleted tag deploys nothing", async () => {
		expect(
			await deliver("gitlab", "Tag Push Hook", {
				...fx.gitlabTagPush,
				after: "0".repeat(40),
				checkout_sha: null,
			}),
		).toBeNull();
	});
});

describe("commit checks", () => {
	test("any failure fails, then any pending waits; LogiStack's own status is not a check", () => {
		expect(
			summarizeChecks([
				{ name: "test", state: "success" },
				{ name: "lint", state: "pending" },
				{ name: "LogiStack", state: "failure" },
			]),
		).toEqual({ state: "pending", failed: [], pending: ["lint"] });
		expect(
			summarizeChecks([
				{ name: "test", state: "failure" },
				{ name: "lint", state: "pending" },
			]),
		).toEqual({ state: "failure", failed: ["test"], pending: ["lint"] });
		expect(summarizeChecks([{ name: "LogiStack", state: "success" }])).toEqual({
			state: "none",
			failed: [],
			pending: [],
		});
	});

	test("github merges commit statuses and check runs", async () => {
		const m = mockFetch((c) => {
			const path = new URL(c.url).pathname;
			if (path.endsWith("/access_tokens"))
				return Response.json({
					token: "ghs",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				});
			if (path.endsWith("/status"))
				return Response.json({
					statuses: [
						{ context: "ci/legacy", state: "success" },
						{ context: "LogiStack", state: "failure" },
					],
				});
			return Response.json({
				check_runs: [
					{ name: "build", status: "completed", conclusion: "success" },
					{ name: "docs", status: "completed", conclusion: "skipped" },
					{ name: "e2e", status: "in_progress", conclusion: null },
				],
			});
		});
		const gh = instantiate(
			gitProviders.github,
			{ ...(configs.github as object), privateKey: await rsaPem() },
			m,
		) as GitProvider;
		expect(await gh.commitChecks("acme/api", "v1.0/rc")).toEqual({
			state: "pending",
			failed: [],
			pending: ["e2e"],
		});
		const paths = m.calls.map((c) => new URL(c.url).pathname);
		expect(paths.filter((p) => p.startsWith("/repos/")).sort()).toEqual([
			"/repos/acme/api/commits/v1.0%2Frc/check-runs",
			"/repos/acme/api/commits/v1.0%2Frc/status",
		]);
	});

	test("gitlab: allowed failures and manual jobs do not block", async () => {
		const m = mockFetch(() =>
			Response.json([
				{ name: "test", status: "success" },
				{ name: "flaky", status: "failed", allow_failure: true },
				{ name: "deploy-docs", status: "manual" },
				{ name: "lint", status: "failed" },
			]),
		);
		expect(await provider("gitlab", m).commitChecks("g/p", "abc")).toEqual({
			state: "failure",
			failed: ["lint"],
			pending: [],
		});
		expect(m.calls[0]?.url).toStartWith(
			"https://gitlab.com/api/v4/projects/g%2Fp/repository/commits/abc/statuses",
		);
	});

	test("gitea: the combined status, warnings pass", async () => {
		const m = mockFetch(() =>
			Response.json({
				state: "warning",
				statuses: [
					{ context: "ci/build", status: "success" },
					{ context: "ci/audit", status: "warning" },
				],
			}),
		);
		expect(await provider("gitea", m).commitChecks("o/r", "abc")).toEqual({
			state: "success",
			failed: [],
			pending: [],
		});
	});

	test("bitbucket: stopped builds fail, no statuses is none", async () => {
		const m = mockFetch(() =>
			Response.json({
				values: [
					{ key: "pipe-1", name: "Pipeline #1", state: "STOPPED" },
					{ key: "pipe-2", state: "INPROGRESS" },
				],
			}),
		);
		expect(
			await provider("bitbucket", m).commitChecks("team/repo", "abc"),
		).toEqual({
			state: "failure",
			failed: ["Pipeline #1"],
			pending: ["pipe-2"],
		});
		const empty = mockFetch(() => Response.json({ values: [] }));
		expect(
			(await provider("bitbucket", empty).commitChecks("team/repo", "abc"))
				.state,
		).toBe("none");
	});
});

async function rsaPem() {
	const { generateKeyPairSync } = await import("node:crypto");
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;
}
