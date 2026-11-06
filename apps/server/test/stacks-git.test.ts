import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt } from "@logistack/core";
import { deployment, gitProvider, organization } from "@logistack/db";
import { hmacSha256 } from "@logistack/providers";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const V1 = `
services:
  web:
    image: nginx:1.28
  cache:
    image: redis:7.4
`;
const V2 = `
services:
  web:
    image: nginx:1.29
  cache:
    image: redis:7.4
`;

const SHA = "c0ffee0000000000000000000000000000000001";

describe.skipIf(!hasDocker)("git stacks", () => {
	let h: Harness;
	let cookie: string;
	let envId: string;
	let providerId: string;
	let stackId: string;
	/** What the mocked GitHub serves for the compose file, by ref. */
	const files = new Map<string, string>();
	const reads: string[] = [];
	const as = () => ({ headers: { cookie } });
	const real = globalThis.fetch;

	beforeAll(async () => {
		h = await startHarness({ area: "stkgit", label: "stkgit" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call("POST", "/api/projects", {
			...as(),
			body: { name: "Git stacks" },
		});
		const envs = await h.call(
			"GET",
			`/api/projects/${project.json.id}/environments`,
			as(),
		);
		envId = envs.json[0].id;
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
		const privateKey = `-----BEGIN PRIVATE KEY-----\n${der.toBase64().match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
		const [org] = await h.deps.db.select().from(organization);
		const [row] = await h.deps.db
			.insert(gitProvider)
			.values({
				organizationId: org?.id ?? "",
				kind: "github",
				name: "GitHub",
				configEncrypted: await encrypt(
					h.deps.masterKey,
					JSON.stringify({
						appId: "1",
						privateKey,
						webhookSecret: "hook-secret",
						installationId: "2",
					}),
				),
			})
			.returning();
		providerId = row?.id ?? "";
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
			const u = new URL(url);
			if (u.pathname === "/repos/acme/infra/contents/deploy/compose.yml") {
				const ref = u.searchParams.get("ref") ?? "";
				reads.push(ref);
				const body = files.get(ref);
				return body === undefined
					? new Response("Not Found", { status: 404 })
					: new Response(body);
			}
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;
	}, 60_000);
	afterAll(async () => {
		globalThis.fetch = real;
		await h?.close();
	});

	const push = async (o: { branch: string; message?: string }) => {
		const payload = {
			ref: `refs/heads/${o.branch}`,
			after: SHA,
			repository: { full_name: "acme/infra" },
			head_commit: { id: SHA, message: o.message ?? "chore: bump web" },
			commits: [{ modified: ["deploy/compose.yml"] }],
		};
		const raw = JSON.stringify(payload);
		return h.call("POST", `/api/webhooks/git/${providerId}`, {
			body: payload,
			headers: {
				"x-github-event": "push",
				"x-hub-signature-256": `sha256=${(await hmacSha256("hook-secret", raw)).toHex()}`,
			},
		});
	};

	const git = () => ({
		gitProviderId: providerId,
		repository: "acme/infra",
		branch: "main",
		composePath: "deploy/compose.yml",
	});

	test("a stack is created from the compose file at the head of the branch", async () => {
		files.set("main", V1);
		const res = await h.call("POST", `/api/environments/${envId}/stacks/git`, {
			...as(),
			body: { name: "infra", git: git() },
		});
		expect(res.status).toBe(201);
		stackId = res.json.stackId;
		const detail = await h.call("GET", `/api/stacks/${stackId}`, as());
		expect(detail.json).toMatchObject({
			source: "git",
			git: git(),
			composeYaml: V1,
		});
		expect(detail.json.services).toHaveLength(2);
	});

	test("a git stack refuses hand edits", async () => {
		const res = await h.call("PUT", `/api/stacks/${stackId}/compose`, {
			...as(),
			body: { composeYaml: V2 },
		});
		expect(res.status).toBe(400);
		expect(res.json.error.message).toContain("push the change");
	});

	test("a push to the branch re-syncs the stack from the pushed commit", async () => {
		files.set(SHA, V2);
		const res = await push({ branch: "main" });
		expect(res.status).toBe(200);
		expect(res.json.outcome).toBe("deployed");
		expect(reads.at(-1)).toBe(SHA);
		expect(res.json.deployments).toHaveLength(1);
		const [d] = await h.deps.db
			.select()
			.from(deployment)
			.where(eq(deployment.id, res.json.deployments[0]));
		expect(d).toMatchObject({ trigger: "git_push", commitSha: SHA });
		const detail = await h.call("GET", `/api/stacks/${stackId}`, as());
		expect(detail.json.composeYaml).toBe(V2);
		expect(detail.json.effectiveCompose).toContain("nginx:1.29");
	});

	test("the same push again deploys nothing; other branches and skip markers are ignored", async () => {
		const again = await push({ branch: "main" });
		expect(again.status).toBe(202);
		expect(again.json.deployments).toEqual([]);
		const before = reads.length;
		expect((await push({ branch: "dev" })).json.outcome).toBe("ignored");
		await push({ branch: "main", message: "wip [skip deploy]" });
		expect(reads.length).toBe(before);
	});

	test("an unsupported compose in a push leaves the stack as it was and says why", async () => {
		files.set(SHA, "services:\n  web:\n    build: .\n");
		const res = await push({ branch: "main" });
		expect(res.json.reason).toContain("stack infra");
		const detail = await h.call("GET", `/api/stacks/${stackId}`, as());
		expect(detail.json.composeYaml).toBe(V2);
	});

	test("sync previews with dryRun, then applies the head of the branch", async () => {
		files.set("main", V1);
		const preview = await h.call(
			"POST",
			`/api/stacks/${stackId}/sync?dryRun=true`,
			as(),
		);
		expect(preview.status).toBe(200);
		expect(preview.json.changes).toEqual([
			{
				service: "web",
				op: "update",
				changes: ["image nginx:1.29 → nginx:1.28"],
			},
		]);
		expect(preview.json.services).toEqual([]);
		const applied = await h.call("POST", `/api/stacks/${stackId}/sync`, as());
		expect(applied.json.services).toHaveLength(1);
		const detail = await h.call("GET", `/api/stacks/${stackId}`, as());
		expect(detail.json.composeYaml).toBe(V1);
	});

	test("a missing file is a 422 and creates nothing", async () => {
		const res = await h.call("POST", `/api/environments/${envId}/stacks/git`, {
			...as(),
			body: { name: "other", git: { ...git(), branch: "nope" } },
		});
		expect(res.status).toBe(422);
		const stacks = await h.call(
			"GET",
			`/api/environments/${envId}/stacks`,
			as(),
		);
		expect(stacks.json).toHaveLength(1);
	});
});
