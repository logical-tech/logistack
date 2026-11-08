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

const SHA1 = "c0ffee0000000000000000000000000000000001";
const SHA2 = "c0ffee0000000000000000000000000000000002";
const SHA3 = "c0ffee0000000000000000000000000000000003";
const PATH = "deploy/logistack.yaml";

describe.skipIf(!hasDocker)("gitops", () => {
	let h: Harness;
	let cookie: string;
	let projectId: string;
	let serviceId: string;
	let providerId: string;
	let manifest: string;
	/** What the mocked GitHub serves for the manifest, by ref. */
	const files = new Map<string, string>();
	const real = globalThis.fetch;
	const call = (method: string, path: string, body?: unknown) =>
		h.call(method, `/api${path}`, { headers: { cookie }, body });

	beforeAll(async () => {
		h = await startHarness({ area: "gitops", label: "gitops" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		projectId = (await call("POST", "/projects", { name: "Infra" })).json.id;
		const env = (await call("GET", `/projects/${projectId}/environments`))
			.json[0].id;
		serviceId = (
			await call("POST", `/environments/${env}/services`, {
				name: "Web",
				spec: {
					kind: "application",
					source: { type: "image", image: "nginx:1.27" },
					build: { type: "image" },
					ports: [{ target: 80, protocol: "tcp" }],
					replicas: 1,
					resources: { memoryMb: 128 },
					placement: [],
				},
			})
		).json.id;
		manifest = (
			await call("GET", `/projects/${projectId}/manifest?format=yaml`)
		).json as string;
		files.set("main", manifest);
		files.set(SHA1, manifest);
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
		const privateKey = `-----BEGIN PRIVATE KEY-----\n${der
			.toBase64()
			.match(/.{1,64}/g)
			?.join("\n")}\n-----END PRIVATE KEY-----\n`;
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
			if (u.pathname === `/repos/acme/infra/contents/${PATH}`) {
				const body = files.get(u.searchParams.get("ref") ?? "");
				return body === undefined
					? new Response("Not Found", { status: 404 })
					: new Response(body);
			}
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;
	}, 90_000);
	afterAll(async () => {
		globalThis.fetch = real;
		await h?.close();
	});

	const push = async (sha: string, modified = [PATH]) => {
		const payload = {
			ref: "refs/heads/main",
			after: sha,
			repository: { full_name: "acme/infra" },
			head_commit: { id: sha, message: "chore: infra" },
			commits: [{ modified }],
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
	const source = () => ({
		gitProviderId: providerId,
		repository: "acme/infra",
		branch: "main",
		path: PATH,
	});

	test("the wizard's check reads the file and plans no change for the exported state", async () => {
		const res = await call(
			"POST",
			`/projects/${projectId}/gitops/check`,
			source(),
		);
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ changes: [], warnings: [] });
		const missing = await call("POST", `/projects/${projectId}/gitops/check`, {
			...source(),
			path: "nope.yaml",
		});
		expect(missing.status).toBe(422);
		expect(missing.json.error.message).toContain(
			"couldn't read acme/infra@main:nope.yaml",
		);
	});

	test("a managed project refuses manual edits with a pointer to the repository", async () => {
		const link = await call("PUT", `/projects/${projectId}/gitops`, {
			...source(),
			managed: true,
		});
		expect(link.status).toBe(200);
		expect(link.json).toMatchObject({
			managed: true,
			autoApply: true,
			lastStatus: null,
		});
		const edit = await call("PATCH", `/services/${serviceId}`, {
			name: "Renamed",
		});
		expect(edit.status).toBe(409);
		expect(edit.json.error.message).toContain(
			"managed by git: change deploy/logistack.yaml in acme/infra (main)",
		);
		const vars = await call("PUT", `/services/${serviceId}/env-vars`, {
			variables: [],
		});
		expect(vars.status).toBe(409);
		// Secrets never live in the repository: they stay editable.
		const s = await call("POST", "/secrets", {
			scope: "project",
			scopeId: projectId,
			key: "API_TOKEN",
			value: "t0ken",
		});
		expect(s.status).toBe(201);
		// Deploying is not an edit.
		expect((await call("POST", `/services/${serviceId}/deploy`)).status).toBe(
			202,
		);
	});

	test("a push that changes the manifest applies it and deploys the changed service", async () => {
		files.set(SHA2, manifest.replace("replicas: 1", "replicas: 3"));
		const before = await h.deps.db.$count(
			deployment,
			eq(deployment.serviceId, serviceId),
		);
		const res = await push(SHA2);
		expect(res.status).toBe(200);
		expect(res.json.gitops).toEqual([
			{
				projectId,
				status: "applied",
				commitSha: SHA2,
				changes: 1,
				deployments: [expect.any(String)],
			},
		]);
		const svc = (await call("GET", `/services/${serviceId}`)).json;
		expect(svc.spec.replicas).toBe(3);
		expect(
			await h.deps.db.$count(deployment, eq(deployment.serviceId, serviceId)),
		).toBe(before + 1);
		// A push that leaves the file alone does nothing to the project.
		const other = await push(SHA2, ["README.md"]);
		expect(other.json.gitops).toBeUndefined();
	});

	test("a broken manifest fails the sync, changes nothing and shows the error on the link", async () => {
		files.set(SHA3, "kind: project\nversion: 1\nproject: {}\n");
		const res = await push(SHA3);
		expect(res.json.gitops[0]).toMatchObject({
			status: "failed",
			commitSha: SHA3,
		});
		const link = (await call("GET", `/projects/${projectId}/gitops`)).json;
		expect(link.lastStatus).toBe("failed");
		expect(link.lastError.message).toContain("not a valid manifest");
		expect(link.lastError.commitSha).toBe(SHA3);
		expect(
			(await call("GET", `/services/${serviceId}`)).json.spec.replicas,
		).toBe(3);
	});

	test("syncing by hand reapplies the branch head; unlinking takes manual edits again", async () => {
		const res = await call("POST", `/projects/${projectId}/gitops/sync`);
		expect(res.status).toBe(200);
		// main still serves the original manifest: replicas go back to 1.
		expect(res.json).toMatchObject({ status: "applied", changes: 1 });
		expect(
			(await call("GET", `/projects/${projectId}/gitops`)).json.lastError,
		).toBeNull();
		expect((await call("DELETE", `/projects/${projectId}/gitops`)).status).toBe(
			204,
		);
		const edit = await call("PATCH", `/services/${serviceId}`, {
			name: "Renamed",
		});
		expect(edit.status).toBe(200);
	});
});
