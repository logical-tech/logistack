import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog } from "@logistack/db";
import { eq } from "drizzle-orm";
import { DRAIN_STATUS_KEY } from "../src/agent-gateway.ts";
import { buildDrainsConfig } from "../src/drains.ts";
import { redisFor } from "../src/redis.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("log drains api", () => {
	let h: Harness;
	let cookie: string;
	let projectId: string;
	let serviceId: string;
	const as = () => ({ headers: { cookie } });
	// A literal public address: no DNS lookup, and it passes the private-host policy.
	const loki = {
		kind: "loki",
		url: "https://1.1.1.1",
		password: "hunter2",
		username: "u",
	};

	beforeAll(async () => {
		h = await startHarness({ area: "drains", label: "drains" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		projectId = (
			await h.call("POST", "/api/projects", { ...as(), body: { name: "Shop" } })
		).json.id;
		const envId = (
			await h.call("GET", `/api/projects/${projectId}/environments`, as())
		).json[0].id;
		serviceId = (
			await h.call("POST", `/api/environments/${envId}/services`, {
				...as(),
				body: {
					name: "web",
					resourceProfile: null,
					spec: {
						kind: "application",
						source: { type: "image", image: "nginx:1.27" },
						build: { type: "image" },
						ports: [],
						replicas: 1,
						resources: {},
						placement: [],
					},
				},
			})
		).json.id;
	}, 120_000);
	afterAll(async () => {
		await h?.close();
	});

	test("create validates the config and refuses private hosts", async () => {
		const bad = await h.call("POST", "/api/log-drains", {
			...as(),
			body: {
				name: "x",
				config: { kind: "loki" },
				projectIds: [],
				serviceIds: [],
			},
		});
		expect(bad.status).toBe(400);
		const priv = await h.call("POST", "/api/log-drains", {
			...as(),
			body: {
				name: "x",
				config: { kind: "loki", url: "http://127.0.0.1:3100" },
				projectIds: [],
				serviceIds: [],
			},
		});
		expect(priv.status).toBe(400);
		expect(priv.json.error.message).toContain("private address");
		const foreign = await h.call("POST", "/api/log-drains", {
			...as(),
			body: {
				name: "x",
				config: loki,
				projectIds: ["prj_nope"],
				serviceIds: [],
			},
		});
		expect(foreign.status).toBe(404);
	});

	test("create, list without secrets, route to agents, health, update, delete", async () => {
		const created = await h.call("POST", "/api/log-drains", {
			...as(),
			body: {
				name: "Loki",
				config: loki,
				projectIds: [projectId],
				serviceIds: [],
			},
		});
		expect(created.status).toBe(201);
		const id = created.json.id as string;
		expect(created.json).toMatchObject({
			kind: "loki",
			target: "https://1.1.1.1/loki/api/v1/push",
			enabled: true,
			health: "unknown",
			nodes: [],
		});
		const list = await h.call("GET", "/api/log-drains", as());
		expect(JSON.stringify(list.json)).not.toContain("hunter2");

		const [audit] = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.resourceId, id));
		expect(audit?.action).toBe("log_drain.create");
		expect(JSON.stringify(audit?.diff)).not.toContain("hunter2");

		const cfg = await buildDrainsConfig(h.deps.db, h.deps.masterKey);
		expect(cfg.drains).toEqual([{ id, config: { ...loki, kind: "loki" } }]);
		expect(cfg.routes[serviceId]).toMatchObject({
			drainIds: [id],
			meta: { project: "Shop", service: "web", organization: "Acme" },
		});

		await redisFor(h.config.REDIS_URL).hset(
			DRAIN_STATUS_KEY(id),
			"node-a",
			JSON.stringify({
				drainId: id,
				state: "failing",
				lastSuccessAt: null,
				lastFailureAt: Date.now(),
				lastError: "HTTP 401",
				sentLines: 0,
				droppedLines: 12,
				queuedLines: 3,
				queuedBytes: 300,
				hostname: "a",
				at: Date.now(),
			}),
		);
		const failing = (await h.call("GET", "/api/log-drains", as())).json[0];
		expect(failing).toMatchObject({
			health: "failing",
			nodes: [{ nodeId: "node-a", lastError: "HTTP 401", droppedLines: 12 }],
		});

		const kindChange = await h.call("PATCH", `/api/log-drains/${id}`, {
			...as(),
			body: { config: { kind: "datadog", apiKey: "k" } },
		});
		expect(kindChange.status).toBe(400);
		const paused = await h.call("PATCH", `/api/log-drains/${id}`, {
			...as(),
			body: { enabled: false, projectIds: [], serviceIds: [serviceId] },
		});
		expect(paused.status).toBe(200);
		expect(paused.json).toMatchObject({
			enabled: false,
			serviceIds: [serviceId],
		});
		expect(
			(await buildDrainsConfig(h.deps.db, h.deps.masterKey)).drains,
		).toEqual([]);

		expect((await h.call("DELETE", `/api/log-drains/${id}`, as())).status).toBe(
			204,
		);
		expect((await h.call("GET", "/api/log-drains", as())).json).toEqual([]);
	});

	test("a test event needs an online node", async () => {
		const res = await h.call("POST", "/api/log-drains/test", {
			...as(),
			body: { config: loki },
		});
		expect(res.status).toBe(400);
		expect(res.json.error.message).toContain("no online node");
	});
});
