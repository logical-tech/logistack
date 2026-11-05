import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decrypt } from "@logistack/core";
import { deployment, gitProvider } from "@logistack/db";
import { hmacSha256 } from "@logistack/providers";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const pushPayload = (o: { branch: string; files: string[]; sha?: string }) => ({
	ref: `refs/heads/${o.branch}`,
	after: o.sha ?? "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
	repository: { full_name: "acme/shop" },
	head_commit: {
		id: o.sha ?? "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
		message: "feat: new checkout\n\nlong body",
		author: { name: "Ada" },
	},
	pusher: { login: "ada" },
	commits: [{ added: [], modified: o.files, removed: [] }],
});

const gitSpec = (gitProviderId: string, branch = "main") => ({
	kind: "application",
	source: {
		type: "git",
		gitProviderId,
		repository: "acme/shop",
		branch,
		path: "/",
	},
	build: { type: "dockerfile", dockerfilePath: "Dockerfile", context: "." },
	ports: [{ target: 3000, protocol: "tcp" }],
	replicas: 1,
	resources: {},
	placement: [],
});

/** Routes https://api.github.com to `handler`; everything else goes out for real. */
function mockGitHub(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
	const real = globalThis.fetch;
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = input instanceof Request ? input.url : String(input);
		return url.startsWith("https://api.github.com/")
			? handler(url, init ?? {})
			: real(input, init);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = real;
	};
}

async function rsaKey() {
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const der = new Uint8Array(
		await crypto.subtle.exportKey("pkcs8", pair.privateKey),
	);
	const pem = `-----BEGIN PRIVATE KEY-----\n${der
		.toBase64()
		.match(/.{1,64}/g)
		?.join("\n")}\n-----END PRIVATE KEY-----\n`;
	return { pem, publicKey: pair.publicKey };
}

async function verifyJwt(jwt: string, key: CryptoKey) {
	const [h, p, s] = jwt.split(".");
	return crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		Uint8Array.fromBase64(s ?? "", { alphabet: "base64url" }),
		new TextEncoder().encode(`${h}.${p}`),
	);
}

describe.skipIf(!hasDocker)("git integrations over HTTP", () => {
	let h: Harness;
	let cookie: string;
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "git", label: "git" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
	}, 60_000);
	afterAll(() => h?.close());

	describe("POST /api/webhooks/git/:providerId", () => {
		let providerId: string;
		let secret: string;
		let serviceId: string;

		const deliver = async (
			payload: unknown,
			o: { event?: string; sign?: string | null } = {},
		) => {
			const raw = JSON.stringify(payload);
			const signature =
				o.sign === undefined ? (await hmacSha256(secret, raw)).toHex() : o.sign;
			return h.call("POST", `/api/webhooks/git/${providerId}`, {
				body: payload,
				headers: {
					"x-gitea-event": o.event ?? "push",
					...(signature === null ? {} : { "x-gitea-signature": signature }),
				},
			});
		};

		beforeAll(async () => {
			const created = await h.call("POST", "/api/git-providers", {
				...as(),
				body: {
					name: "Forgejo",
					provider: {
						kind: "gitea",
						baseUrl: "https://forgejo.example.com",
						token: "tok",
					},
				},
			});
			expect(created.status).toBe(201);
			providerId = created.json.id;
			const [row] = await h.deps.db
				.select()
				.from(gitProvider)
				.where(eq(gitProvider.id, providerId));
			secret = JSON.parse(
				await decrypt(h.deps.masterKey, row?.configEncrypted ?? ""),
			).webhookSecret;
			expect(secret.length).toBeGreaterThan(20);

			const project = await h.call("POST", "/api/projects", {
				...as(),
				body: { name: "Shop" },
			});
			const envs = await h.call(
				"GET",
				`/api/projects/${project.json.id}/environments`,
				as(),
			);
			const svc = await h.call(
				"POST",
				`/api/environments/${envs.json[0].id}/services`,
				{ ...as(), body: { name: "Web", spec: gitSpec(providerId) } },
			);
			expect(svc.status).toBe(201);
			serviceId = svc.json.id;
			const watch = await h.call(
				"PUT",
				`/api/services/${serviceId}/watch-paths`,
				{ ...as(), body: { paths: ["/apps/web/", "packages/**/*.css"] } },
			);
			expect(watch.json.paths).toEqual(["apps/web/", "packages/**/*.css"]);
		});

		test("a signed push to the tracked branch touching a watched path deploys", async () => {
			const res = await deliver(
				pushPayload({ branch: "main", files: ["apps/web/src/checkout.ts"] }),
			);
			expect(res.status).toBe(200);
			expect(res.json.outcome).toBe("deployed");
			expect(res.json.deployments).toHaveLength(1);
			const [d] = await h.deps.db
				.select()
				.from(deployment)
				.where(eq(deployment.id, res.json.deployments[0]));
			expect(d).toMatchObject({
				serviceId,
				status: "queued",
				trigger: "git_push",
				commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
				commitMessage: "feat: new checkout",
			});
		});

		test("a tampered body or a missing signature is 401 and queues nothing", async () => {
			const before = await h.deps.db.$count(deployment);
			const payload = pushPayload({ branch: "main", files: ["apps/web/a"] });
			const sig = (await hmacSha256(secret, JSON.stringify(payload))).toHex();
			const tampered = await deliver(
				{ ...payload, ref: "refs/heads/evil" },
				{ sign: sig },
			);
			expect(tampered.status).toBe(401);
			expect(tampered.json.error.code).toBe("unauthorized");
			expect((await deliver(payload, { sign: null })).status).toBe(401);
			expect(await h.deps.db.$count(deployment)).toBe(before);
		});

		test("authentic events LogiStack does not act on are 202", async () => {
			const before = await h.deps.db.$count(deployment);
			const otherBranch = await deliver(
				pushPayload({ branch: "feature/x", files: ["apps/web/a"] }),
			);
			expect(otherBranch.status).toBe(202);
			expect(otherBranch.json.outcome).toBe("ignored");
			const unwatched = await deliver(
				pushPayload({ branch: "main", files: ["docs/readme.md"] }),
			);
			expect(unwatched.status).toBe(202);
			expect(unwatched.json).toMatchObject({
				outcome: "skipped",
				reason: "No watched path changed",
			});
			const glob = await deliver(
				pushPayload({ branch: "main", files: ["packages/ui/button.css"] }),
			);
			expect(glob.status).toBe(200);
			const tag = await deliver({
				...pushPayload({ branch: "main", files: [] }),
				ref: "refs/tags/v1",
			});
			expect(tag.status).toBe(202);
			const unknownEvent = await deliver({ zen: "hi" }, { event: "ping" });
			expect(unknownEvent.status).toBe(202);
			// The glob match deployed; the unwatched push left a skipped record.
			expect(await h.deps.db.$count(deployment)).toBe(before + 2);
		});

		test("skipped triggers are listed with their reason; tag triggers wait for checks", async () => {
			const marked = pushPayload({ branch: "main", files: ["apps/web/a.ts"] });
			marked.head_commit.message = "docs: tweak [skip ci]";
			const skip = await deliver(marked);
			expect(skip.status).toBe(202);
			expect(skip.json.outcome).toBe("skipped");
			const list = await h.call(
				"GET",
				`/api/services/${serviceId}/deployments`,
				as(),
			);
			expect(list.json[0]).toMatchObject({
				id: skip.json.skipped[0],
				status: "skipped",
				reason: "Commit message contains [skip ci]",
				commitMessage: "docs: tweak [skip ci]",
			});
			expect(list.json[0].finishedAt).not.toBeNull();

			const rules = {
				on: "tag",
				tagPattern: "v*.*.*",
				waitForChecks: true,
				checksTimeoutMinutes: 15,
			};
			const put = await h.call(
				"PUT",
				`/api/services/${serviceId}/git-trigger`,
				{ ...as(), body: rules },
			);
			expect(put.status).toBe(200);
			expect(
				(await h.call("GET", `/api/services/${serviceId}/git-trigger`, as()))
					.json,
			).toEqual(rules);

			const tag = (name: string) => ({
				...pushPayload({ branch: "main", files: [] }),
				ref: `refs/tags/${name}`,
			});
			const release = await deliver(tag("v1.2.3"));
			expect(release.status).toBe(200);
			const [held] = await h.deps.db
				.select()
				.from(deployment)
				.where(eq(deployment.id, release.json.deployments[0]));
			expect(held).toMatchObject({
				status: "awaiting_checks",
				gitRef: "v1.2.3",
				commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
			});
			const nightly = await deliver(tag("nightly"));
			expect(nightly.json).toMatchObject({
				outcome: "skipped",
				reason: "Tag nightly does not match v*.*.*",
			});
			const branch = await deliver(
				pushPayload({ branch: "main", files: ["apps/web/a.ts"] }),
			);
			expect(branch.json.outcome).toBe("ignored");

			await h.call("PUT", `/api/services/${serviceId}/git-trigger`, {
				...as(),
				body: { on: "branch" },
			});
		});

		test("an unknown provider is 404", async () => {
			const res = await h.call("POST", "/api/webhooks/git/git_nope", {
				body: {},
			});
			expect(res.status).toBe(404);
		});
	});

	describe("GitHub App manifest flow", () => {
		test("manifest, callback, setup and the connected provider, against a mocked GitHub", async () => {
			const start = await h.call("POST", "/api/git-providers/github/manifest", {
				...as(),
				body: { name: "acme-logistack", organization: "acme" },
			});
			expect(start.status).toBe(201);
			const { providerId, action, manifest } = start.json;
			expect(action).toStartWith(
				"https://github.com/organizations/acme/settings/apps/new?state=",
			);
			expect(manifest).toMatchObject({
				url: "https://ls.example.com",
				hook_attributes: {
					url: `https://ls.example.com/api/webhooks/git/${providerId}`,
				},
				redirect_url:
					"https://ls.example.com/api/git-providers/github/callback",
				setup_url: "https://ls.example.com/api/git-providers/github/setup",
				default_permissions: { statuses: "write", contents: "read" },
			});
			const state = decodeURIComponent(action.split("state=")[1]);

			const pending = await h.call("GET", "/api/git-providers", as());
			expect(
				pending.json.find((p: { id: string }) => p.id === providerId),
			).toMatchObject({ state: "pending", appUrl: null });

			const key = await rsaKey();
			const seen: string[] = [];
			const restore = mockGitHub(async (url, init) => {
				seen.push(`${init.method ?? "GET"} ${url}`);
				const auth = new Headers(init.headers).get("authorization") ?? "";
				if (url.endsWith("/app-manifests/code-123/conversions"))
					return Response.json({
						id: 4242,
						slug: "acme-logistack",
						pem: key.pem,
						webhook_secret: "whsec",
						client_id: "Iv1.abc",
						client_secret: "cs",
						html_url: "https://github.com/apps/acme-logistack",
					});
				if (url.endsWith("/app/installations/777")) {
					// Only a JWT signed with the app's own key may see the installation.
					const ok = await verifyJwt(auth.slice(7), key.publicKey);
					return ok
						? Response.json({ id: 777 })
						: new Response("bad jwt", { status: 401 });
				}
				if (url.endsWith("/app/installations/777/access_tokens"))
					return Response.json({
						token: "ghs_test",
						expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					});
				if (url.includes("/installation/repositories"))
					return Response.json({
						total_count: 2,
						repositories: [
							{ full_name: "acme/shop", private: true, default_branch: "main" },
							{ full_name: "acme/api", private: true, default_branch: "main" },
						],
					});
				return new Response("unexpected", { status: 500 });
			});
			try {
				const forged = await h.call(
					"GET",
					`/api/git-providers/github/callback?code=code-123&state=${encodeURIComponent(`${providerId}.wrong`)}`,
					as(),
				);
				expect(forged.status).toBe(403);

				const callback = await h.call(
					"GET",
					`/api/git-providers/github/callback?code=code-123&state=${encodeURIComponent(state)}`,
					as(),
				);
				expect(callback.status).toBe(302);
				expect(callback.headers.get("location")).toBe(
					`/integrations/git/new?kind=github&provider=${providerId}&step=install`,
				);

				const setup = await h.call(
					"GET",
					`/api/git-providers/github/setup?installation_id=777&setup_action=install&state=${encodeURIComponent(state)}`,
					as(),
				);
				expect(setup.status).toBe(302);
				expect(setup.headers.get("location")).toContain("step=test");

				const list = await h.call("GET", "/api/git-providers", as());
				expect(
					list.json.find((p: { id: string }) => p.id === providerId),
				).toMatchObject({
					kind: "github",
					state: "connected",
					repoCount: 2,
					appUrl: "https://github.com/apps/acme-logistack",
					installUrl:
						"https://github.com/apps/acme-logistack/installations/new",
				});
				const test = await h.call(
					"POST",
					`/api/git-providers/${providerId}/test`,
					as(),
				);
				expect(test.json).toMatchObject({ ok: true });

				const [row] = await h.deps.db
					.select()
					.from(gitProvider)
					.where(eq(gitProvider.id, providerId));
				expect(row?.configEncrypted).not.toContain("PRIVATE KEY");
				const stored = JSON.parse(
					await decrypt(h.deps.masterKey, row?.configEncrypted ?? ""),
				);
				expect(stored).toMatchObject({
					appId: "4242",
					installationId: "777",
					webhookSecret: "whsec",
				});
			} finally {
				restore();
			}
			expect(seen).toContain(
				"POST https://api.github.com/app-manifests/code-123/conversions",
			);
		});
	});
});
