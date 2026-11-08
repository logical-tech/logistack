import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	readPluginDetail,
	readPluginIndex,
	verifyIndexResponse,
} from "../../packages/core/src/plugin-index.ts";
import { type Env, handle } from "../src/index.ts";
import { compareVersions } from "../src/public.ts";
import { fakeD1 } from "./d1.ts";

const ORIGIN = "https://stack.test";
const BASE = "/plugins/api";

const pair = (await crypto.subtle.generateKey("Ed25519", true, [
	"sign",
	"verify",
])) as CryptoKeyPair;
const pkcs8 = Buffer.from(
	await crypto.subtle.exportKey("pkcs8", pair.privateKey),
).toString("base64url");
const publicKey = Buffer.from(
	await crypto.subtle.exportKey("raw", pair.publicKey),
).toString("base64url");

const sha = (s: string) =>
	`sha256:${createHash("sha256").update(s).digest("hex")}`;

/** A public registry holding one multi-arch image per manifest, behind an anonymous token. */
function registry() {
	const blobs = new Map<string, string>();
	const put = (doc: unknown) => {
		const text = JSON.stringify(doc);
		blobs.set(sha(text), text);
		return sha(text);
	};
	const image = (label: unknown) => {
		const config = put({
			config: {
				Labels: { "io.logistack.plugin.manifest": JSON.stringify(label) },
			},
		});
		const amd = put({ config: { digest: config } });
		const arm = put({ config: { digest: config } });
		const att = put({ layers: [] });
		const index = put({
			manifests: [
				{ digest: amd, platform: { os: "linux", architecture: "amd64" } },
				{ digest: arm, platform: { os: "linux", architecture: "arm64" } },
				{ digest: att, platform: { os: "unknown", architecture: "unknown" } },
			],
		});
		return `ghcr.io/acme/notifier@${index}`;
	};
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = new URL(String(input));
		if (url.pathname === "/token") return Response.json({ token: "anon" });
		const auth = new Headers(init?.headers).get("authorization");
		if (auth !== "Bearer anon")
			return new Response("", {
				status: 401,
				headers: {
					"www-authenticate":
						'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
				},
			});
		const digest = url.pathname.split("/").at(-1) ?? "";
		const body = blobs.get(digest);
		return body ? new Response(body) : new Response("", { status: 404 });
	}) as typeof fetch;
	return { image, fetchFn };
}

const manifest = (version = "1.0.0", extra: Record<string, unknown> = {}) => ({
	id: "com.acme.notifier",
	version,
	name: "Notifier",
	permissions: ["read"],
	...extra,
});

let env: Env;
let sql: ReturnType<typeof fakeD1>["db"];
let mails: string[];
const realFetch = globalThis.fetch;
const reg = registry();

beforeEach(() => {
	const f = fakeD1();
	sql = f.db;
	mails = [];
	env = {
		PLUGIN_INDEX: f.d1,
		SIGNING_KEY: pkcs8,
		RESEND_API_KEY: "re_test",
		BASE_PATH: BASE,
		PUBLIC_ORIGIN: ORIGIN,
		EMAIL_FROM: "plugins@stack.test",
	};
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		if (!String(url).startsWith("https://api.resend.com/"))
			return realFetch(url, init);
		mails.push(JSON.parse(String(init?.body)).text);
		return Response.json({ id: "e1" });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

type Opts = {
	body?: unknown;
	form?: Record<string, string>;
	cookie?: string;
	token?: string;
	origin?: string;
};
function call(method: string, path: string, o: Opts = {}) {
	const headers: Record<string, string> = {};
	let body: string | undefined;
	if (o.form) {
		headers["content-type"] = "application/x-www-form-urlencoded";
		body = new URLSearchParams(o.form).toString();
	} else if (o.body !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(o.body);
	}
	if (o.cookie) headers.cookie = o.cookie;
	if (o.token) headers.authorization = `Bearer ${o.token}`;
	if (method !== "GET" && (o.cookie || o.form))
		headers.origin = o.origin ?? ORIGIN;
	return handle(
		new Request(`${ORIGIN}${BASE}${path}`, { method, headers, body }),
		env,
		reg.fetchFn,
	);
}

async function signIn(email: string) {
	await call("POST", "/auth/login", { form: { email } });
	const link = /https:\S+/.exec(mails.at(-1) ?? "")?.[0] ?? "";
	const token = new URL(link).searchParams.get("token") ?? "";
	// The link itself only shows a button: fetching it twice spends nothing.
	expect((await call("GET", `/auth/callback?token=${token}`)).status).toBe(200);
	const res = await call("POST", "/auth/callback", { form: { token } });
	expect(res.status).toBe(303);
	const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	await call("POST", "/me", {
		form: { name: email.split("@")[0] ?? "x" },
		cookie,
	});
	const t = await call("POST", "/me/tokens", { body: { name: "cli" }, cookie });
	const { token: api } = (await t.json()) as { token: string };
	return { cookie, api };
}

async function index() {
	const res = await call("GET", "/v1/index");
	const check = await verifyIndexResponse(await res.text(), [publicKey]);
	if (!check.ok) throw new Error(check.reason);
	return readPluginIndex(check.payload);
}

test("publish, review, yank: what a server reads at each step", async () => {
	const acme = await signIn("dev@acme.test");
	expect(
		(
			await call("POST", "/me/plugins", {
				body: { id: "com.acme.notifier" },
				token: acme.api,
			})
		).status,
	).toBe(200);

	// Free only: payment-shaped keys are refused, not dropped.
	const paid = await call("POST", "/me/plugins/com.acme.notifier/versions", {
		token: acme.api,
		body: {
			image: reg.image(manifest()),
			manifest: manifest("1.0.0", { price: 5 }),
		},
	});
	expect(paid.status).toBe(422);
	expect(((await paid.json()) as { error: string }).error).toContain("price");

	const ok = await call("POST", "/me/plugins/com.acme.notifier/versions", {
		token: acme.api,
		body: {
			image: reg.image(manifest()),
			manifest: manifest(),
			readme: "# Notifier",
		},
	});
	expect(await ok.json()).toMatchObject({
		status: "unverified",
		version: "1.0.0",
	});

	// The image label says 1.0.0 but the submission says 1.1.0: rejected with the reason.
	const bad = await call("POST", "/me/plugins/com.acme.notifier/versions", {
		token: acme.api,
		body: { image: reg.image(manifest()), manifest: manifest("1.1.0") },
	});
	expect(await bad.json()).toMatchObject({
		status: "rejected",
		notes: expect.stringContaining("differs"),
	});

	let idx = await index();
	expect(idx?.plugins).toHaveLength(1);
	expect(idx?.plugins[0]).toMatchObject({
		id: "com.acme.notifier",
		publisher: "dev",
		latest: { version: "1.0.0", verified: false, yanked: false },
		latestVerified: null,
	});

	const admin = await signIn("root@logicaltech.test");
	sql.run(
		"INSERT INTO admins (email, created_at) VALUES ('root@logicaltech.test', 0)",
	);
	expect((await call("GET", "/admin", { cookie: acme.cookie })).status).toBe(
		403,
	);
	const q = (await (
		await call("GET", "/admin/queue", { token: admin.api })
	).json()) as {
		versions: { id: string; version: string }[];
	};
	const v1 = q.versions.find((v) => v.version === "1.0.0")?.id ?? "";
	await call("POST", `/admin/versions/${v1}/checks`, {
		token: admin.api,
		body: { contract: { ok: true }, trivy: { critical: 0 } },
	});
	expect(
		(
			await call("POST", `/admin/versions/${v1}/verify`, {
				form: { commit: "abc1234" },
				cookie: admin.cookie,
			})
		).status,
	).toBe(303);

	const v2 = (await (
		await call("POST", "/me/plugins/com.acme.notifier/versions", {
			token: acme.api,
			body: {
				image: reg.image(manifest("1.1.0")),
				manifest: manifest("1.1.0"),
			},
		})
	).json()) as { id: string; status: string };
	expect(v2.status).toBe("unverified");
	idx = await index();
	expect(idx?.plugins[0]?.latest?.version).toBe("1.1.0");
	expect(idx?.plugins[0]?.latestVerified?.version).toBe("1.0.0");

	await call("POST", `/admin/versions/${v1}/yank`, {
		body: { notes: "leaks tokens" },
		token: admin.api,
	});
	idx = await index();
	expect(idx?.plugins[0]?.latestVerified).toBeNull();
	expect(idx?.plugins[0]?.yanked.map((y) => y.version)).toEqual(["1.0.0"]);

	const detail = await call("GET", "/v1/plugins/com.acme.notifier");
	const d = await verifyIndexResponse(await detail.json(), [publicKey]);
	const read = d.ok ? readPluginDetail(d.payload, "com.acme.notifier") : null;
	expect(read?.plugin.versions.map((v) => [v.version, v.yanked])).toEqual([
		["1.1.0", false],
		["1.0.0", true],
	]);
	expect(read?.plugin.versions[1]?.readme).toBe("# Notifier");
	expect((await call("GET", "/v1/plugins/com.acme.missing")).status).toBe(404);
});

test("ids: first come first served, reserved prefixes for admins", async () => {
	const a = await signIn("a@a.test");
	const b = await signIn("b@b.test");
	expect(
		(
			await call("POST", "/me/plugins", {
				body: { id: "com.a.x" },
				token: a.api,
			})
		).status,
	).toBe(200);
	expect(
		(
			await call("POST", "/me/plugins", {
				body: { id: "com.a.x" },
				token: b.api,
			})
		).status,
	).toBe(409);
	expect(
		(
			await call("POST", "/me/plugins", {
				body: { id: "it.logicaltech.x" },
				token: b.api,
			})
		).status,
	).toBe(403);
	expect(
		(
			await call("POST", "/me/plugins", {
				body: { id: "Not Valid" },
				token: b.api,
			})
		).status,
	).toBe(422);
	// Someone else's plugin cannot get versions from b.
	const r = await call("POST", "/me/plugins/com.a.x/versions", {
		token: b.api,
		body: { image: reg.image(manifest()), manifest: manifest() },
	});
	expect(r.status).toBe(404);
});

test("a cross-site form post is refused and a used sign-in link fails", async () => {
	const a = await signIn("a@a.test");
	const r = await call("POST", "/me/plugins", {
		form: { id: "com.a.y" },
		cookie: a.cookie,
		origin: "https://evil.test",
	});
	expect(r.status).toBe(403);
	const token =
		new URL(/https:\S+/.exec(mails[0] ?? "")?.[0] ?? "").searchParams.get(
			"token",
		) ?? "";
	expect(
		(await call("POST", "/auth/callback", { form: { token } })).status,
	).toBe(400);
	expect((await call("GET", "/me/plugins")).status).toBe(401);
});

test("pings count distinct installs; reports and suspension reach the admin and the index", async () => {
	const a = await signIn("a@acme.test");
	await call("POST", "/me/plugins", {
		body: { id: "com.acme.notifier" },
		token: a.api,
	});
	await call("POST", "/me/plugins/com.acme.notifier/versions", {
		token: a.api,
		body: { image: reg.image(manifest()), manifest: manifest() },
	});
	for (const id of ["install-1aaaaa", "install-1aaaaa", "install-2bbbbb"])
		expect(
			(
				await call("POST", "/v1/ping", {
					body: { pluginId: "com.acme.notifier", installId: id },
				})
			).status,
		).toBe(204);
	await call("POST", "/v1/ping", {
		body: { pluginId: "com.nobody.x", installId: "install-3ccccc" },
	});
	expect((await index())?.plugins[0]?.installs).toBe(2);

	expect(
		(
			await call("POST", "/v1/reports", {
				body: { pluginId: "com.acme.notifier", reason: "asks for my password" },
			})
		).status,
	).toBe(201);
	const admin = await signIn("root@l.test");
	sql.run("INSERT INTO admins (email, created_at) VALUES ('root@l.test', 0)");
	const q = (await (
		await call("GET", "/admin/queue", { token: admin.api })
	).json()) as {
		reports: { id: string }[];
		versions: { publisher_id: string }[];
	};
	expect(q.reports).toHaveLength(1);
	await call("POST", `/admin/reports/${q.reports[0]?.id}/resolve`, {
		token: admin.api,
		body: { resolution: "suspended" },
	});
	await call(
		"POST",
		`/admin/publishers/${q.versions[0]?.publisher_id}/suspend`,
		{ token: admin.api, body: { reason: "phishing" } },
	);

	const entry = (await index())?.plugins[0];
	expect(entry?.latest).toBeNull();
	expect(entry?.yanked).toHaveLength(1);
	// Suspension revokes the publisher's tokens.
	expect(
		(
			await call("POST", "/me/plugins", {
				body: { id: "com.acme.other" },
				token: a.api,
			})
		).status,
	).toBe(401);
});

test("versions sort newest first, a release above its prereleases", () => {
	expect(
		["1.0.0", "1.10.0", "1.2.0", "1.10.0-rc.1"].sort(compareVersions),
	).toEqual(["1.10.0", "1.10.0-rc.1", "1.2.0", "1.0.0"]);
});
