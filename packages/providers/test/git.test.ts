import { describe, expect, test } from "bun:test";
import {
	createHmac,
	createPublicKey,
	generateKeyPairSync,
	verify,
} from "node:crypto";
import {
	buildGitHubAppManifest,
	exchangeGitHubManifestCode,
	type GitProvider,
	gitProviders,
	importRsaPrivateKey,
	instantiate,
	ownerRepoPath,
	ProviderError,
	pointGitHubAppHook,
	signGitHubAppJwt,
	WebhookRejectedError,
} from "../src/index.ts";
import * as fx from "./fixtures/git.ts";
import { type Call, json, mockFetch } from "./helpers.ts";

const SECRET = "whsec_0123456789";
// Independent HMAC (node:crypto) so the verifier is not checked against itself.
const hmac = (body: string, key = SECRET) =>
	createHmac("sha256", key).update(body).digest("hex");

const { privateKey: pkcs1Pem, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

const providers: Record<string, GitProvider> = {
	github: instantiate(gitProviders.github, {
		appId: "123",
		privateKey: pkcs1Pem,
		webhookSecret: SECRET,
		installationId: "456",
	}),
	gitlab: instantiate(gitProviders.gitlab, {
		token: "glpat-x",
		webhookSecret: SECRET,
	}),
	gitea: instantiate(gitProviders.gitea, {
		baseUrl: "https://git.example.com",
		token: "t",
		webhookSecret: SECRET,
	}),
	bitbucket: instantiate(gitProviders.bitbucket, {
		workspace: "team",
		accessToken: "t",
		webhookSecret: SECRET,
	}),
};

type Case = {
	provider: keyof typeof providers;
	name: string;
	body: unknown;
	headers: (raw: string) => Record<string, string>;
	signatureHeader: string;
	expected: unknown;
};

const cases: Case[] = [
	{
		provider: "github",
		name: "push",
		body: fx.githubPush,
		headers: (raw) => ({
			"x-github-event": "push",
			"x-hub-signature-256": `sha256=${hmac(raw)}`,
		}),
		signatureHeader: "x-hub-signature-256",
		expected: {
			kind: "push",
			repo: "Codertocat/Hello-World",
			ref: { kind: "branch", name: "main" },
			commitSha: "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c",
			commitMessage: "Update README.md",
			author: "Codertocat",
			changedPaths: ["README.md", "apps/web/new.ts"],
		},
	},
	{
		provider: "github",
		name: "pull_request",
		body: fx.githubPullRequest,
		headers: (raw) => ({
			"x-github-event": "pull_request",
			"x-hub-signature-256": `sha256=${hmac(raw)}`,
		}),
		signatureHeader: "x-hub-signature-256",
		expected: {
			kind: "pull_request",
			repo: "Codertocat/Hello-World",
			branch: "master",
			commitSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
			commitMessage: "Update the README with new information.",
			author: "Codertocat",
			pr: {
				number: 2,
				action: "updated",
				headBranch: "changes",
				fromFork: false,
				url: "https://github.com/Codertocat/Hello-World/pull/2",
			},
		},
	},
	{
		provider: "gitlab",
		name: "push",
		body: fx.gitlabPush,
		headers: () => ({
			"x-gitlab-event": "Push Hook",
			"x-gitlab-token": SECRET,
		}),
		signatureHeader: "x-gitlab-token",
		expected: {
			kind: "push",
			repo: "mike/diaspora",
			ref: { kind: "branch", name: "master" },
			commitSha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
			commitMessage: "fixed readme",
			author: "GitLab dev user",
			changedPaths: [
				"CHANGELOG",
				"README.md",
				"app/controller/application.rb",
				"old.txt",
			],
		},
	},
	{
		provider: "gitlab",
		name: "merge request",
		body: fx.gitlabMergeRequest,
		headers: () => ({
			"x-gitlab-event": "Merge Request Hook",
			"x-gitlab-token": SECRET,
		}),
		signatureHeader: "x-gitlab-token",
		expected: {
			kind: "pull_request",
			repo: "gitlabhq/gitlab-test",
			branch: "master",
			commitSha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
			commitMessage: "MS-Viewport",
			author: "Administrator",
			pr: {
				number: 1,
				action: "updated",
				headBranch: "ms-viewport",
				fromFork: false,
				url: "https://gitlab.example.com/gitlabhq/gitlab-test/-/merge_requests/1",
			},
		},
	},
	{
		provider: "gitea",
		name: "push",
		body: fx.giteaPush,
		headers: (raw) => ({
			"x-gitea-event": "push",
			"x-gitea-signature": hmac(raw),
		}),
		signatureHeader: "x-gitea-signature",
		expected: {
			kind: "push",
			repo: "gitea/webhooks",
			ref: { kind: "branch", name: "develop" },
			commitSha: "bffeb74224043ba2feb48d137756c8a9331c449a",
			commitMessage: "Webhooks Yay!",
			author: "Gitea",
			changedPaths: ["services/web/index.ts"],
		},
	},
	{
		provider: "gitea",
		name: "pull_request (Forgejo headers)",
		body: fx.giteaPullRequest,
		headers: (raw) => ({
			"x-forgejo-event": "pull_request",
			"x-forgejo-signature": hmac(raw),
		}),
		signatureHeader: "x-forgejo-signature",
		expected: {
			kind: "pull_request",
			repo: "gitea/webhooks",
			branch: "main",
			commitSha: "f1d2d2f924e986ac86fdf7b36c94bcdf32beec15",
			commitMessage: "Add preview support",
			author: "gitea",
			pr: {
				number: 7,
				action: "updated",
				headBranch: "feature/preview",
				fromFork: false,
			},
		},
	},
	{
		provider: "bitbucket",
		name: "repo:push",
		body: fx.bitbucketPush,
		headers: (raw) => ({
			"x-event-key": "repo:push",
			"x-hub-signature": `sha256=${hmac(raw)}`,
		}),
		signatureHeader: "x-hub-signature",
		expected: {
			kind: "push",
			repo: "team/repo",
			ref: { kind: "branch", name: "main" },
			commitSha: "709d658dc5b6d6afcd46049c2f332ee3f515a67d",
			commitMessage: "Fix the build\n",
			author: "Emma",
			changedPaths: undefined,
		},
	},
	{
		provider: "bitbucket",
		name: "pullrequest:created",
		body: fx.bitbucketPullRequest,
		headers: (raw) => ({
			"x-event-key": "pullrequest:created",
			"x-hub-signature": `sha256=${hmac(raw)}`,
		}),
		signatureHeader: "x-hub-signature",
		expected: {
			kind: "pull_request",
			repo: "team/repo",
			branch: "main",
			commitSha: "d3fe0e9a7c4b",
			commitMessage: "Preview environments",
			author: "Emma",
			pr: {
				number: 12,
				action: "opened",
				headBranch: "feature/x",
				fromFork: false,
			},
		},
	},
];

const rejection = (p: Promise<unknown>) =>
	p.then(
		() => "accepted",
		(e) => (e instanceof WebhookRejectedError ? e.reason : `threw ${e}`),
	);

describe("webhook verification", () => {
	for (const c of cases) {
		const raw = JSON.stringify(c.body);
		const provider = providers[c.provider] as GitProvider;
		describe(`${c.provider} ${c.name}`, () => {
			test("valid", async () => {
				expect(
					await provider.verifyWebhook(new Headers(c.headers(raw)), raw),
				).toEqual(c.expected as never);
			});
			test("tampered body", async () => {
				const tampered = raw.replace(
					/(refs\/heads\/|")(main|master|develop)"/,
					'$1evil"',
				);
				expect(tampered).not.toBe(raw);
				expect(
					await rejection(
						provider.verifyWebhook(new Headers(c.headers(raw)), tampered),
					),
				).toBe(c.provider === "gitlab" ? "accepted" : "invalid_signature");
			});
			test("wrong secret", async () => {
				const h = new Headers(c.headers(raw));
				h.set(
					c.signatureHeader,
					c.provider === "gitlab"
						? "nope"
						: (h
								.get(c.signatureHeader)
								?.replace(hmac(raw), hmac(raw, "other")) ?? ""),
				);
				expect(await rejection(provider.verifyWebhook(h, raw))).toBe(
					"invalid_signature",
				);
			});
			test("missing signature", async () => {
				const h = new Headers(c.headers(raw));
				h.delete(c.signatureHeader);
				expect(await rejection(provider.verifyWebhook(h, raw))).toBe(
					"missing_signature",
				);
			});
		});
	}

	const github = providers.github as GitProvider;
	const signed = (event: string, body: unknown) => {
		const raw = JSON.stringify(body);
		return [
			new Headers({
				"x-github-event": event,
				"x-hub-signature-256": `sha256=${hmac(raw)}`,
			}),
			raw,
		] as const;
	};

	test("authentic but ignored events return null", async () => {
		expect(
			await github.verifyWebhook(...signed("ping", { zen: "hi" })),
		).toBeNull();
		expect(
			await github.verifyWebhook(
				...signed("push", { ...fx.githubPush, ref: "refs/notes/commits" }),
			),
		).toBeNull();
		expect(
			await github.verifyWebhook(
				...signed("push", {
					...fx.githubPush,
					deleted: true,
					after: "0".repeat(40),
				}),
			),
		).toBeNull();
		expect(
			await github.verifyWebhook(
				...signed("pull_request", {
					...fx.githubPullRequest,
					action: "labeled",
				}),
			),
		).toBeNull();

		const gitlab = providers.gitlab as GitProvider;
		const mr = {
			...fx.gitlabMergeRequest,
			object_attributes: {
				...fx.gitlabMergeRequest.object_attributes,
				oldrev: undefined,
			},
		};
		const h = new Headers({
			"x-gitlab-event": "Merge Request Hook",
			"x-gitlab-token": SECRET,
		});
		expect(await gitlab.verifyWebhook(h, JSON.stringify(mr))).toBeNull();
	});

	test("a pull request from a fork, or from a deleted fork, says so", async () => {
		const pr = fx.githubPullRequest.pull_request;
		const fromFork = async (repo: { full_name: string } | null) => {
			const e = await github.verifyWebhook(
				...signed("pull_request", {
					...fx.githubPullRequest,
					pull_request: { ...pr, head: { ...pr.head, repo } },
				}),
			);
			return e?.kind === "pull_request" && e.pr.fromFork;
		};
		expect(await fromFork({ full_name: "mallory/Hello-World" })).toBe(true);
		expect(await fromFork(null)).toBe(true);
		expect(await fromFork({ full_name: "codertocat/hello-world" })).toBe(false);
	});

	test("a full commit list means changed paths are unknown", async () => {
		const commits = Array.from({ length: 20 }, () => fx.githubPush.commits[0]);
		const e = await github.verifyWebhook(
			...signed("push", { ...fx.githubPush, commits }),
		);
		expect(e?.kind === "push" && e.changedPaths).toBeUndefined();
	});

	test("bitbucket without a secret rejects everything", async () => {
		const bb = instantiate(gitProviders.bitbucket, {
			workspace: "team",
			accessToken: "t",
		});
		const raw = JSON.stringify(fx.bitbucketPush);
		expect(
			await rejection(
				bb.verifyWebhook(new Headers({ "x-event-key": "repo:push" }), raw),
			),
		).toBe("not_configured");
	});
});

describe("GitHub App", () => {
	test("manifest asks for exactly the permissions LogiStack uses", () => {
		expect(
			buildGitHubAppManifest({
				name: "LogiStack acme",
				url: "https://ls.acme.dev",
				webhookUrl: "https://ls.acme.dev/api/webhooks/github",
				redirectUrl: "https://ls.acme.dev/setup/github/callback",
			}),
		).toEqual({
			name: "LogiStack acme",
			url: "https://ls.acme.dev",
			hook_attributes: {
				url: "https://ls.acme.dev/api/webhooks/github",
				active: true,
			},
			redirect_url: "https://ls.acme.dev/setup/github/callback",
			public: false,
			default_permissions: {
				contents: "read",
				metadata: "read",
				pull_requests: "write",
				statuses: "write",
				checks: "read",
			},
			default_events: ["push", "pull_request", "release"],
		});
	});

	test("manifest code exchange", async () => {
		const m = mockFetch(() =>
			Response.json({
				id: 42,
				slug: "logistack-acme",
				pem: pkcs1Pem,
				webhook_secret: "ws",
				client_id: "Iv1.x",
				client_secret: "cs",
				html_url: "https://github.com/apps/logistack-acme",
				owner: { login: "acme" },
			}),
		);
		const app = await exchangeGitHubManifestCode("abc123", m);
		expect(m.calls[0]?.method).toBe("POST");
		expect(m.calls[0]?.url).toBe(
			"https://api.github.com/app-manifests/abc123/conversions",
		);
		expect(app).toMatchObject({
			appId: "42",
			slug: "logistack-acme",
			webhookSecret: "ws",
			privateKey: pkcs1Pem,
		});
	});

	test("RS256 JWT from a PKCS#1 key verifies with the public key", async () => {
		const jwt = await signGitHubAppJwt(
			"123",
			await importRsaPrivateKey(pkcs1Pem),
			1_800_000_000,
		);
		const [h, p, s] = jwt.split(".") as [string, string, string];
		expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
			alg: "RS256",
			typ: "JWT",
		});
		expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({
			iat: 1_800_000_000 - 60,
			exp: 1_800_000_000 + 540,
			iss: "123",
		});
		expect(
			verify(
				"sha256",
				Buffer.from(`${h}.${p}`),
				createPublicKey(publicKey),
				Buffer.from(s, "base64url"),
			),
		).toBe(true);
	});

	test("PKCS#8 keys import too", async () => {
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		await importRsaPrivateKey(privateKey);
	});

	test("installation token is minted once, then reused for API calls and clone URLs", async () => {
		const m = mockFetch((c) => {
			const path = new URL(c.url).pathname;
			if (path === "/app/installations/456/access_tokens")
				return Response.json({
					token: "ghs_abc",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				});
			if (path === "/installation/repositories")
				return Response.json({
					total_count: 1,
					repositories: [
						{ full_name: "acme/api", private: true, default_branch: "main" },
					],
				});
			return Response.json([{ name: "main" }, { name: "dev" }]);
		});
		const gh = instantiate(
			gitProviders.github,
			{
				appId: "123",
				privateKey: pkcs1Pem,
				webhookSecret: SECRET,
				installationId: "456",
			},
			m,
		);
		expect(await gh.listRepos()).toEqual([
			{ fullName: "acme/api", private: true, defaultBranch: "main" },
		]);
		expect(await gh.listBranches("acme/api")).toEqual(["main", "dev"]);
		expect(await gh.getCloneUrl("acme/api")).toBe(
			"https://x-access-token:ghs_abc@github.com/acme/api.git",
		);
		const mints = m.calls.filter((c) => c.url.endsWith("/access_tokens"));
		expect(mints).toHaveLength(1);
		expect(mints[0]?.headers.authorization).toMatch(
			/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
		);
		expect(m.calls[1]?.headers.authorization).toBe("Bearer ghs_abc");
	});

	test("a pull request comment is edited in place, and posted again once deleted", async () => {
		const m = mockFetch((c) => {
			const path = new URL(c.url).pathname;
			if (path.endsWith("/access_tokens"))
				return Response.json({
					token: "ghs_abc",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				});
			if (path === "/repos/acme/api/issues/comments/11")
				return Response.json({ id: 11 });
			if (path === "/repos/acme/api/issues/comments/12")
				return new Response("Not Found", { status: 404 });
			return Response.json({ id: 13 });
		});
		const gh = instantiate(
			gitProviders.github,
			{
				appId: "123",
				privateKey: pkcs1Pem,
				webhookSecret: SECRET,
				installationId: "456",
			},
			m,
		);
		expect(await gh.commentOnPullRequest?.("acme/api", 4, "hi")).toBe("13");
		expect(await gh.commentOnPullRequest?.("acme/api", 4, "hi", "11")).toBe(
			"11",
		);
		expect(await gh.commentOnPullRequest?.("acme/api", 4, "hi", "12")).toBe(
			"13",
		);
		const api = m.calls.filter((c) => !c.url.endsWith("/access_tokens"));
		expect(api.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"POST /repos/acme/api/issues/4/comments",
			"PATCH /repos/acme/api/issues/comments/11",
			"PATCH /repos/acme/api/issues/comments/12",
			"POST /repos/acme/api/issues/4/comments",
		]);
		expect(json(api[0] as Call)).toEqual({ body: "hi" });
	});
});

describe("API listing", () => {
	test("gitlab pages by X-Next-Page and builds an oauth2 clone URL", async () => {
		const m = mockFetch((c) => {
			const page = new URL(c.url).searchParams.get("page");
			return Response.json(
				[
					{
						path_with_namespace: `grp/p${page}`,
						visibility: "private",
						default_branch: "main",
					},
				],
				{
					headers: { "x-next-page": page === "1" ? "2" : "" },
				},
			);
		});
		const gl = instantiate(
			gitProviders.gitlab,
			{
				baseUrl: "https://git.acme.dev/",
				token: "glpat-x",
				webhookSecret: SECRET,
			},
			m,
		);
		expect((await gl.listRepos()).map((r) => r.fullName)).toEqual([
			"grp/p1",
			"grp/p2",
		]);
		expect(m.calls[0]?.headers["private-token"]).toBe("glpat-x");
		expect(m.calls[0]?.url).toStartWith(
			"https://git.acme.dev/api/v4/projects?",
		);
		expect(await gl.getCloneUrl("grp/sub/app")).toBe(
			"https://oauth2:glpat-x@git.acme.dev/grp/sub/app.git",
		);
	});

	test("bitbucket follows next links only on the API host", async () => {
		const m = mockFetch((c) =>
			c.url.includes("page=2")
				? Response.json({
						values: [{ full_name: "team/b", is_private: false }],
						next: "https://evil.example/steal",
					})
				: Response.json({
						values: [
							{
								full_name: "team/a",
								is_private: true,
								mainbranch: { name: "main" },
							},
						],
						next: "https://api.bitbucket.org/2.0/repositories/team?page=2",
					}),
		);
		const bb = instantiate(
			gitProviders.bitbucket,
			{ workspace: "team", accessToken: "t" },
			m,
		);
		expect((await bb.listRepos()).map((r) => r.fullName)).toEqual([
			"team/a",
			"team/b",
		]);
		expect(m.calls).toHaveLength(2);
	});

	test("readFile asks each API for the raw file at a ref", async () => {
		const m = mockFetch(() => new Response("services: {}\n"));
		const gl = instantiate(
			gitProviders.gitlab,
			{ baseUrl: "https://git.acme.dev", token: "t", webhookSecret: SECRET },
			m,
		);
		const gt = instantiate(
			gitProviders.gitea,
			{ baseUrl: "https://gitea.acme.dev", token: "t", webhookSecret: SECRET },
			m,
		);
		const bb = instantiate(
			gitProviders.bitbucket,
			{ workspace: "team", accessToken: "t" },
			m,
		);
		expect(await gl.readFile("grp/app", "main", "deploy/compose.yml")).toBe(
			"services: {}\n",
		);
		await gt.readFile("acme/app", "feat/x", "./compose.yml");
		await bb.readFile("team/app", "main", "compose.yml");
		expect(m.calls.map((c) => c.url)).toEqual([
			"https://git.acme.dev/api/v4/projects/grp%2Fapp/repository/files/deploy%2Fcompose.yml/raw?ref=main",
			"https://gitea.acme.dev/api/v1/repos/acme/app/raw/compose.yml?ref=feat%2Fx",
			"https://api.bitbucket.org/2.0/repositories/team/app/src/main/compose.yml",
		]);
		for (const bad of ["../secrets", "a/../../b", "", "a//b"])
			await expect(gt.readFile("acme/app", "main", bad)).rejects.toThrow(
				ProviderError,
			);
		expect(m.calls).toHaveLength(3);
	});

	test("owner/name paths cannot escape", () => {
		expect(ownerRepoPath("x", "acme/api.v2")).toBe("acme/api.v2");
		for (const bad of ["../etc", "acme/..", "a/b/c", "acme/api?x=1", "acme"])
			expect(() => ownerRepoPath("x", bad)).toThrow(ProviderError);
	});
});

describe("generic SSH", () => {
	test("accepts SSH URLs only", () => {
		const parse = (repoUrl: string) =>
			gitProviders.generic.configSchema.safeParse({
				repoUrl,
				sshKeyId: "ssh_1",
			}).success;
		expect(parse("git@github.com:acme/api.git")).toBe(true);
		expect(parse("ssh://git@git.acme.dev:2222/acme/api.git")).toBe(true);
		expect(parse("https://github.com/acme/api.git")).toBe(false);
		expect(parse("git@host:")).toBe(false);
	});
	test("clone URL is the configured URL; webhooks are rejected", async () => {
		const g = instantiate(gitProviders.generic, {
			repoUrl: "git@host:a/b.git",
			sshKeyId: "ssh_1",
		});
		expect(await g.getCloneUrl("ignored")).toBe("git@host:a/b.git");
		expect(await rejection(g.verifyWebhook(new Headers(), "{}"))).toBe(
			"not_configured",
		);
	});
});

describe("moving a GitHub App's webhook", () => {
	const app = { appId: "42", privateKey: pkcs1Pem, webhookSecret: "kept" };

	test("PATCHes the app's hook config as the app, keeping its secret", async () => {
		const m = mockFetch(() => Response.json({}));
		await pointGitHubAppHook(
			app,
			"https://ls.example.com/api/webhooks/git/git_1",
			m,
		);
		const [call] = m.calls;
		expect(call?.method).toBe("PATCH");
		expect(call?.url).toBe("https://api.github.com/app/hook/config");
		const jwt = call?.headers.authorization?.replace("Bearer ", "") ?? "";
		const [, payload = ""] = jwt.split(".");
		expect(
			JSON.parse(Buffer.from(payload, "base64url").toString()),
		).toMatchObject({ iss: "42" });
		expect(json(call as Call)).toEqual({
			url: "https://ls.example.com/api/webhooks/git/git_1",
			content_type: "json",
			insecure_ssl: "0",
			secret: "kept",
		});
	});

	test("a refusal from GitHub throws with its status", async () => {
		const m = mockFetch(() => new Response("Bad credentials", { status: 401 }));
		await expect(pointGitHubAppHook(app, "https://x/y", m)).rejects.toThrow(
			"HTTP 401",
		);
	});
});
