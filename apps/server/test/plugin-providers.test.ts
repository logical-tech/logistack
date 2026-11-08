import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@logistack/contracts";
import { decrypt } from "@logistack/core";
import { auditLog, dnsProvider } from "@logistack/db";
import { dispatch, dispatchDeps } from "@logistack/worker/notify";
import { RedisClient } from "bun";
import { and, eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

// Phase 2 end to end with examples/plugins/memory-providers installed from a dev URL: a plugin
// DNS provider through the API, DNS-01 through /acme-proxy writing the TXT via the plugin, a
// plugin notification channel delivering, a plugin secret provider, the kill switch and the
// uninstall guard.

describe.skipIf(!hasDocker)("plugin providers", () => {
	let h: Harness;
	let cookie: string;
	let plugin: ReturnType<typeof Bun.serve>;
	let mem: typeof import("../../../examples/plugins/memory-providers/src/main.ts");
	let installId: string;
	let dnsId: string;
	let channelId: string;
	let organizationId: string;
	const zone = { id: "example.test", name: "example.test" };
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "plugprov", label: "plugprov" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		await h.call("PATCH", "/api/instance/settings", {
			...as(),
			body: { allowPrivateHosts: true },
		});
		mem = await import(
			"../../../examples/plugins/memory-providers/src/main.ts"
		);
		plugin = Bun.serve({ port: 0, fetch: mem.app.fetch });
		const res = await h.call("POST", "/api/plugins", {
			...as(),
			body: { source: { kind: "url", url: plugin.url.href }, config: {} },
		});
		expect(res.status).toBe(201);
		installId = res.json.id;
		process.env.LOGISTACK_SIGNING_SECRET =
			res.json.devCredentials.signingSecret;
		process.env.LOGISTACK_INSTALL_ID = installId;
	}, 120_000);

	afterAll(async () => {
		plugin?.stop(true);
		await h?.close();
	});

	test("contributions list the plugin's providers for the wizards", async () => {
		const res = await h.call("GET", "/api/plugins/contributions", as());
		const providers = res.json[0].providers;
		expect(providers.dnsProviders[0].name).toBe("memory");
		expect(providers.notificationChannels[0].name).toBe("log");
		expect(providers.secretProviders[0].name).toBe("memory");
	});

	const dnsBody = (token: string) => ({
		kind: "plugin",
		credentials: { zone: zone.name, token },
		pluginInstallId: installId,
		pluginProvider: "memory",
	});

	test("a plugin DNS provider is tested and created through the API", async () => {
		const badForm = await h.call("POST", "/api/dns-providers/test", {
			...as(),
			body: { ...dnsBody("t"), credentials: { token: "t" } },
		});
		expect(badForm.status).toBe(400);
		const refused = await h.call("POST", "/api/dns-providers/test", {
			...as(),
			body: dnsBody("wrong"),
		});
		expect(refused.status).toBe(400);
		expect(refused.json.error.message).toContain("the token was refused");
		const tested = await h.call("POST", "/api/dns-providers/test", {
			...as(),
			body: dnsBody("t"),
		});
		expect(tested.json).toEqual({ zones: [zone] });

		const created = await h.call("POST", "/api/dns-providers", {
			...as(),
			body: { ...dnsBody("t"), name: "Memory", zones: [zone] },
		});
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({
			kind: "plugin",
			pluginInstallId: installId,
			pluginProvider: "memory",
		});
		dnsId = created.json.id;
		const zones = await h.call(
			"GET",
			`/api/dns-providers/${dnsId}/zones`,
			as(),
		);
		expect(zones.json.zones).toEqual([zone]);
	});

	test("records are created and listed through the plugin", async () => {
		const res = await h.call(
			"POST",
			`/api/dns-providers/${dnsId}/zones/${zone.id}/records`,
			{
				...as(),
				body: {
					name: "www.example.test",
					type: "A",
					ttl: 300,
					values: ["192.0.2.1"],
				},
			},
		);
		expect(res.status).toBe(201);
		const list = await h.call(
			"GET",
			`/api/dns-providers/${dnsId}/zones/${zone.id}/records`,
			as(),
		);
		expect(list.json.records.map((r: { name: string }) => r.name)).toEqual([
			"www.example.test",
		]);
	});

	const acme = async (
		action: "present" | "cleanup",
		body: unknown,
		auth?: string,
	) => {
		const res = await h.app.request(`/acme-proxy/${dnsId}/${action}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(auth ? { authorization: `Basic ${btoa(auth)}` } : {}),
			},
			body: JSON.stringify(body),
		});
		return { status: res.status, text: await res.text() };
	};
	const secret = async () => {
		const [row] = await h.deps.db
			.select()
			.from(dnsProvider)
			.where(eq(dnsProvider.id, dnsId));
		organizationId = row?.organizationId ?? "";
		return decrypt(h.deps.masterKey, row?.acmeSecretEncrypted ?? "");
	};
	const txt = () =>
		(mem.state.records.get(zone.name) ?? []).filter((r) => r.type === "TXT");

	test("acme-proxy refuses bad credentials and non-challenge names", async () => {
		const challenge = { fqdn: "_acme-challenge.example.test.", value: "tok" };
		expect((await acme("present", challenge)).status).toBe(401);
		expect((await acme("present", challenge, `${dnsId}:nope`)).status).toBe(
			401,
		);
		expect(
			(await acme("present", challenge, `dns_other:${await secret()}`)).status,
		).toBe(401);
		const other = await acme(
			"present",
			{ fqdn: "www.example.test.", value: "x" },
			`${dnsId}:${await secret()}`,
		);
		expect(other.status).toBe(400);
		expect(txt()).toEqual([]);
	});

	test("acme-proxy present and cleanup write and remove the TXT via the plugin, idempotently", async () => {
		const auth = `${dnsId}:${await secret()}`;
		const challenge = { fqdn: "_acme-challenge.example.test.", value: "tok-1" };
		for (let i = 0; i < 2; i++) {
			const res = await acme("present", challenge, auth);
			expect(res.status).toBe(200);
			// libdns/acmeproxy only accepts an echo of what it sent.
			expect(JSON.parse(res.text)).toEqual(challenge);
		}
		expect(txt().map((r) => [r.name, r.content])).toEqual([
			["_acme-challenge.example.test", "tok-1"],
		]);
		for (let i = 0; i < 2; i++)
			expect((await acme("cleanup", challenge, auth)).status).toBe(200);
		expect(txt()).toEqual([]);
		const audited = await h.deps.db
			.select({ action: auditLog.action, actor: auditLog.actorId })
			.from(auditLog)
			.where(
				and(
					eq(auditLog.organizationId, organizationId),
					eq(auditLog.resourceId, dnsId),
					eq(auditLog.actorKind, "system"),
				),
			);
		expect(audited.map((a) => a.action).sort()).toEqual([
			"dns_record.acme_cleanup",
			"dns_record.acme_cleanup",
			"dns_record.acme_present",
			"dns_record.acme_present",
		]);
	});

	test("a plugin notification channel tests and delivers rule-matched events", async () => {
		const created = await h.call("POST", "/api/notification-channels", {
			...as(),
			body: {
				kind: "plugin",
				name: "Memory log",
				config: { prefix: "[prod]" },
				pluginInstallId: installId,
				pluginProvider: "log",
			},
		});
		expect(created.status).toBe(201);
		channelId = created.json.id;
		const tested = await h.call(
			"POST",
			`/api/notification-channels/${channelId}/test`,
			as(),
		);
		expect(tested.status).toBe(200);
		const rule = await h.call("POST", "/api/notification-rules", {
			...as(),
			body: { events: ["deployment.failed"], scope: {}, channelId },
		});
		expect(rule.status).toBe(201);

		const results = await dispatch(event(), deps());
		expect(results.get(channelId)).toEqual({ ok: true });
		expect(mem.state.sent.at(-1)).toMatchObject({
			prefix: "[prod]",
			event: { type: "deployment.failed" },
		});
	});

	const event = (): EventEnvelope => ({
		id: `evt_${crypto.randomUUID()}`,
		type: "deployment.failed",
		organizationId,
		resource: { type: "service", id: "svc_abc" },
		payload: { message: "build exited 1" },
		at: new Date(),
	});
	const deps = () =>
		dispatchDeps(
			{
				db: h.deps.db,
				masterKey: h.deps.masterKey,
				cfg: { LS_NAME_PREFIX: "" },
				bus: { redis: new RedisClient(h.config.REDIS_URL) },
				queues: { notify: { add: async () => {} } },
			} as never,
			(url, init) => fetch(url, init),
		);

	test("a plugin secret provider is created after a successful test", async () => {
		const refused = await h.call("POST", "/api/secret-providers", {
			...as(),
			body: {
				kind: "plugin",
				name: "mem",
				config: { token: "wrong" },
				pluginInstallId: installId,
				pluginProvider: "memory",
			},
		});
		expect(refused.status).toBe(400);
		const created = await h.call("POST", "/api/secret-providers", {
			...as(),
			body: {
				kind: "plugin",
				name: "mem",
				config: { token: "t" },
				pluginInstallId: installId,
				pluginProvider: "memory",
			},
		});
		expect(created.status).toBe(201);
		expect(created.json.url).toBe(
			"plugin:dev.logistack.memory-providers/memory",
		);
	});

	test("uninstall is refused while provider rows use the plugin, naming them", async () => {
		const res = await h.call("DELETE", `/api/plugins/${installId}`, as());
		expect(res.status).toBe(409);
		expect(res.json.error.message).toContain('DNS provider "Memory"');
		expect(res.json.error.message).toContain(
			'notification channel "Memory log"',
		);
		expect(res.json.error.message).toContain('secret provider "mem"');
	});

	test("a disabled plugin fails its providers with 'plugin disabled'", async () => {
		await h.call("PATCH", `/api/plugins/${installId}`, {
			...as(),
			body: { enabled: false },
		});
		const zones = await h.call(
			"GET",
			`/api/dns-providers/${dnsId}/zones`,
			as(),
		);
		expect(zones.status).toBe(409);
		expect(zones.json.error.message).toContain("plugin disabled");
		const auth = `${dnsId}:${await secret()}`;
		const present = await acme(
			"present",
			{ fqdn: "_acme-challenge.example.test", value: "x" },
			auth,
		);
		expect(present.status).toBe(502);
		expect(present.text).toContain("plugin disabled");
		const results = await dispatch(event(), deps());
		const outcome = results.get(channelId);
		expect(outcome).toMatchObject({ ok: false });
		expect(JSON.stringify(outcome)).toContain("plugin disabled");
	});

	test("once its providers are gone the plugin uninstalls", async () => {
		for (const path of [
			`/api/dns-providers/${dnsId}`,
			`/api/notification-channels/${channelId}`,
		])
			expect((await h.call("DELETE", path, as())).status).toBe(204);
		const sp = await h.call("GET", "/api/secret-providers", as());
		expect(
			(await h.call("DELETE", `/api/secret-providers/${sp.json[0].id}`, as()))
				.status,
		).toBe(204);
		expect(
			(await h.call("DELETE", `/api/plugins/${installId}`, as())).status,
		).toBe(204);
	});
});
