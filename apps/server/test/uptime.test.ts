import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@logistack/contracts";
import { encrypt } from "@logistack/core";
import { monitor, notificationChannel, notificationRule } from "@logistack/db";
import { RedisClient } from "bun";
import { eq } from "drizzle-orm";
import type { Bus } from "../../worker/src/bus.ts";
import type { Ctx } from "../../worker/src/ctx.ts";
import { dispatch, dispatchDeps } from "../../worker/src/notify.ts";
import { claimDue, enqueueDue, processCheck } from "../../worker/src/uptime.ts";
import { tlsCheck } from "../../worker/src/uptime-checks.ts";
import { envelope } from "../src/events.ts";
import { resetStatusHosts } from "../src/status-pages.ts";
import { badgeSvg, renderStatusPage } from "../src/status-render.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

test("status page html escapes user text and renders bars", () => {
	const html = renderStatusPage({
		title: "Acme <script>",
		description: "",
		theme: { accent: "#2563eb", appearance: "dark" },
		overall: "degraded",
		sections: [
			{
				name: "API",
				monitors: [
					{
						id: "mon_1",
						label: '"Public" API',
						status: "down",
						uptime: 98.5,
						bars: [
							{ day: "2026-11-07", uptime: 100, status: "up" },
							{ day: "2026-11-08", uptime: 97, status: "down" },
						],
					},
				],
			},
		],
		incidents: [],
		maintenance: [],
		historyDays: 2,
		generatedAt: new Date("2026-11-08T12:00:00Z"),
	});
	expect(html).not.toContain("<script>");
	expect(html).toContain("Acme &lt;script&gt;");
	expect(html).toContain("&quot;Public&quot; API");
	expect(html).toContain('class="dark"');
	expect(html).toContain("Some systems are down");
	expect(html.match(/class="d-(up|down)"/g)).toEqual([
		'class="d-up"',
		'class="d-down"',
	]);
	expect(badgeSvg("status", "up", "up")).toMatchSnapshot();
});

describe.skipIf(!hasDocker)("uptime end to end", () => {
	let h: Harness;
	let cookie: string;
	let orgId: string;
	let ctx: Ctx;
	const events: EventEnvelope[] = [];
	const as = (body?: unknown) => ({ headers: { cookie }, body });

	beforeAll(async () => {
		h = await startHarness({ area: "uptime", label: "uptime" });
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		// Targets here are loopback servers; production refuses them unless an owner allows it.
		await h.call(
			"PATCH",
			"/api/instance/settings",
			as({ allowPrivateHosts: true }),
		);
		const redis = new RedisClient(h.config.REDIS_URL);
		const bus: Pick<Bus, "redis" | "publish"> = {
			redis,
			async publish(type, org, resource, payload = {}) {
				const e = envelope(type, org, resource, payload);
				events.push(e);
				await h.deps.bus.publishEvent(e);
			},
		};
		ctx = { db: h.deps.db, masterKey: h.deps.masterKey, bus } as unknown as Ctx;
	});
	afterAll(async () => {
		ctx?.bus.redis.close();
		await h?.close();
	});

	test("a check to a private address is refused unless allowed", async () => {
		await h.call(
			"PATCH",
			"/api/instance/settings",
			as({ allowPrivateHosts: false }),
		);
		const r = await h.call(
			"POST",
			"/api/monitors/test",
			as({
				config: { kind: "tcp", tcp: { host: "127.0.0.1", port: 5 } },
			}),
		);
		expect(r.status).toBe(200);
		expect(r.json.ok).toBe(false);
		expect(r.json.error).toContain("private address");
		await h.call(
			"PATCH",
			"/api/instance/settings",
			as({ allowPrivateHosts: true }),
		);
	});

	test("a stopped service is notified after retries, within one interval, and the status page shows it", async () => {
		let server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => Response.json({ status: "green" }),
		});
		const port = server.port;
		const hook: string[] = [];
		const receiver = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const text = await req.text();
				hook.push(
					text.includes("monitor.down") ? "monitor.down" : text.slice(0, 200),
				);
				return new Response(null, { status: 204 });
			},
		});
		try {
			const created = await h.call(
				"POST",
				"/api/monitors",
				as({
					name: "Shop API",
					config: {
						kind: "http",
						http: {
							url: `http://127.0.0.1:${port}/health`,
							method: "GET",
							jsonPath: { path: "$.status", equals: "green" },
						},
					},
					intervalSec: 60,
					retryIntervalSec: 20,
					downAfter: 3,
					upAfter: 1,
				}),
			);
			expect(created.status).toBe(201);
			const id: string = created.json.id;

			// A webhook rule for monitor.down, through the real dispatcher.
			const [ch] = await h.deps.db
				.insert(notificationChannel)
				.values({
					organizationId: orgId,
					kind: "webhook",
					name: "Ops hook",
					configEncrypted: await encrypt(
						h.deps.masterKey,
						JSON.stringify({
							url: `http://127.0.0.1:${receiver.port}/hook`,
							secret: "0123456789abcdef0123",
						}),
					),
				})
				.returning();
			await h.deps.db.insert(notificationRule).values({
				organizationId: orgId,
				events: ["monitor.down", "monitor.up"],
				channelId: ch?.id as string,
			});

			// Scheduling: a new monitor is due at once and only one claimer gets it.
			const queued: string[] = [];
			const [a, b] = await Promise.all([claimDue(ctx), claimDue(ctx)]);
			expect([...(a ?? []), ...(b ?? [])].map((m) => m.id)).toEqual([id]);
			expect(
				await enqueueDue(ctx, {
					addBulk: async (jobs) => {
						queued.push(...jobs.map((j) => j.opts?.jobId as string));
						return [];
					},
				}),
			).toBe(0);

			const at = async () => {
				const [m] = await h.deps.db
					.select()
					.from(monitor)
					.where(eq(monitor.id, id));
				if (!m) throw new Error("monitor gone");
				return m;
			};
			const step = async () => {
				const before = Date.now();
				const r = await processCheck(ctx, id);
				const m = await at();
				return {
					...r,
					delaySec: Math.round((m.nextCheckAt.getTime() - before) / 1000),
				};
			};

			expect(await step()).toMatchObject({ status: "up", delaySec: 60 });

			server.stop(true);
			// The service stops at T. Failures 1 and 2 retry after 20 s each; the third confirms.
			const f1 = await step();
			expect(f1).toMatchObject({ status: "up", emitted: [], delaySec: 20 });
			const f2 = await step();
			expect(f2).toMatchObject({ status: "up", emitted: [], delaySec: 20 });
			const f3 = await step();
			expect(f3).toMatchObject({
				status: "down",
				emitted: ["monitor.down"],
				delaySec: 60,
			});
			// First failing check at most one interval after T, then two retries: 60 + 40 s.
			expect(f1.delaySec + f2.delaySec).toBeLessThanOrEqual(60);

			const down = events.find((e) => e.type === "monitor.down");
			expect(down).toMatchObject({
				organizationId: orgId,
				resource: { type: "monitor", id },
				payload: { name: "Shop API", state: "firing" },
			});
			const sent = await dispatch(
				down as EventEnvelope,
				dispatchDeps(ctx, fetch),
				{ attempts: 1, baseMs: 1 },
			);
			expect(sent.get(ch?.id as string)).toEqual({ ok: true });
			expect(hook).toEqual(["monitor.down"]);

			// An auto incident opened with the failure.
			const incidents = (await h.call("GET", "/api/incidents", as())).json;
			expect(incidents[0]).toMatchObject({
				title: "Shop API is down",
				status: "investigating",
				monitorIds: [id],
			});

			// Public status page, by slug and by its own hostname.
			const page = await h.call(
				"POST",
				"/api/status-pages",
				as({
					title: "Acme status",
					slug: "acme",
					hostname: "status.acme.test",
					sections: [
						{ name: "Shop", monitors: [{ monitorId: id, label: "Checkout" }] },
					],
				}),
			);
			expect(page.status).toBe(201);
			resetStatusHosts();
			const bySlug = await h.call("GET", "/status/acme");
			expect(bySlug.status).toBe(200);
			expect(bySlug.json).toContain("Checkout");
			expect(bySlug.json).toContain("Major outage");
			expect(bySlug.json).toContain("Shop API is down");
			expect(bySlug.json).not.toContain("Shop API</span>");
			const byHost = await h.call("GET", "/", {
				headers: { host: "status.acme.test" },
			});
			expect(byHost.status).toBe(200);
			expect(byHost.json).toContain("Checkout");
			// The custom domain serves the page only: no API, no dashboard.
			const api = await h.call("GET", "/api/health", {
				headers: { host: "status.acme.test" },
			});
			expect(api.status).toBe(404);
			const summary = await h.call("GET", "/status/acme/summary.json");
			expect(summary.json).toMatchObject({
				status: "outage",
				monitors: [{ id, name: "Checkout", status: "down" }],
			});
			const badge = await h.call("GET", `/status/acme/badge/${id}.svg`);
			expect(badge.headers.get("content-type")).toContain("image/svg+xml");
			expect(badge.json).toContain("status: down");
			const other = await h.call("GET", "/status/acme/badge/mon_other.svg");
			expect(other.status).toBe(404);

			// Recovery: one success (upAfter 1) sends monitor.up and resolves the incident.
			server = Bun.serve({
				port,
				hostname: "127.0.0.1",
				fetch: () => Response.json({ status: "green" }),
			});
			expect(await step()).toMatchObject({
				status: "up",
				emitted: ["monitor.up"],
			});
			const resolved = (await h.call("GET", "/api/incidents", as())).json[0];
			expect(resolved.status).toBe("resolved");
			expect(resolved.updates.map((u: { status: string }) => u.status)).toEqual(
				["resolved", "investigating"],
			);
			expect((await h.call("GET", "/status/acme")).json).toContain(
				"All systems operational",
			);

			const detail = await h.call("GET", `/api/monitors/${id}`, as());
			expect(detail.json.bars).toHaveLength(90);
			expect(detail.json.checks).toHaveLength(5);
			expect(detail.json.bars.at(-1).status).toBe("down");

			// Unpublished: gone from both addresses.
			await h.call(
				"PATCH",
				`/api/status-pages/${page.json.id}`,
				as({ published: false }),
			);
			resetStatusHosts();
			expect((await h.call("GET", "/status/acme")).status).toBe(404);
			// Caddy drops the route on its next sync; until then the host gets no page.
			expect(
				(await h.call("GET", "/", { headers: { host: "status.acme.test" } }))
					.json,
			).not.toContain("Checkout");
		} finally {
			server.stop(true);
			receiver.stop(true);
		}
	}, 60_000);

	test("maintenance silences a failing monitor", async () => {
		const created = await h.call(
			"POST",
			"/api/monitors",
			as({
				name: "Closed port",
				config: { kind: "tcp", tcp: { host: "127.0.0.1", port: 9 } },
				downAfter: 1,
			}),
		);
		const id = created.json.id;
		const w = await h.call(
			"POST",
			"/api/maintenance-windows",
			as({
				title: "Upgrade",
				monitorIds: [id],
				startsAt: new Date(Date.now() - 60_000).toISOString(),
				endsAt: new Date(Date.now() + 3_600_000).toISOString(),
			}),
		);
		expect(w.json.active).toBe(true);
		const before = events.length;
		expect(await processCheck(ctx, id)).toMatchObject({
			status: "maintenance",
			emitted: [],
		});
		expect(events.length).toBe(before);
		await h.call("DELETE", `/api/maintenance-windows/${w.json.id}`, as());
		expect(await processCheck(ctx, id)).toMatchObject({
			status: "down",
			emitted: ["monitor.down"],
		});
	});

	test("push monitor: a ping marks it up, status=down marks it down, silence fails it", async () => {
		const created = await h.call(
			"POST",
			"/api/monitors",
			as({
				name: "Nightly backup",
				config: { kind: "push", push: { graceSec: 30 } },
				intervalSec: 3600,
				downAfter: 1,
			}),
		);
		const { id, pushToken } = created.json;
		expect(pushToken).toMatch(/^lsp_/);
		expect((await h.call("GET", "/push/lsp_nope")).status).toBe(404);
		expect((await h.call("GET", `/push/${pushToken}?ping=12`)).status).toBe(
			200,
		);
		const [m] = await h.deps.db
			.select()
			.from(monitor)
			.where(eq(monitor.id, id));
		expect(m?.status).toBe("up");
		expect(m?.lastLatencyMs).toBe(12);
		// Next deadline: interval plus grace.
		expect(
			Math.round(((m?.nextCheckAt.getTime() ?? 0) - Date.now()) / 1000),
		).toBeGreaterThan(3600);
		await h.call("POST", `/push/${pushToken}?status=down&msg=disk%20full`);
		const [d] = await h.deps.db
			.select()
			.from(monitor)
			.where(eq(monitor.id, id));
		expect(d?.status).toBe("down");
		expect(d?.lastError).toBe("disk full");
		// Silence: past the deadline the worker's check records a failure on its own.
		expect(await processCheck(ctx, id)).toMatchObject({ status: "down" });
	});

	test("TLS check reads expiry and announces certificate.expiring once per threshold", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ls-test-uptime-cert-"));
		const p = Bun.spawnSync(
			[
				"openssl",
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				join(dir, "key.pem"),
				"-out",
				join(dir, "cert.pem"),
				"-days",
				"5",
				"-subj",
				"/CN=localhost",
			],
			{ stderr: "pipe" },
		);
		expect(p.exitCode).toBe(0);
		const tls = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			tls: {
				cert: readFileSync(join(dir, "cert.pem"), "utf8"),
				key: readFileSync(join(dir, "key.pem"), "utf8"),
			},
			fetch: () => new Response("ok"),
		});
		try {
			const direct = await tlsCheck(
				{ host: "127.0.0.1", port: tls.port as number, warnDays: [7] },
				5_000,
				{ policy: { allowPrivateHosts: true } },
			);
			const days =
				((direct.certExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
			expect(days).toBeGreaterThan(4);
			expect(days).toBeLessThanOrEqual(5);
			// Self-signed: the expiry is read, and the check fails as untrusted.
			expect(direct.ok).toBe(false);
			expect(direct.error).toContain("not trusted");

			const created = await h.call(
				"POST",
				"/api/monitors",
				as({
					name: "Shop cert",
					config: {
						kind: "tls",
						tls: { host: "127.0.0.1", port: tls.port, warnDays: [30, 7] },
					},
				}),
			);
			const id = created.json.id;
			const expiring = () =>
				events.filter(
					(e) => e.type === "certificate.expiring" && e.resource.id === id,
				);
			await processCheck(ctx, id);
			expect(expiring()).toHaveLength(1);
			expect(expiring()[0]?.payload).toMatchObject({
				hostname: "127.0.0.1",
				daysLeft: 4,
			});
			await processCheck(ctx, id);
			expect(expiring()).toHaveLength(1);
			const [m] = await h.deps.db
				.select()
				.from(monitor)
				.where(eq(monitor.id, id));
			expect(m?.certWarnedDays).toBe(7);
			expect(m?.certExpiresAt).toBeInstanceOf(Date);
		} finally {
			tls.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("suggestions and permissions", async () => {
		const s = await h.call("GET", "/api/monitors/suggestions", as());
		expect(s.status).toBe(200);
		expect(Array.isArray(s.json)).toBe(true);
		expect((await h.call("GET", "/api/monitors")).status).toBe(401);
		const bad = await h.call(
			"POST",
			"/api/status-pages",
			as({
				title: "x",
				slug: "x2",
				sections: [{ name: "", monitors: [{ monitorId: "mon_nope" }] }],
			}),
		);
		expect(bad.status).toBe(400);
	});
});
