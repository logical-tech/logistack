import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@logistack/contracts";
import { apikey, member, pluginInstall, user } from "@logistack/db";
import { dispatch, dispatchDeps } from "@logistack/worker/notify";
import { RedisClient } from "bun";
import { eq } from "drizzle-orm";
import { PAGE_CSP } from "../src/plugin-proxy.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

// Phase 1 end to end with the reference plugin (examples/plugins/deploy-notifier) installed
// from a dev URL: install, signed events, the page proxy, session tokens, storage, kill switch.

describe.skipIf(!hasDocker)("plugins", () => {
	let h: Harness;
	let cookie: string;
	let api: ReturnType<typeof Bun.serve>;
	let plugin: ReturnType<typeof Bun.serve>;
	let chat: ReturnType<typeof Bun.serve>;
	const posted: unknown[] = [];
	const dataDir = mkdtempSync(join(tmpdir(), "ls-test-plugins-"));
	let installId: string;
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "plugins", label: "plugins" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		// The plugin and the chat receiver run on loopback.
		await h.call("PATCH", "/api/instance/settings", {
			...as(),
			body: { allowPrivateHosts: true },
		});
		api = Bun.serve({ port: 0, fetch: h.app.fetch });
		chat = Bun.serve({
			port: 0,
			async fetch(req) {
				posted.push(await req.json());
				return new Response("ok");
			},
		});
		process.env.DATA_DIR = dataDir;
		const { app } = await import(
			"../../../examples/plugins/deploy-notifier/src/main.ts"
		);
		plugin = Bun.serve({ port: 0, fetch: app.fetch });
	}, 120_000);

	afterAll(async () => {
		plugin?.stop(true);
		chat?.stop(true);
		api?.stop(true);
		await h?.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("inspect reads the manifest from the dev URL", async () => {
		const res = await h.call("POST", "/api/plugins/inspect", {
			...as(),
			body: { kind: "url", url: plugin.url.href },
		});
		expect(res.status).toBe(200);
		expect(res.json.manifest.id).toBe("dev.logistack.deploy-notifier");
		expect(res.json.missingPermissions).toEqual([]);
		expect(res.json.installedId).toBeNull();
	});

	test("install validates settings, creates a scoped service account and returns dev credentials once", async () => {
		const bad = await h.call("POST", "/api/plugins", {
			...as(),
			body: { source: { kind: "url", url: plugin.url.href }, config: {} },
		});
		expect(bad.status).toBe(400);
		expect(bad.json.error.code).toBe("validation_failed");

		const res = await h.call("POST", "/api/plugins", {
			...as(),
			body: {
				source: { kind: "url", url: plugin.url.href },
				config: { webhookUrl: chat.url.href, mention: "@oncall" },
			},
		});
		expect(res.status).toBe(201);
		installId = res.json.id;
		expect(res.json.config.webhookUrl).toBe("••••••••");
		expect(res.json.devCredentials.token).toStartWith("lsk_");
		const [row] = await h.deps.db
			.select()
			.from(pluginInstall)
			.where(eq(pluginInstall.id, installId));
		const [m] = await h.deps.db
			.select({ role: member.role })
			.from(member)
			.where(eq(member.userId, row?.serviceAccountId ?? ""));
		expect(m?.role).toStartWith("plugin:");

		const again = await h.call("POST", "/api/plugins", {
			...as(),
			body: {
				source: { kind: "url", url: plugin.url.href },
				config: { webhookUrl: chat.url.href },
			},
		});
		expect(again.status).toBe(409);

		// What `logistack-plugin dev` tells the developer to set.
		process.env.LOGISTACK_URL = api.url.href;
		process.env.LOGISTACK_TOKEN = res.json.devCredentials.token;
		process.env.LOGISTACK_SIGNING_SECRET =
			res.json.devCredentials.signingSecret;
		process.env.LOGISTACK_INSTALL_ID = installId;
	});

	test("the plugin role is hidden from the roles list", async () => {
		const roles = await h.call("GET", "/api/roles", as());
		expect(
			roles.json.some((r: { name: string }) => r.name.startsWith("plugin:")),
		).toBe(false);
	});

	test("the plugin reads its own settings with its key, and only it can", async () => {
		const self = await h.call("GET", "/api/plugins/self", {
			headers: { "x-api-key": process.env.LOGISTACK_TOKEN ?? "" },
		});
		expect(self.status).toBe(200);
		expect(self.json.config.webhookUrl).toBe(chat.url.href);
		expect((await h.call("GET", "/api/plugins/self", as())).status).toBe(403);
	});

	test("test checks health and lets the plugin judge its settings", async () => {
		const res = await h.call("POST", `/api/plugins/${installId}/test`, as());
		expect(res.status).toBe(200);
		expect(res.json.health.ok).toBe(true);
		// The reference plugin wants https; the loopback receiver is http.
		expect(res.json.config).toEqual({
			ok: false,
			error: "the webhook URL must be https",
		});
	});

	test("a subscribed event is delivered, signed, and posted to the chat", async () => {
		const ctx = {
			db: h.deps.db,
			masterKey: h.deps.masterKey,
			cfg: { LS_NAME_PREFIX: "" },
			bus: { redis: new RedisClient(h.config.REDIS_URL) },
			queues: { notify: { add: async () => {} } },
		};
		const [row] = await h.deps.db
			.select({ org: pluginInstall.organizationId })
			.from(pluginInstall)
			.where(eq(pluginInstall.id, installId));
		const orgId = row?.org ?? "";
		const event: EventEnvelope = {
			id: `evt_${crypto.randomUUID()}`,
			type: "deployment.failed",
			organizationId: orgId,
			resource: { type: "service", id: "svc_abc" },
			payload: { serviceName: "web", message: "build exited 1" },
			at: new Date(),
		};
		// The worker's own dispatcher; plain fetch reaches the loopback dev URL.
		const results = await dispatch(
			event,
			dispatchDeps(ctx as never, (url, init) => fetch(url, init)),
		);
		expect(results.get(installId)).toEqual({ ok: true });
		expect(posted).toEqual([
			{ text: "@oncall Deploy of web failed: build exited 1" },
		]);
		// An event type it did not subscribe to goes nowhere.
		const other = await dispatch(
			{ ...event, id: `evt_${crypto.randomUUID()}`, type: "backup.failed" },
			dispatchDeps(ctx as never, (url, init) => fetch(url, init)),
		);
		expect(other.has(installId)).toBe(false);
	});

	test("tools are listed with their schemas and run through the plugin", async () => {
		const list = await h.call("GET", "/api/plugins/tools", as());
		expect(list.json).toHaveLength(1);
		expect(list.json[0].name).toBe("post-message");
		const bad = await h.call(
			"POST",
			`/api/plugins/${installId}/tools/post-message`,
			{ ...as(), body: { input: {} } },
		);
		expect(bad.status).toBe(400);
		const res = await h.call(
			"POST",
			`/api/plugins/${installId}/tools/post-message`,
			{ ...as(), body: { input: { text: "hello" } } },
		);
		expect(res.status).toBe(200);
		expect(res.json.output).toEqual({ posted: true });
		expect(posted.at(-1)).toEqual({ text: "@oncall hello" });
		const wrongKind = await h.call(
			"POST",
			`/api/plugins/${installId}/tools/post-message/destructive`,
			{ ...as(), body: { input: { text: "x" } } },
		);
		expect(wrongKind.status).toBe(400);
	});

	test("pages are proxied into an opaque origin, with no cookies either way", async () => {
		const res = await h.app.request(`/plugins/${installId}/ui/failures`, {
			headers: { cookie },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(await res.text()).toContain("<!doctype html>");
		const post = await h.app.request(`/plugins/${installId}/ui/failures`, {
			method: "POST",
		});
		expect(post.status).toBe(405);
	});

	test("the page backend needs a session token; a cookie is not enough", async () => {
		const noToken = await h.app.request(`/plugins/${installId}/ui/api/events`, {
			headers: { cookie },
		});
		expect(noToken.status).toBe(401);

		const session = await h.call(
			"GET",
			`/api/plugins/${installId}/session`,
			as(),
		);
		expect(session.status).toBe(200);
		const res = await h.app.request(`/plugins/${installId}/ui/api/events`, {
			headers: { "x-logistack-session": session.json.token },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		const events = (await res.json()) as { serviceId: string }[];
		expect(events[0]?.serviceId).toBe("svc_abc");

		// A token is bound to its install.
		const forged = await h.app.request("/plugins/plg_other/ui/api/events", {
			headers: { "x-logistack-session": session.json.token },
		});
		expect(forged.status).toBe(404);
		// The session token is not an API credential.
		const asApi = await h.call("GET", "/api/plugins", {
			headers: { authorization: `Bearer ${session.json.token}` },
		});
		expect(asApi.status).toBe(401);
	});

	test("bridge storage is per user, size-limited", async () => {
		const put = await h.call(
			"PUT",
			`/api/plugins/${installId}/storage/showSucceeded`,
			{ ...as(), body: { value: true } },
		);
		expect(put.status).toBe(204);
		const get = await h.call(
			"GET",
			`/api/plugins/${installId}/storage/showSucceeded`,
			as(),
		);
		expect(get.json.value).toBe(true);
		const big = await h.call("PUT", `/api/plugins/${installId}/storage/big`, {
			...as(),
			body: { value: "x".repeat(17 * 1024) },
		});
		expect(big.status).toBe(400);
	});

	test("disabling hides the pages and closes the proxy", async () => {
		expect(
			(await h.call("GET", "/api/plugins/contributions", as())).json[0].pages,
		).toHaveLength(2);
		const off = await h.call("PATCH", `/api/plugins/${installId}`, {
			...as(),
			body: { enabled: false },
		});
		expect(off.json.enabled).toBe(false);
		expect(
			(await h.call("GET", "/api/plugins/contributions", as())).json,
		).toEqual([]);
		const page = await h.app.request(`/plugins/${installId}/ui/failures`);
		expect(page.status).toBe(404);
	});

	test("a masked secret in an update keeps the stored one", async () => {
		const res = await h.call("PATCH", `/api/plugins/${installId}`, {
			...as(),
			body: {
				config: { webhookUrl: "••••••••", mention: "@team" },
			},
		});
		expect(res.status).toBe(200);
		const self = await h.call("GET", "/api/plugins/self", {
			headers: { "x-api-key": process.env.LOGISTACK_TOKEN ?? "" },
		});
		expect(self.json.config).toEqual({
			webhookUrl: chat.url.href,
			mention: "@team",
		});
	});

	test("deploy gate settings default to 10 s fail-closed and patch one field at a time", async () => {
		const path = `/api/plugins/${installId}`;
		expect((await h.call("GET", path, as())).json.gate).toEqual({
			timeoutSeconds: 10,
			failMode: "closed",
		});
		const res = await h.call("PATCH", path, {
			...as(),
			body: { gate: { failMode: "open" } },
		});
		expect(res.json.gate).toEqual({ timeoutSeconds: 10, failMode: "open" });
		const tooLong = await h.call("PATCH", path, {
			...as(),
			body: { gate: { timeoutSeconds: 61 } },
		});
		expect(tooLong.status).toBe(400);
	});

	test("the instance policy can turn installs off", async () => {
		await h.call("PUT", "/api/plugins/policy", {
			...as(),
			body: { policy: "off" },
		});
		const res = await h.call("POST", "/api/plugins/inspect", {
			...as(),
			body: { kind: "url", url: plugin.url.href },
		});
		expect(res.status).toBe(403);
		await h.call("PUT", "/api/plugins/policy", {
			...as(),
			body: { policy: "any" },
		});
	});

	test("uninstall removes the service account and its keys", async () => {
		const [row] = await h.deps.db
			.select()
			.from(pluginInstall)
			.where(eq(pluginInstall.id, installId));
		const res = await h.call("DELETE", `/api/plugins/${installId}`, as());
		expect(res.status).toBe(204);
		const accountId = row?.serviceAccountId ?? "";
		expect(
			await h.deps.db.select().from(user).where(eq(user.id, accountId)),
		).toEqual([]);
		expect(
			await h.deps.db
				.select()
				.from(apikey)
				.where(eq(apikey.referenceId, accountId)),
		).toEqual([]);
	});
});
