import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dnsProvider, domain, homeProxy, homeProxyRoute } from "@logistack/db";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("local proxy api", () => {
	let h: Harness;
	let cookie: string;
	let orgId: string;
	const as = () => ({ headers: { cookie } });
	const upstream = Bun.serve({
		port: 0,
		fetch: () => new Response("nas", { status: 401 }),
	});

	beforeAll(async () => {
		h = await startHarness({ area: "homeproxy", label: "homeproxy" });
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
	}, 120_000);

	afterAll(async () => {
		upstream.stop(true);
		await h?.close();
	}, 60_000);

	test("off: the view says so and routes cannot be added", async () => {
		expect(
			(await h.call("GET", "/api/network/proxy", as())).json,
		).toMatchObject({
			enabled: false,
			zone: null,
			tls: null,
			automaticRecords: false,
		});
		expect(
			(await h.call("GET", "/api/network/proxy/routes", as())).json,
		).toEqual([]);
		const add = await h.call("POST", "/api/network/proxy/routes", {
			...as(),
			body: { name: "nas", upstream: "192.168.1.10:5000" },
		});
		expect(add.status).toBe(409);
		expect((await h.call("DELETE", "/api/network/proxy", as())).status).toBe(
			404,
		);
	});

	test("acme needs a DNS provider holding the zone; internal does not", async () => {
		const acme = await h.call("POST", "/api/network/proxy", {
			...as(),
			body: { zone: "home.example.com", tls: "acme" },
		});
		expect(acme.status).toBeGreaterThanOrEqual(400);
		expect(acme.json.error.message).toContain("no connected DNS provider");

		await h.deps.db.insert(dnsProvider).values({
			organizationId: orgId,
			kind: "cloudflare",
			name: "Cloudflare",
			credentialsEncrypted: "x",
			zonesCache: [{ id: "z1", name: "example.com" }],
		});
		const on = await h.call("POST", "/api/network/proxy", {
			...as(),
			body: { zone: "Home.Example.com.", tls: "acme" },
		});
		expect(on.status).toBe(201);
		expect(on.json).toMatchObject({
			enabled: true,
			zone: "home.example.com",
			tls: "acme",
			dnsProvider: "Cloudflare",
			lanAddress: null,
			automaticRecords: false,
		});
		expect(
			(
				await h.call("POST", "/api/network/proxy", {
					...as(),
					body: { zone: "other.example.com", tls: "internal" },
				})
			).status,
		).toBe(409);
	});

	test("routes: normalised upstream, unique names, no clash with service domains", async () => {
		const bad = await h.call("POST", "/api/network/proxy/routes", {
			...as(),
			body: { name: "-nas", upstream: "192.168.1.10:5000" },
		});
		expect(bad.status).toBe(400);
		const admin = await h.call("POST", "/api/network/proxy/routes", {
			...as(),
			body: { name: "caddy", upstream: "10.0.0.2:2019" },
		});
		expect(admin.status).toBe(400);

		const nas = await h.call("POST", "/api/network/proxy/routes", {
			...as(),
			body: {
				name: "NAS",
				upstream: "https://192.168.1.10:5001/",
				insecure: true,
			},
		});
		expect(nas.status).toBe(201);
		expect(nas.json).toMatchObject({
			name: "nas",
			hostname: "nas.home.example.com",
			upstream: "https://192.168.1.10:5001",
			insecure: true,
		});
		const dup = await h.call("POST", "/api/network/proxy/routes", {
			...as(),
			body: { name: "nas", upstream: "192.168.1.11" },
		});
		expect(dup.status).toBe(409);

		const prj = (
			await h.call("POST", "/api/projects", { ...as(), body: { name: "Shop" } })
		).json.id;
		const envId = (
			await h.call("GET", `/api/projects/${prj}/environments`, as())
		).json[0].id;
		const svc = await h.call("POST", `/api/environments/${envId}/services`, {
			...as(),
			body: {
				name: "Web",
				spec: {
					kind: "application",
					source: { type: "image", image: "nginx:alpine" },
					build: { type: "image" },
					ports: [{ target: 80, protocol: "tcp" }],
					replicas: 1,
					resources: {},
					placement: [],
				},
			},
		});
		expect(svc.status).toBe(201);
		await h.deps.db.insert(domain).values({
			serviceId: svc.json.id,
			hostname: "web.home.example.com",
			port: 80,
		});
		const clash = await h.call("POST", "/api/network/proxy/routes", {
			...as(),
			body: { name: "web", upstream: "192.168.1.12:80" },
		});
		expect(clash.status).toBe(409);

		const edit = await h.call(
			"PATCH",
			`/api/network/proxy/routes/${nas.json.id}`,
			{ ...as(), body: { upstream: "192.168.1.10:5000", insecure: false } },
		);
		expect(edit.json).toMatchObject({
			upstream: "http://192.168.1.10:5000",
			insecure: false,
		});
		expect(
			(await h.call("GET", "/api/network/proxy/routes", as())).json.map(
				(r: { name: string }) => r.name,
			),
		).toEqual(["nas"]);
	});

	test("test reports any HTTP status as reachable and a refused port as not", async () => {
		const up = await h.call("POST", "/api/network/proxy/test", {
			...as(),
			body: { upstream: `127.0.0.1:${upstream.port}` },
		});
		expect(up.json).toMatchObject({ ok: true, status: 401, error: null });
		const down = await h.call("POST", "/api/network/proxy/test", {
			...as(),
			body: { upstream: "127.0.0.1:1" },
		});
		expect(down.json).toMatchObject({ ok: false, status: null });
	});

	test("disable deletes the routes with the proxy", async () => {
		expect((await h.call("DELETE", "/api/network/proxy", as())).status).toBe(
			204,
		);
		expect(await h.deps.db.select().from(homeProxy)).toEqual([]);
		expect(await h.deps.db.select().from(homeProxyRoute)).toEqual([]);
	});
});
