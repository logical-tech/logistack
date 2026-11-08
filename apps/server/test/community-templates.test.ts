import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, service, stack } from "@logistack/db";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

// Phase 0 of docs/plans/plugins.md: a signed community index served by Bun.serve, fetched
// only on Refresh, merged into the catalog and deployable like a built-in template.

/** Not in the release's catalog. */
const tiny = {
	schema: 1,
	id: "zz-community-echo",
	name: "Tiny Echo",
	description: "An HTTP echo server from the community index.",
	category: "devtools",
	tags: ["http"],
	logo: "logos/adminer.svg",
	version: "1.0.0",
	source: { kind: "dokploy", path: "community/tiny-echo", license: "MIT" },
	inputs: [
		{
			key: "mainDomain",
			label: "Main domain",
			type: "domain",
			role: "primary",
		},
	],
	services: [
		{
			name: "web",
			dependsOn: [],
			env: { GREETING: "hello" },
			volumes: [],
			files: [],
			kind: "application",
			image: "hashicorp/http-echo:1.0",
			ports: [{ target: 5678, protocol: "tcp" }],
			public: { port: 5678, domain: "mainDomain" },
			restart: "any",
		},
	],
};

describe.skipIf(!hasDocker)("community templates", () => {
	let h: Harness;
	let cookie: string;
	let envId: string;
	let index: ReturnType<typeof Bun.serve>;
	let body = "";
	let pub = "";
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
			"sign",
			"verify",
		])) as unknown as CryptoKeyPair;
		pub = Buffer.from(
			await crypto.subtle.exportKey("raw", keys.publicKey),
		).toString("base64url");
		// The plugin index envelope: keyId is the signer's public key.
		const payload = JSON.stringify([
			tiny,
			{ ...tiny, id: "umami" },
			{ id: "broken" },
		]);
		const signature = Buffer.from(
			await crypto.subtle.sign(
				{ name: "Ed25519" },
				keys.privateKey,
				new TextEncoder().encode(payload),
			),
		).toString("base64url");
		body = JSON.stringify({ keyId: pub, payload, signature });
		index = Bun.serve({ port: 0, fetch: () => new Response(body) });
		h = await startHarness({
			area: "plugtpl",
			label: "plugtpl",
			env: {
				LS_TEMPLATE_INDEX_URL: `${index.url.href}v1/index`,
				LS_TEMPLATE_INDEX_KEYS: pub,
			},
		});
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call("POST", "/api/projects", {
			...as(),
			body: { name: "Community" },
		});
		envId = (
			await h.call("GET", `/api/projects/${project.json.id}/environments`, as())
		).json[0].id;
	}, 60_000);
	afterAll(async () => {
		index?.stop(true);
		await h?.close();
	});

	test("nothing community is listed before a Refresh", async () => {
		const status = await h.call("GET", "/api/templates/community", as());
		expect(status.json).toMatchObject({
			configured: true,
			fetchedAt: null,
			templates: 0,
		});
		const list = await h.call("GET", "/api/templates?q=zz-community", as());
		expect(list.json).toEqual([]);
		expect(
			(await h.call("GET", "/api/templates/zz-community-echo", as())).status,
		).toBe(404);
	});

	test("Refresh verifies, skips bad and shadowing entries, and caches", async () => {
		const res = await h.call("POST", "/api/templates/community/refresh", as());
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({
			source: "localhost",
			keyId: pub,
			templates: 1,
			skipped: 2,
		});
		const list = await h.call("GET", "/api/templates?q=zz-community", as());
		expect(list.json).toEqual([
			expect.objectContaining({
				id: "zz-community-echo",
				source: "community",
				community: { source: "localhost" },
			}),
		]);
		// The built-in umami is still the release's.
		const umami = await h.call("GET", "/api/templates/umami", as());
		expect(umami.json.source.kind).not.toBe("community");
		const t = await h.call("GET", "/api/templates/zz-community-echo", as());
		expect(t.json.source.kind).toBe("community");
		expect(t.json.logo).toBeUndefined();
	});

	test("a tampered index is refused and the cache is kept", async () => {
		const good = body;
		const e = JSON.parse(good);
		body = JSON.stringify({
			...e,
			payload: e.payload.replace("hello", "pwned"),
		});
		const res = await h.call("POST", "/api/templates/community/refresh", as());
		expect(res.status).toBe(400);
		expect(res.json.error.message).toContain("does not verify");
		body = good;
		const status = await h.call("GET", "/api/templates/community", as());
		expect(status.json.templates).toBe(1);
	});

	test("a community template deploys like a built-in one, with its source in the provenance", async () => {
		const res = await h.call(
			"POST",
			`/api/environments/${envId}/templates/zz-community-echo`,
			{ ...as(), body: { inputs: {} } },
		);
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({
			created: true,
			templateId: "zz-community-echo",
		});
		const rows = await h.deps.db
			.select()
			.from(service)
			.where(eq(service.environmentId, envId));
		expect(rows.map((r) => [r.slug, r.importedFrom])).toEqual([
			["web", "template:zz-community-echo@localhost:zz-community-echo/web"],
		]);
		const [st] = await h.deps.db
			.select()
			.from(stack)
			.where(eq(stack.environmentId, envId));
		expect(st?.templateId).toBe("zz-community-echo");
		const audits = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "template.index_refresh"));
		// The refused Refresh is audited too.
		expect(audits.length).toBe(2);
	});
});
