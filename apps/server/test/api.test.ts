import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoute, z } from "@hono/zod-openapi";
import { auditLog, envVar } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { assertMutationsAudited } from "../src/audit.ts";
import { envelope } from "../src/events.ts";
import { router } from "../src/openapi.ts";
import { websocket } from "../src/ws.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const viewer = {
	name: "Vic Viewer",
	email: "viewer@example.com",
	password: "viewer password 1",
};

const imageSpec = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [{ target: 80, protocol: "tcp" }],
	replicas: 1,
	resources: {},
	placement: [],
};

describe.skipIf(!hasDocker)("api", () => {
	let h: Harness;
	let ownerCookie: string;
	let viewerCookie: string;
	let orgId: string;
	let serviceId: string;
	const asOwner = () => ({ headers: { cookie: ownerCookie } });
	const asViewer = () => ({ headers: { cookie: viewerCookie } });

	beforeAll(async () => {
		h = await startHarness();
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		ownerCookie = await h.signIn(owner.email, owner.password);
	}, 60_000);
	afterAll(() => h?.close());

	describe("auth", () => {
		test("sign-up, sign-in and session", async () => {
			const signUp = await h.call("POST", "/api/auth/sign-up/email", {
				body: viewer,
			});
			expect(signUp.status).toBe(200);
			viewerCookie = await h.signIn(viewer.email, viewer.password);
			const session = await h.call("GET", "/api/auth/get-session", asViewer());
			expect(session.json.user).toMatchObject({
				email: viewer.email,
				kind: "human",
			});
			// Signed in but in no organization: not an actor of any org yet.
			expect((await h.call("GET", "/api/me", asViewer())).status).toBe(401);
			expect((await h.call("GET", "/api/me")).status).toBe(401);
		});

		test("an owner adds the user as viewer", async () => {
			const added = await h.call("POST", "/api/members", {
				...asOwner(),
				body: { email: viewer.email, role: "viewer" },
			});
			expect(added.status).toBe(201);
			const me = await h.call("GET", "/api/me", asViewer());
			expect(me.json).toMatchObject({
				kind: "user",
				organizationId: orgId,
				roles: ["viewer"],
			});
		});

		test("API keys: create, use via x-api-key and Bearer, revoke", async () => {
			const created = await h.call("POST", "/api/api-keys", {
				...asOwner(),
				body: { name: "ci" },
			});
			expect(created.status).toBe(201);
			const key: string = created.json.key;
			expect(key.startsWith("lsk_")).toBe(true);
			const variants: Record<string, string>[] = [
				{ "x-api-key": key },
				{ authorization: `Bearer ${key}` },
			];
			for (const headers of variants) {
				const me = await h.call("GET", "/api/me", { headers });
				expect(me.status).toBe(200);
				expect(me.json).toMatchObject({
					kind: "apikey",
					id: created.json.id,
					roles: ["owner"],
				});
			}
			const listed = await h.call("GET", "/api/api-keys", asOwner());
			expect(listed.json.map((k: { id: string }) => k.id)).toContain(
				created.json.id,
			);
			expect(JSON.stringify(listed.json)).not.toContain(key);
			const revoked = await h.call(
				"DELETE",
				`/api/api-keys/${created.json.id}`,
				asOwner(),
			);
			expect(revoked.status).toBe(204);
			expect(
				(await h.call("GET", "/api/me", { headers: { "x-api-key": key } }))
					.status,
			).toBe(401);
			expect(
				(
					await h.call("GET", "/api/me", {
						headers: { "x-api-key": "lsk_nope" },
					})
				).status,
			).toBe(401);
		});
	});

	test("a permission denial is audited as denied", async () => {
		const res = await h.call("POST", "/api/projects", {
			...asViewer(),
			body: { name: "Sneaky" },
		});
		expect(res.status).toBe(403);
		expect(res.json.error.code).toBe("forbidden");
		const viewerId = (await h.call("GET", "/api/me", asViewer())).json.id;
		const rows = await h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "project.create"),
					eq(auditLog.actorId, viewerId),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			outcome: "denied",
			actorKind: "user",
			organizationId: orgId,
			resourceType: "project",
		});
		expect(rows[0]?.requestId).toBeTruthy();
	});

	test("folders nest at most two levels over HTTP", async () => {
		const create = (name: string, parentId?: string) =>
			h.call("POST", "/api/folders", {
				...asOwner(),
				body: { name, parentId },
			});
		const a = await create("A");
		const b = await create("B", a.json.id);
		expect([a.status, b.status]).toEqual([201, 201]);
		const c = await create("C", b.json.id);
		expect(c.status).toBe(400);
		expect(c.json.error.details).toEqual({ reason: "parent_is_subfolder" });
		const d = await create("D");
		const move = await h.call("PATCH", `/api/folders/${a.json.id}`, {
			...asOwner(),
			body: { parentId: d.json.id },
		});
		expect(move.status).toBe(400);
		expect(move.json.error.details).toEqual({ reason: "folder_has_children" });
		const tree = await h.call("GET", "/api/folders", asViewer());
		const top = tree.json.find((f: { id: string }) => f.id === a.json.id);
		expect(top.children.map((f: { id: string }) => f.id)).toEqual([b.json.id]);
	});

	test("projects, services and deploy", async () => {
		const project = await h.call("POST", "/api/projects", {
			...asOwner(),
			body: { name: "Shop" },
		});
		expect(project.status).toBe(201);
		const envs = await h.call(
			"GET",
			`/api/projects/${project.json.id}/environments`,
			asOwner(),
		);
		expect(envs.json).toHaveLength(1);
		const bad = await h.call(
			"POST",
			`/api/environments/${envs.json[0].id}/services`,
			{
				...asOwner(),
				body: {
					name: "Web",
					spec: { ...imageSpec, build: { type: "railpack" } },
				},
			},
		);
		expect(bad.status).toBe(400);
		expect(bad.json.error.code).toBe("validation_failed");
		const svc = await h.call(
			"POST",
			`/api/environments/${envs.json[0].id}/services`,
			{
				...asOwner(),
				body: { name: "Web", spec: imageSpec },
			},
		);
		expect(svc.status).toBe(201);
		expect(svc.json).toMatchObject({
			kind: "application",
			slug: "web",
			desiredState: "running",
		});
		serviceId = svc.json.id;

		const deploy = await h.call(
			"POST",
			`/api/services/${serviceId}/deploy`,
			asOwner(),
		);
		expect(deploy.status).toBe(202);
		expect(deploy.json).toMatchObject({ status: "queued", trigger: "manual" });
		const list = await h.call(
			"GET",
			`/api/services/${serviceId}/deployments`,
			asViewer(),
		);
		expect(list.json.map((d: { id: string }) => d.id)).toEqual([
			deploy.json.id,
		]);
		expect(
			(await h.call("POST", `/api/services/${serviceId}/deploy`, asViewer()))
				.status,
		).toBe(403);

		const generated = await h.call(
			"POST",
			`/api/services/${serviceId}/domains/generated`,
			{
				...asOwner(),
				body: { port: 80 },
			},
		);
		expect(generated.status).toBe(201);
		expect(generated.json.hostname).toBe(
			`web-${serviceId.slice(-6)}.203-0-113-7.sslip.io`,
		);

		const listed = await h.call(
			"GET",
			`/api/environments/${envs.json[0].id}/services`,
			asViewer(),
		);
		expect(listed.json).toHaveLength(1);
		expect(listed.json[0]).toMatchObject({
			id: serviceId,
			status: { observed: "unknown", observedAt: null },
			latestDeployment: { id: deploy.json.id, status: "queued" },
			domains: [generated.json.hostname],
		});

		const projects = await h.call("GET", "/api/projects", asViewer());
		expect(
			projects.json.find((p: { id: string }) => p.id === project.json.id),
		).toMatchObject({
			environments: [{ id: envs.json[0].id, kind: "production" }],
			services: [{ id: serviceId, name: "Web", status: "unknown" }],
		});

		const summary = await h.call("GET", "/api/home/summary", asViewer());
		expect(summary.json.services.unknown).toBe(1);
		expect(summary.json.recentDeployments[0]).toMatchObject({
			id: deploy.json.id,
			status: "queued",
			service: { id: serviceId, name: "Web" },
			environment: { name: "Production" },
			project: { id: project.json.id, name: "Shop" },
		});
	});

	test("source and DNS checks need the right role and refuse unsafe input", async () => {
		const source = {
			type: "git",
			repository: "file:///etc",
			branch: "main",
			path: "/",
		};
		expect(
			(
				await h.call("POST", "/api/services/check-source", {
					...asViewer(),
					body: source,
				})
			).status,
		).toBe(403);
		const local = await h.call("POST", "/api/services/check-source", {
			...asOwner(),
			body: source,
		});
		expect(local.status).toBe(200);
		expect(local.json).toMatchObject({ ok: false });
		expect(
			(
				await h.call("POST", "/api/setup/dns-check", {
					...asViewer(),
					body: { hostname: "ls-check.example.com" },
				})
			).status,
		).toBe(403);
	});

	test("serves the web app with a client-side fallback, never over /api", async () => {
		for (const path of ["/", "/projects/prj_x?env=1"])
			expect((await h.call("GET", path)).json).toContain(
				"<title>shell</title>",
			);
		expect((await h.call("GET", "/app.js")).json).toBe("console.log(1)");
		const api = await h.call("GET", "/api/nope");
		expect(api.status).toBe(404);
		expect(api.json.error.code).toBe("not_found");
	});

	test("env var values are encrypted and secrets masked without read:secrets", async () => {
		const create = (key: string, value: string, isSecret: boolean) =>
			h.call("POST", "/api/env-vars", {
				...asOwner(),
				body: {
					scope: "service",
					scopeId: serviceId,
					key,
					value,
					isSecret,
					isBuildTime: false,
				},
			});
		expect(
			(await create("DATABASE_PASSWORD", "s3cr3t-value", true)).status,
		).toBe(201);
		expect((await create("LOG_LEVEL", "debug", false)).status).toBe(201);
		const query = `/api/env-vars?scope=service&scopeId=${serviceId}`;
		const valueFor = (
			rows: { key: string; value: string | null }[],
			key: string,
		) => rows.find((r) => r.key === key)?.value;

		const forViewer = (await h.call("GET", query, asViewer())).json;
		expect(valueFor(forViewer, "DATABASE_PASSWORD")).toBeNull();
		expect(valueFor(forViewer, "LOG_LEVEL")).toBe("debug");
		const forOwner = (await h.call("GET", query, asOwner())).json;
		expect(valueFor(forOwner, "DATABASE_PASSWORD")).toBe("s3cr3t-value");

		const stored = await h.deps.db.select().from(envVar);
		for (const row of stored)
			expect(row.valueEncrypted.startsWith("v1:")).toBe(true);
		const audit = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "env_var.create"));
		expect(JSON.stringify(audit)).not.toContain("s3cr3t-value");
	});

	test("audit log pages with a cursor", async () => {
		const first = await h.call("GET", "/api/audit-log?limit=2", asOwner());
		expect(first.json.items).toHaveLength(2);
		const second = await h.call(
			"GET",
			`/api/audit-log?limit=2&cursor=${first.json.nextCursor}`,
			asOwner(),
		);
		const ids = [...first.json.items, ...second.json.items].map(
			(e: { id: string }) => e.id,
		);
		expect(new Set(ids).size).toBe(4);
		expect((await h.call("GET", "/api/audit-log", asViewer())).status).toBe(
			403,
		);
	});

	test("health, OpenAPI document and docs page", async () => {
		expect((await h.call("GET", "/api/health")).json).toEqual({
			status: "ok",
			db: true,
			redis: true,
		});
		const doc = await h.call("GET", "/api/openapi.json");
		expect(doc.json.openapi).toBe("3.1.0");
		expect(Object.keys(doc.json.paths)).toContain("/api/services/{id}/deploy");
		expect((await h.call("GET", "/api/docs")).status).toBe(200);
	});

	test("a mutating route that bypasses mutation() fails the boot check", () => {
		const rogue = router().openapi(
			createRoute({
				method: "post",
				path: "/rogue",
				responses: {
					200: {
						description: "ok",
						content: { "application/json": { schema: z.object({}) } },
					},
				},
			}),
			(c) => c.json({}, 200),
		);
		expect(() => assertMutationsAudited(router().route("/api", rogue))).toThrow(
			"mutating routes without audit: POST /api/rogue",
		);
	});

	describe("websocket", () => {
		let server: ReturnType<typeof Bun.serve>;
		beforeAll(() => {
			server = Bun.serve({ port: 0, fetch: h.app.fetch, websocket });
		});
		afterAll(() => server?.stop(true));

		const connect = (headers: Record<string, string>) =>
			new Promise<WebSocket>((resolve, reject) => {
				const ws = new WebSocket(`ws://localhost:${server.port}/ws`, {
					headers,
				});
				ws.onopen = () => resolve(ws);
				ws.onerror = () => reject(new Error("websocket refused"));
			});
		const next = (ws: WebSocket) =>
			new Promise<{ type: string; [k: string]: unknown }>((resolve) => {
				ws.addEventListener(
					"message",
					(m) => resolve(JSON.parse(String(m.data))),
					{ once: true },
				);
			});

		test("refuses unauthenticated upgrades", async () => {
			await expect(connect({})).rejects.toThrow("websocket refused");
		});

		test("delivers a published event to an authorized subscriber", async () => {
			const ws = await connect({ cookie: ownerCookie });
			const subscribed = next(ws);
			ws.send(JSON.stringify({ type: "subscribe", channel: `org:${orgId}` }));
			expect(await subscribed).toEqual({
				type: "subscribed",
				channel: `org:${orgId}`,
			});
			const received = next(ws);
			const event = envelope(
				"deployment.queued",
				orgId,
				{ type: "deployment", id: "dep_x" },
				{ serviceId },
			);
			await h.deps.bus.publishEvent(event);
			const msg = await received;
			expect(msg).toMatchObject({
				type: "event",
				channel: `org:${orgId}`,
				event: { id: event.id },
			});
			ws.close();
		});

		test("refuses a channel of an organization the actor cannot read", async () => {
			const ws = await connect({ cookie: viewerCookie });
			const reply = next(ws);
			ws.send(
				JSON.stringify({ type: "subscribe", channel: "org:someone-else" }),
			);
			expect(await reply).toMatchObject({
				type: "error",
				channel: "org:someone-else",
				code: "forbidden",
			});
			const own = next(ws);
			ws.send(
				JSON.stringify({ type: "subscribe", channel: `service:${serviceId}` }),
			);
			expect(await own).toEqual({
				type: "subscribed",
				channel: `service:${serviceId}`,
			});
			ws.close();
		});
	});
});
