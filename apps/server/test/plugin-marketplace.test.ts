import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	PLUGIN_MANIFEST_LABEL,
	type PluginManifestInput,
} from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import { apikey, organizationRole, pluginInstall } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

// Marketplace client end to end against a fake signed index and a fake registry on loopback:
// trusting an index, signature checks, install from the index, the verified policy, updates with
// a permission diff and token rotation, rollback, yanked flags and the `logistack` range.

const sha = (s: string) =>
	new Bun.CryptoHasher("sha256").update(s).digest("hex");

type Version = {
	manifest: PluginManifestInput & { version: string };
	/** What the registry's label says, when it differs from the signed manifest. */
	label?: PluginManifestInput;
	verified: boolean;
	yanked: boolean;
	changelog?: string;
};

const base = (id: string, version: string): Version["manifest"] => ({
	id,
	version,
	name: id === "com.acme.hello" ? "Hello" : "Raw",
	permissions: ["read"],
	egress: ["api.acme.com"],
});

describe.skipIf(!hasDocker)("plugin marketplace", () => {
	let h: Harness;
	let cookie: string;
	let registry: ReturnType<typeof Bun.serve>;
	let index: ReturnType<typeof Bun.serve>;
	let signer: CryptoKeyPair;
	/** When set, responses are signed with it while still naming the trusted key. */
	let forger: CryptoKeyPair | null = null;
	let publicKey: string;
	let indexId: string;
	let installId: string;
	const as = () => ({ headers: { cookie } });
	const plugins: Record<string, Version[]> = {
		"com.acme.hello": [
			{
				manifest: base("com.acme.hello", "1.0.0"),
				verified: true,
				yanked: false,
			},
			{
				manifest: {
					...base("com.acme.hello", "1.1.0"),
					permissions: ["read", "write"],
					egress: ["api.acme.com", "hooks.acme.com"],
				},
				verified: true,
				yanked: false,
				changelog: "Writes back.",
			},
			{
				manifest: { ...base("com.acme.hello", "1.2.0"), logistack: ">=9.0.0" },
				verified: true,
				yanked: false,
			},
		],
		"com.acme.raw": [
			{
				manifest: base("com.acme.raw", "1.0.0"),
				// The image in the registry asks for more than the index signed.
				label: { ...base("com.acme.raw", "1.0.0"), permissions: ["admin"] },
				verified: false,
				yanked: false,
			},
		],
	};
	const imageOf = (id: string, v: string) =>
		`127.0.0.1:${registry.port}/acme/${id}@sha256:${sha(`${id}@${v}`)}`;
	const sign = async (payload: string) =>
		Buffer.from(
			await crypto.subtle.sign(
				"Ed25519",
				(forger ?? signer).privateKey,
				new TextEncoder().encode(payload),
			),
		).toString("base64url");
	const envelope = async (body: unknown) => {
		const payload = JSON.stringify(body);
		return Response.json({
			payload,
			keyId: publicKey,
			signature: await sign(payload),
		});
	};
	const versionOf = (id: string, v: Version) => ({
		version: v.manifest.version,
		image: imageOf(id, v.manifest.version),
		manifest: v.manifest,
		verified: v.verified,
		yanked: v.yanked,
		iconUrl: null,
		changelog: v.changelog,
		publishedAt: "2026-11-01T00:00:00Z",
	});
	const newestFirst = (versions: Version[]) => [...versions].reverse();

	beforeAll(async () => {
		h = await startHarness({
			area: "plugmkt",
			label: "plugmkt",
			// The official index stays off the network: nothing listens on port 9.
			env: {
				LOGISTACK_VERSION: "0.6.0",
				LS_PLUGIN_INDEX_URL: "http://127.0.0.1:9/plugins/api",
			},
		});
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		await h.call("PATCH", "/api/instance/settings", {
			...as(),
			body: { allowPrivateHosts: true },
		});
		signer = (await crypto.subtle.generateKey("Ed25519", true, [
			"sign",
			"verify",
		])) as CryptoKeyPair;
		publicKey = Buffer.from(
			await crypto.subtle.exportKey("raw", signer.publicKey),
		).toString("base64url");
		registry = Bun.serve({
			port: 0,
			fetch(req) {
				const path = new URL(req.url).pathname;
				for (const [id, versions] of Object.entries(plugins))
					for (const v of versions) {
						const digest = `sha256:${sha(`${id}@${v.manifest.version}`)}`;
						const cfg = `sha256:${sha(`cfg ${id}@${v.manifest.version}`)}`;
						if (path === `/v2/acme/${id}/manifests/${digest}`)
							return Response.json(
								{ config: { digest: cfg } },
								{ headers: { "docker-content-digest": digest } },
							);
						if (path === `/v2/acme/${id}/blobs/${cfg}`)
							return Response.json({
								config: {
									Labels: {
										[PLUGIN_MANIFEST_LABEL]: JSON.stringify(
											v.label ?? v.manifest,
										),
									},
								},
							});
					}
				return new Response("not found", { status: 404 });
			},
		});
		index = Bun.serve({
			port: 0,
			async fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === "/v1/index")
					return envelope({
						v: 1,
						kind: "index",
						issuedAt: new Date().toISOString(),
						plugins: Object.entries(plugins).map(([id, versions]) => {
							const listed = newestFirst(versions).filter((v) => !v.yanked);
							const latest = listed[0];
							const verified = listed.find((v) => v.verified);
							return {
								id,
								publisher: "Acme",
								installs: 3,
								latest: latest ? versionOf(id, latest) : null,
								latestVerified: verified ? versionOf(id, verified) : null,
								yanked: versions
									.filter((v) => v.yanked)
									.map((v) => ({
										version: v.manifest.version,
										image: imageOf(id, v.manifest.version),
									})),
							};
						}),
					});
				const m = /^\/v1\/plugins\/([^/]+)$/.exec(path);
				const id = decodeURIComponent(m?.[1] ?? "");
				const versions = plugins[id];
				if (versions)
					return envelope({
						v: 1,
						kind: "plugin",
						issuedAt: new Date().toISOString(),
						plugin: {
							id,
							publisher: "Acme",
							installs: 3,
							versions: newestFirst(versions).map((v) => versionOf(id, v)),
						},
					});
				return new Response("not found", { status: 404 });
			},
		});
	}, 120_000);

	afterAll(async () => {
		index?.stop(true);
		registry?.stop(true);
		await h?.close();
	});

	test("an index is trusted only when its signature checks out", async () => {
		const other = (await crypto.subtle.generateKey("Ed25519", true, [
			"sign",
			"verify",
		])) as CryptoKeyPair;
		const wrong = Buffer.from(
			await crypto.subtle.exportKey("raw", other.publicKey),
		).toString("base64url");
		const bad = await h.call("POST", "/api/plugins/indexes", {
			...as(),
			body: { url: index.url.href, publicKeys: [wrong] },
		});
		expect(bad.status).toBe(400);
		expect(bad.json.error.message).toContain("does not trust");

		const res = await h.call("POST", "/api/plugins/indexes", {
			...as(),
			body: { url: index.url.href, publicKeys: [publicKey] },
		});
		expect(res.status).toBe(201);
		expect(res.json.name).toBe(index.url.host);
		expect(res.json.plugins).toBe(2);
		indexId = res.json.id;

		const list = await h.call("GET", "/api/plugins/indexes", as());
		expect(list.json.map((i: { builtin: boolean }) => i.builtin)).toEqual([
			true,
			false,
		]);
	});

	test("a refresh with a bad signature is rejected and keeps the cache", async () => {
		forger = (await crypto.subtle.generateKey("Ed25519", true, [
			"sign",
			"verify",
		])) as CryptoKeyPair;
		const res = await h.call(
			"POST",
			`/api/plugins/indexes/${indexId}/refresh`,
			as(),
		);
		forger = null;
		expect(res.status).toBe(400);
		const list = await h.call("GET", "/api/plugins/indexes", as());
		const row = list.json.find((i: { id: string }) => i.id === indexId);
		expect(row.lastError).toContain("bad signature");
		expect(row.plugins).toBe(2);
	});

	test("the marketplace merges cached entries; an unreachable official index records its error", async () => {
		const res = await h.call("GET", "/api/plugins/marketplace", as());
		expect(res.status).toBe(200);
		const hello = res.json.entries.find(
			(e: { id: string }) => e.id === "com.acme.hello",
		);
		expect(hello.verified).toBe(true);
		expect(hello.latest.version).toBe("1.2.0");
		expect(hello.compatible).toBe(false);
		expect(hello.installed).toBeNull();
		const official = res.json.indexes.find(
			(i: { builtin: boolean }) => i.builtin,
		);
		expect(official.lastError).toBeTruthy();
		expect(official.publicKeys.length).toBeGreaterThan(0);
	});

	test("the verified policy refuses unverified entries and images, allows verified ones", async () => {
		await h.call("PUT", "/api/plugins/policy", {
			...as(),
			body: { policy: "verified" },
		});
		const raw = await h.call("POST", "/api/plugins/inspect", {
			...as(),
			body: {
				kind: "index",
				indexId,
				pluginId: "com.acme.raw",
				version: "1.0.0",
			},
		});
		expect(raw.status).toBe(403);
		const image = await h.call("POST", "/api/plugins/inspect", {
			...as(),
			body: { kind: "image", image: imageOf("com.acme.hello", "1.0.0") },
		});
		expect(image.status).toBe(403);

		const res = await h.call("POST", "/api/plugins", {
			...as(),
			body: {
				source: {
					kind: "index",
					indexId,
					pluginId: "com.acme.hello",
					version: "1.0.0",
				},
			},
		});
		expect(res.status).toBe(201);
		installId = res.json.id;
		expect(res.json.indexId).toBe(indexId);
		expect(res.json.verified).toBe(true);
		expect(res.json.image).toBe(imageOf("com.acme.hello", "1.0.0"));
		await h.call("PUT", "/api/plugins/policy", {
			...as(),
			body: { policy: "any" },
		});
	});

	test("an image whose label differs from the signed manifest is refused", async () => {
		const res = await h.call("POST", "/api/plugins/inspect", {
			...as(),
			body: {
				kind: "index",
				indexId,
				pluginId: "com.acme.raw",
				version: "1.0.0",
			},
		});
		expect(res.status).toBe(409);
		expect(res.json.error.message).toContain("differs");
	});

	test("updates list newer versions with their permission and egress diff", async () => {
		const res = await h.call("GET", `/api/plugins/${installId}/updates`, as());
		expect(res.status).toBe(200);
		expect(
			res.json.versions.map((v: { version: string }) => v.version),
		).toEqual(["1.2.0", "1.1.0"]);
		const next = res.json.versions[1];
		expect(next.permissions).toEqual({ added: ["write"], removed: [] });
		expect(next.egress).toEqual({ added: ["hooks.acme.com"], removed: [] });
		expect(next.changelog).toBe("Writes back.");
		expect(res.json.versions[0].compatible).toBe(false);
	});

	test("an incompatible logistack range is refused", async () => {
		const res = await h.call("POST", `/api/plugins/${installId}/update`, {
			...as(),
			body: { version: "1.2.0", acceptPermissions: true },
		});
		expect(res.status).toBe(409);
		expect(res.json.error.message).toContain("needs LogiStack >=9.0.0");
	});

	const state = async () => {
		const [row] = await h.deps.db
			.select()
			.from(pluginInstall)
			.where(eq(pluginInstall.id, installId));
		if (!row) throw new Error("install gone");
		const keys = await h.deps.db
			.select({ id: apikey.id })
			.from(apikey)
			.where(eq(apikey.referenceId, row.serviceAccountId ?? ""));
		const [role] = await h.deps.db
			.select({ permission: organizationRole.permission })
			.from(organizationRole)
			.where(
				and(
					eq(organizationRole.organizationId, row.organizationId),
					eq(organizationRole.role, `plugin:${installId.slice(4)}`),
				),
			);
		return {
			row,
			keys: keys.map((k) => k.id),
			token: await decrypt(h.deps.masterKey, row.tokenEncrypted ?? ""),
			actions: JSON.parse(role?.permission ?? "{}").logistack,
		};
	};

	test("an update that adds a permission needs consent, then rotates the token and the role", async () => {
		const before = await state();
		expect(before.actions).toEqual(["read"]);
		const refused = await h.call("POST", `/api/plugins/${installId}/update`, {
			...as(),
			body: { version: "1.1.0" },
		});
		expect(refused.status).toBe(409);
		expect(refused.json.error.details.permissions.added).toEqual(["write"]);

		const res = await h.call("POST", `/api/plugins/${installId}/update`, {
			...as(),
			body: { version: "1.1.0", acceptPermissions: true },
		});
		expect(res.status).toBe(200);
		expect(res.json.version).toBe("1.1.0");
		expect(res.json.previousVersion).toBe("1.0.0");
		const after = await state();
		expect(after.actions).toEqual(["read", "write"]);
		expect(after.token).not.toBe(before.token);
		expect(after.keys).toHaveLength(1);
		expect(after.keys).not.toContain(before.keys[0]);
		expect(after.row.image).toBe(imageOf("com.acme.hello", "1.1.0"));
		// The old token no longer works.
		const old = await h.call("GET", "/api/plugins/self", {
			headers: { "x-api-key": before.token },
		});
		expect(old.status).toBe(401);
	});

	test("rollback returns to the previous digest and permissions", async () => {
		const res = await h.call(
			"POST",
			`/api/plugins/${installId}/rollback`,
			as(),
		);
		expect(res.status).toBe(200);
		expect(res.json.version).toBe("1.0.0");
		expect(res.json.previousVersion).toBe("1.1.0");
		expect(res.json.verified).toBe(true);
		const s = await state();
		expect(s.actions).toEqual(["read"]);
		expect(s.row.image).toBe(imageOf("com.acme.hello", "1.0.0"));
	});

	test("a yanked version is flagged at the next refresh, never removed", async () => {
		(plugins["com.acme.hello"]?.[0] as Version).yanked = true;
		const res = await h.call(
			"POST",
			`/api/plugins/indexes/${indexId}/refresh`,
			as(),
		);
		expect(res.status).toBe(200);
		const p = await h.call("GET", `/api/plugins/${installId}`, as());
		expect(p.status).toBe(200);
		expect(p.json.yanked).toBe(true);
		expect(p.json.version).toBe("1.0.0");
	});

	test("the official index cannot be removed; a private one can", async () => {
		const list = await h.call("GET", "/api/plugins/indexes", as());
		const official = list.json.find((i: { builtin: boolean }) => i.builtin);
		expect(
			(await h.call("DELETE", `/api/plugins/indexes/${official.id}`, as()))
				.status,
		).toBe(409);
		expect(
			(await h.call("DELETE", `/api/plugins/indexes/${indexId}`, as())).status,
		).toBe(204);
		const p = await h.call("GET", `/api/plugins/${installId}`, as());
		expect(p.json.indexId).toBeNull();
	});
});
