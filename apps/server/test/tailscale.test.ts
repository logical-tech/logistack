import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decrypt } from "@logistack/core";
import {
	auditLog,
	tailscaleNetwork,
	tailscalePublication,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("tailscale api", () => {
	let h: Harness;
	let cookie: string;
	let serviceId: string;
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "tailscale", label: "tailscale" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const projectId = (
			await h.call("POST", "/api/projects", { ...as(), body: { name: "Ts" } })
		).json.id;
		const envId = (
			await h.call("GET", `/api/projects/${projectId}/environments`, as())
		).json[0].id;
		serviceId = (
			await h.call("POST", `/api/environments/${envId}/services`, {
				...as(),
				body: {
					name: "grafana",
					resourceProfile: null,
					spec: {
						kind: "application",
						source: { type: "image", image: "grafana/grafana:12.2.0" },
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

	afterAll(() => h?.close(), 60_000);

	test("enable stores the key encrypted and keeps it out of the audit log", async () => {
		expect((await h.call("GET", "/api/tailscale", as())).json).toEqual({
			enabled: false,
			nodesRunning: false,
			statusMessage: null,
			publications: [],
		});
		expect(
			(
				await h.call("POST", "/api/tailscale/publications", {
					...as(),
					body: { serviceId, hostname: "grafana", port: 3000 },
				})
			).status,
		).toBe(409);
		expect(
			(
				await h.call("PUT", "/api/tailscale", {
					...as(),
					body: { authKey: "nope" },
				})
			).status,
		).toBe(400);

		const key = "tskey-auth-kAbc123CNTRL-secretpart";
		const on = await h.call("PUT", "/api/tailscale", {
			...as(),
			body: { authKey: key },
		});
		expect(on.status).toBe(200);
		expect(on.json.enabled).toBe(true);
		const [row] = await h.deps.db.select().from(tailscaleNetwork);
		expect(row?.authKeyEncrypted).not.toContain("secretpart");
		expect(await decrypt(h.deps.masterKey, row?.authKeyEncrypted ?? "")).toBe(
			key,
		);
		const [audit] = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "tailscale.enable"));
		expect(JSON.stringify(audit?.diff)).not.toContain("secretpart");
	});

	test("publishes a service once per hostname, then disable removes every row", async () => {
		const body = { serviceId, hostname: "Grafana", port: 3000 };
		const pub = await h.call("POST", "/api/tailscale/publications", {
			...as(),
			body,
		});
		expect(pub.status).toBe(201);
		expect(pub.json).toMatchObject({
			hostname: "grafana",
			port: 3000,
			https: true,
			serviceName: "grafana",
		});
		expect(
			(await h.call("POST", "/api/tailscale/publications", { ...as(), body }))
				.status,
		).toBe(409);
		expect(
			(
				await h.call("POST", "/api/tailscale/publications", {
					...as(),
					body: { ...body, hostname: "bad_name" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await h.call("POST", "/api/tailscale/publications", {
					...as(),
					body: {
						...body,
						serviceId: "svc_doesnotexist000000000000",
						hostname: "x",
					},
				})
			).status,
		).toBe(404);
		// The worker has not started tailscaled in this harness, so the test step says so.
		const t = await h.call("POST", "/api/tailscale/test", {
			...as(),
			body: { publicationId: pub.json.id },
		});
		expect(t.json).toMatchObject({
			ok: false,
			message: "tailscaled isn't running yet",
		});

		expect((await h.call("DELETE", "/api/tailscale", as())).status).toBe(204);
		expect(await h.deps.db.select().from(tailscaleNetwork)).toEqual([]);
		expect(await h.deps.db.select().from(tailscalePublication)).toEqual([]);
	});
});
