import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { homeDnsRecordId } from "@logistack/contracts";
import { decrypt, encrypt } from "@logistack/core";
import { auditLog, homeNetwork, node } from "@logistack/db";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

type Seen = {
	path: string;
	auth: string | null;
	query: string;
	form: Record<string, string>;
};

/** Answers the few Technitium calls these routes make, and records what it was sent. */
function fakeTechnitium() {
	const seen: Seen[] = [];
	const ok = (response: unknown = {}) =>
		Response.json({ status: "ok", response });
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const form = Object.fromEntries(new URLSearchParams(await req.text()));
			seen.push({
				path: url.pathname,
				auth: req.headers.get("authorization"),
				query: url.search,
				form,
			});
			switch (url.pathname) {
				case "/api/zones/list":
					return ok({
						zones: [
							{ name: "home.lan", type: "Primary", disabled: false },
							{
								name: "0.in-addr.arpa",
								type: "Primary",
								internal: true,
								disabled: false,
							},
						],
					});
				case "/api/zones/create":
					return form.zone === "home.lan"
						? Response.json({
								status: "error",
								errorMessage: "Zone already exists: home.lan",
							})
						: ok({ domain: form.zone });
				case "/api/zones/records/get":
					return ok({
						records: [
							{
								name: "home.lan",
								type: "SOA",
								ttl: 900,
								disabled: false,
								rData: {},
							},
							{
								name: "nas.home.lan",
								type: "A",
								ttl: 300,
								disabled: false,
								comments: "the NAS",
								rData: { ipAddress: "192.168.1.10" },
							},
						],
					});
				case "/api/zones/records/add":
				case "/api/zones/records/update":
					return ok();
				case "/api/dnsClient/resolve":
					return ok({
						result: {
							RCODE: "NxDomain",
							EDNS: { Options: [{ Data: { InfoCode: "Blocked" } }] },
							Answer: [],
						},
					});
				default:
					return Response.json({
						status: "error",
						errorMessage: `unexpected ${url.pathname}`,
					});
			}
		},
	});
	return {
		seen,
		url: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

describe.skipIf(!hasDocker)("home dns api", () => {
	let h: Harness;
	let cookie: string;
	let nodeId: string;
	const fake = fakeTechnitium();
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "homedns", label: "homedns" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		const [n] = await h.deps.db
			.insert(node)
			.values({
				organizationId: orgId,
				swarmNodeId: "swarm-h",
				hostname: "home",
				address: "10.0.0.9",
				role: "manager",
				status: "ready",
			})
			.returning();
		nodeId = n?.id as string;
		h.deps.homeDnsUrl = fake.url;
	}, 120_000);

	afterAll(async () => {
		fake.stop();
		await h?.close();
	}, 60_000);

	test("off: the view says so and pass-through routes refuse with a typed error", async () => {
		expect((await h.call("GET", "/api/network/dns", as())).json).toMatchObject({
			enabled: false,
			status: null,
			settings: null,
		});
		const zones = await h.call("GET", "/api/network/dns/zones", as());
		expect(zones.status).toBe(409);
		expect(zones.json.error.message).toBe("home DNS is off; enable it first");
		expect(
			(
				await h.call("PATCH", "/api/network/dns", {
					...as(),
					body: { lanAddress: "10.0.0.2" },
				})
			).status,
		).toBe(409);
		expect((await h.call("DELETE", "/api/network/dns", as())).status).toBe(404);
	});

	test("enable validates, stores a generated password encrypted, and is one per instance", async () => {
		const bad = await h.call("POST", "/api/network/dns", {
			...as(),
			body: { nodeId, lanAddress: "not-an-ip" },
		});
		expect(bad.status).toBe(400);
		expect(
			(
				await h.call("POST", "/api/network/dns", {
					...as(),
					body: { nodeId: "nod_missing", lanAddress: "192.168.1.2" },
				})
			).status,
		).toBe(404);
		const commaList = await h.call("POST", "/api/network/dns", {
			...as(),
			body: {
				nodeId,
				lanAddress: "192.168.1.2",
				settings: {
					upstream: { servers: ["1.1.1.1,6.6.6.6"], protocol: "Udp" },
				},
			},
		});
		expect(commaList.status).toBe(400);

		const on = await h.call("POST", "/api/network/dns", {
			...as(),
			body: {
				nodeId,
				lanAddress: "192.168.1.2",
				settings: { localZone: "Home.LAN." },
			},
		});
		expect(on.status).toBe(201);
		expect(on.json).toMatchObject({
			enabled: true,
			nodeId,
			nodeHostname: "home",
			lanAddress: "192.168.1.2",
			desiredState: "running",
			status: "starting",
			version: null,
		});
		expect(on.json.settings).toEqual({
			upstream: {
				servers: ["https://cloudflare-dns.com/dns-query (1.1.1.1)"],
				protocol: "Https",
			},
			dnssecValidation: true,
			blocking: { enabled: true, listUrls: [] },
			localZone: "home.lan",
		});
		const again = await h.call("POST", "/api/network/dns", {
			...as(),
			body: { nodeId, lanAddress: "192.168.1.2" },
		});
		expect(again.status).toBe(409);
		expect(again.json.error.message).toBe("home DNS is already on");

		const [row] = await h.deps.db.select().from(homeNetwork);
		expect(row?.tokenEncrypted).toBeNull();
		const console = await h.call("POST", "/api/network/dns/console", as());
		expect(console.json).toMatchObject({
			url: "http://192.168.1.2:5380/",
			username: "admin",
		});
		expect(console.json.password).toBe(
			await decrypt(h.deps.masterKey, row?.adminPasswordEncrypted ?? ""),
		);
		const audit = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "home_dns.console"));
		expect(audit).toHaveLength(1);
		expect(JSON.stringify(audit[0]?.diff)).not.toContain(console.json.password);
	});

	test("until the worker reports ready, pass-through routes say why", async () => {
		const res = await h.call("GET", "/api/network/dns/zones", as());
		expect(res.status).toBe(409);
		expect(res.json.error.message).toBe(
			"home DNS is not ready (status starting)",
		);
		expect(fake.seen).toEqual([]);
	});

	test("pass-through: the token goes in the header, never the URL, and Technitium's refusals are 409s", async () => {
		await h.deps.db.update(homeNetwork).set({
			status: "ready",
			tokenEncrypted: await encrypt(h.deps.masterKey, "service-token"),
		});
		const zones = await h.call("GET", "/api/network/dns/zones", as());
		expect(zones.json).toEqual([
			{ name: "home.lan", type: "Primary", disabled: false },
		]);
		expect(fake.seen.at(-1)).toMatchObject({
			path: "/api/zones/list",
			auth: "Bearer service-token",
			query: "",
		});

		const dup = await h.call("POST", "/api/network/dns/zones", {
			...as(),
			body: { name: "home.lan" },
		});
		expect(dup.status).toBe(409);
		expect(dup.json.error.message).toContain("Zone already exists: home.lan");

		const records = await h.call(
			"GET",
			"/api/network/dns/zones/home.lan/records",
			as(),
		);
		const nas = {
			name: "nas.home.lan",
			type: "A",
			content: "192.168.1.10",
		} as const;
		expect(records.json).toEqual([
			{
				id: homeDnsRecordId(nas),
				...nas,
				ttl: 300,
				comment: "the NAS",
				disabled: false,
			},
		]);

		const outside = await h.call(
			"POST",
			"/api/network/dns/zones/home.lan/records",
			{
				...as(),
				body: { name: "nas.other.lan", type: "A", content: "192.168.1.11" },
			},
		);
		expect(outside.status).toBe(400);
		const badValue = await h.call(
			"POST",
			"/api/network/dns/zones/home.lan/records",
			{
				...as(),
				body: { name: "x.home.lan", type: "MX", content: "mail.home.lan" },
			},
		);
		expect(badValue.status).toBe(400);

		const updated = await h.call(
			"PUT",
			`/api/network/dns/zones/home.lan/records/${records.json[0].id}`,
			{
				...as(),
				body: { name: "nas.home.lan", type: "A", content: "192.168.1.20" },
			},
		);
		expect(updated.status).toBe(204);
		expect(fake.seen.at(-1)?.form).toMatchObject({
			zone: "home.lan",
			domain: "nas.home.lan",
			newDomain: "nas.home.lan",
			type: "A",
			ipAddress: "192.168.1.10",
			newIpAddress: "192.168.1.20",
		});
		expect(
			(
				await h.call(
					"DELETE",
					"/api/network/dns/zones/home.lan/records/garbage",
					as(),
				)
			).status,
		).toBe(404);

		const blocked = await h.call("POST", "/api/network/dns/test", {
			...as(),
			body: { name: "ads.example.com" },
		});
		expect(blocked.json).toEqual({
			name: "ads.example.com",
			blocked: true,
			rcode: "NxDomain",
			answers: [],
		});
		const local = await h.call(
			"DELETE",
			"/api/network/dns/zones/home.lan",
			as(),
		);
		expect(local.status).toBe(409);
	});

	test("settings change by merge, blocking has its own route, and a stop is desired state", async () => {
		const patched = await h.call("PATCH", "/api/network/dns", {
			...as(),
			body: { settings: { dnssecValidation: false }, desiredState: "stopped" },
		});
		expect(patched.status).toBe(200);
		expect(patched.json.desiredState).toBe("stopped");
		expect(patched.json.settings).toMatchObject({
			dnssecValidation: false,
			localZone: "home.lan",
		});

		const blocking = { enabled: false, listUrls: ["https://big.oisd.nl/"] };
		expect(
			(
				await h.call("PUT", "/api/network/dns/blocking", {
					...as(),
					body: blocking,
				})
			).json,
		).toEqual(blocking);
		expect(
			(await h.call("GET", "/api/network/dns/blocking", as())).json,
		).toEqual(blocking);
		const [row] = await h.deps.db.select().from(homeNetwork);
		expect(row?.settings.blocking).toEqual(blocking);
		expect(row?.settings.dnssecValidation).toBe(false);
	});

	test("disable keeps the row until the worker has removed the data", async () => {
		expect((await h.call("DELETE", "/api/network/dns", as())).status).toBe(204);
		const [removing] = await h.deps.db.select().from(homeNetwork);
		expect(removing?.desiredState).toBe("removed");
		expect((await h.call("GET", "/api/network/dns", as())).json.enabled).toBe(
			false,
		);
		const blockedWhileRemoving = await h.call("POST", "/api/network/dns", {
			...as(),
			body: { nodeId, lanAddress: "192.168.1.2" },
		});
		expect(blockedWhileRemoving.status).toBe(409);
	});
});
