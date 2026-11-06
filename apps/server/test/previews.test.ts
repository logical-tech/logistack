import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decrypt, encrypt } from "@logistack/core";
import {
	deployment,
	environment,
	envVar,
	gitProvider,
	mount,
	organization,
	service,
} from "@logistack/db";
import { hmacSha256 } from "@logistack/providers";
import { and, eq, inArray } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const SHA1 = "a1".repeat(20);
const SHA2 = "b2".repeat(20);

describe.skipIf(!hasDocker)("pull request previews", () => {
	let h: Harness;
	let cookie: string;
	let projectId: string;
	let sourceEnv: string;
	let providerId: string;
	let webId: string;
	let dbId: string;
	/** Requests the mocked GitHub API saw, other than token mints. */
	const github: { method: string; path: string; body: string }[] = [];
	let nextComment = 100;
	const real = globalThis.fetch;
	const call = (method: string, path: string, body?: unknown) =>
		h.call(method, `/api${path}`, { headers: { cookie }, body });

	beforeAll(async () => {
		h = await startHarness({ area: "preview", label: "preview" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const [org] = await h.deps.db.select().from(organization);
		const pair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign"],
		)) as CryptoKeyPair;
		const der = new Uint8Array(
			await crypto.subtle.exportKey("pkcs8", pair.privateKey),
		);
		const [gp] = await h.deps.db
			.insert(gitProvider)
			.values({
				organizationId: org?.id ?? "",
				kind: "github",
				name: "GitHub",
				configEncrypted: await encrypt(
					h.deps.masterKey,
					JSON.stringify({
						appId: "1",
						privateKey: `-----BEGIN PRIVATE KEY-----\n${der.toBase64()}\n-----END PRIVATE KEY-----\n`,
						webhookSecret: "hook-secret",
						installationId: "2",
					}),
				),
			})
			.returning();
		providerId = gp?.id ?? "";
		globalThis.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.startsWith("https://api.github.com/")) return real(input, init);
			if (url.endsWith("/access_tokens"))
				return Response.json({
					token: "ghs_test",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				});
			const path = new URL(url).pathname;
			github.push({
				method: init?.method ?? "GET",
				path,
				body: String(init?.body ?? ""),
			});
			const edited = path.match(/\/issues\/comments\/(\d+)$/);
			return Response.json({ id: edited ? Number(edited[1]) : nextComment++ });
		}) as typeof fetch;

		projectId = (await call("POST", "/projects", { name: "Shop" })).json.id;
		sourceEnv = (await call("GET", `/projects/${projectId}/environments`))
			.json[0].id;
		const web = await call("POST", `/environments/${sourceEnv}/services`, {
			name: "web",
			spec: {
				kind: "application",
				source: {
					type: "git",
					gitProviderId: providerId,
					repository: "acme/shop",
					branch: "main",
					path: "/",
				},
				build: {
					type: "dockerfile",
					dockerfilePath: "Dockerfile",
					context: ".",
				},
				ports: [],
				replicas: 1,
				resources: {},
				placement: [],
			},
			mounts: [{ kind: "volume", target: "/data", name: "uploads" }],
		});
		expect(web.status).toBe(201);
		webId = web.json.id;
		await call("PUT", `/services/${webId}/env-vars`, {
			variables: [
				{
					key: "STRIPE_KEY",
					value: "sk_live",
					isSecret: true,
					isBuildTime: false,
				},
				{
					key: "LOG_LEVEL",
					value: "info",
					isSecret: false,
					isBuildTime: false,
				},
			],
		});
		expect(
			(
				await call("POST", `/services/${webId}/domains`, {
					hostname: "shop.example.com",
					port: 3000,
					https: true,
					cert: "auto",
				})
			).status,
		).toBe(201);
		const db = await call("POST", `/environments/${sourceEnv}/services`, {
			name: "db",
			spec: {
				kind: "database",
				engine: "postgres",
				version: "17",
				credentialsRef: "env",
				resources: {},
			},
		});
		dbId = db.json.id;
	}, 60_000);
	afterAll(async () => {
		globalThis.fetch = real;
		await h?.close();
	});

	const signed = async (event: string, payload: unknown) => {
		const raw = JSON.stringify(payload);
		return h.call("POST", `/api/webhooks/git/${providerId}`, {
			body: payload,
			headers: {
				"x-github-event": event,
				"x-hub-signature-256": `sha256=${(await hmacSha256("hook-secret", raw)).toHex()}`,
			},
		});
	};
	const pr = (
		number: number,
		action: string,
		sha: string,
		head = "acme/shop",
	) =>
		signed("pull_request", {
			action,
			number,
			repository: { full_name: "acme/shop" },
			pull_request: {
				title: `Feature ${number}`,
				html_url: `https://github.com/acme/shop/pull/${number}`,
				user: { login: "dev" },
				head: { ref: `feature-${number}`, sha, repo: { full_name: head } },
				base: { ref: "main" },
			},
		});
	const previewEnv = async (number: number) =>
		(
			await h.deps.db
				.select()
				.from(environment)
				.where(
					and(
						eq(environment.projectId, projectId),
						eq(environment.slug, `pr-${number}`),
					),
				)
		)[0];
	const servicesOf = (envId: string) =>
		h.deps.db.select().from(service).where(eq(service.environmentId, envId));

	test("settings need a followed git service of the project", async () => {
		const bad = await call("PUT", `/projects/${projectId}/previews`, {
			enabled: true,
			sourceEnvironmentId: sourceEnv,
			services: ["db"],
			domainPattern: null,
		});
		expect(bad.status).toBe(400);
		expect(bad.json.error.message).toContain("db is not a service");
		const ok = await call("PUT", `/projects/${projectId}/previews`, {
			enabled: true,
			sourceEnvironmentId: sourceEnv,
			services: ["web"],
			domainPattern: "pr-{number}.preview.example.com",
			variables: [{ key: "STRIPE_KEY", value: "sk_test", secret: true }],
			maxPreviews: 2,
			ttlHours: 24,
		});
		expect(ok.status).toBe(200);
		expect(ok.json.allowForks).toBe(false);
		const read = await call("GET", `/projects/${projectId}/previews`);
		expect(read.json.variables).toEqual([{ key: "STRIPE_KEY", secret: true }]);
		expect(JSON.stringify(read.json)).not.toContain("sk_test");
	});

	test("opening a pull request clones the source into pr-<n> with fresh volumes and the head commit", async () => {
		const res = await pr(7, "opened", SHA1);
		expect(res.status).toBe(200);
		expect(res.json.outcome).toBe("deployed");
		const env = await previewEnv(7);
		expect(env?.kind).toBe("preview");
		expect(env?.preview).toMatchObject({
			number: 7,
			title: "Feature 7",
			url: "https://github.com/acme/shop/pull/7",
			headBranch: "feature-7",
			headSha: SHA1,
			urls: ["https://pr-7.preview.example.com"],
			commentId: "100",
		});
		const svcs = await servicesOf(env?.id ?? "");
		expect(svcs.map((s) => s.slug).sort()).toEqual(["db", "web"]);
		expect(svcs.some((s) => s.id === webId || s.id === dbId)).toBe(false);
		const web = svcs.find((s) => s.slug === "web");
		expect(
			web?.spec.kind === "application" && web.spec.source.type === "git"
				? web.spec.source.branch
				: null,
		).toBe("feature-7");
		const [sourceMount] = await h.deps.db
			.select()
			.from(mount)
			.where(eq(mount.serviceId, webId));
		const [previewMount] = await h.deps.db
			.select()
			.from(mount)
			.where(eq(mount.serviceId, web?.id ?? ""));
		expect(previewMount?.target).toBe("/data");
		expect(previewMount?.id).not.toBe(sourceMount?.id);

		const deployments = await h.deps.db
			.select()
			.from(deployment)
			.where(
				inArray(
					deployment.serviceId,
					svcs.map((s) => s.id),
				),
			);
		expect(
			deployments
				.map((d) => [svcs.find((s) => s.id === d.serviceId)?.slug, d.commitSha])
				.sort(),
		).toEqual([
			["db", null],
			["web", SHA1],
		]);

		const vars = await h.deps.db
			.select()
			.from(envVar)
			.where(
				inArray(envVar.scopeId, [env?.id ?? "", ...svcs.map((s) => s.id)]),
			);
		const stripe = vars.filter((v) => v.key === "STRIPE_KEY");
		expect(stripe.map((v) => v.scope)).toEqual(["environment"]);
		expect(
			await decrypt(h.deps.masterKey, stripe[0]?.valueEncrypted ?? ""),
		).toBe("sk_test");

		expect(github).toHaveLength(1);
		expect(github[0]).toMatchObject({
			method: "POST",
			path: "/repos/acme/shop/issues/7/comments",
		});
		expect(github[0]?.body).toContain("https://pr-7.preview.example.com");
	});

	test("a new commit redeploys only the followed service and edits the same comment", async () => {
		const env = await previewEnv(7);
		const before = (await servicesOf(env?.id ?? "")).map((s) => s.id).sort();
		const res = await pr(7, "synchronize", SHA2);
		expect(res.status).toBe(200);
		expect(res.json.deployments).toHaveLength(1);
		const after = await previewEnv(7);
		expect(after?.id).toBe(env?.id);
		expect(after?.preview?.headSha).toBe(SHA2);
		expect((await servicesOf(env?.id ?? "")).map((s) => s.id).sort()).toEqual(
			before,
		);
		expect(github.at(-1)).toMatchObject({
			method: "PATCH",
			path: "/repos/acme/shop/issues/comments/100",
		});
	});

	test("a push to the pull request's branch does not deploy the preview twice", async () => {
		const res = await signed("push", {
			ref: "refs/heads/feature-7",
			after: SHA2,
			repository: { full_name: "acme/shop" },
			head_commit: { id: SHA2, message: "wip" },
			commits: [],
		});
		expect(res.json.outcome).toBe("ignored");
	});

	test("a fork's pull request is refused while forks are off", async () => {
		const res = await pr(8, "opened", SHA1, "mallory/shop");
		expect(res.status).toBe(202);
		expect(res.json.outcome).toBe("skipped");
		expect(res.json.reason).toContain("forks");
		expect(await previewEnv(8)).toBeUndefined();
	});

	test("maxPreviews caps how many run at once", async () => {
		expect((await pr(9, "opened", SHA1)).json.outcome).toBe("deployed");
		const capped = await pr(10, "opened", SHA1);
		expect(capped.json.reason).toContain("limit");
		expect(await previewEnv(10)).toBeUndefined();
		expect((await pr(9, "closed", SHA1)).json.outcome).toBe("removed");
	});

	test("closing deletes the preview and everything in it, once", async () => {
		const env = await previewEnv(7);
		const res = await pr(7, "closed", SHA2);
		expect(res.json.outcome).toBe("removed");
		expect(await previewEnv(7)).toBeUndefined();
		expect(await servicesOf(env?.id ?? "")).toEqual([]);
		expect(github.at(-1)).toMatchObject({
			method: "PATCH",
			path: "/repos/acme/shop/issues/comments/100",
		});
		expect(github.at(-1)?.body).toContain("removed");
		const again = await pr(7, "closed", SHA2);
		expect(again.status).toBe(202);
		expect(again.json.previews[0].reason).toBe("no preview to remove");
		const source = await servicesOf(sourceEnv);
		expect(source.map((s) => s.id).sort()).toEqual([dbId, webId].sort());
	});
});
