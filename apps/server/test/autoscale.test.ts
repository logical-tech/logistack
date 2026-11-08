import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, serviceAutoscale } from "@logistack/db";
import { and, asc, eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("autoscale api", () => {
	let h: Harness;
	let cookie: string;
	let viewer: string;
	let projectId: string;
	let envId: string;
	const as = (c = cookie) => ({ headers: { cookie: c } });

	const create = async (
		name: string,
		resources: Record<string, number>,
		extra: Record<string, unknown> = {},
	) =>
		(
			await h.call("POST", `/api/environments/${envId}/services`, {
				...as(),
				body: {
					name,
					resourceProfile: null,
					spec: {
						kind: "application",
						source: { type: "image", image: "nginx:1.27" },
						build: { type: "image" },
						ports: [],
						replicas: 1,
						resources,
						placement: [],
						...extra,
					},
				},
			})
		).json.id as string;

	beforeAll(async () => {
		h = await startHarness({ area: "autoscale", label: "autoscale" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		projectId = (
			await h.call("POST", "/api/projects", { ...as(), body: { name: "As" } })
		).json.id;
		envId = (
			await h.call("GET", `/api/projects/${projectId}/environments`, as())
		).json[0].id;

		const user = { name: "View", email: "viewer@example.com" };
		const password = "viewer password 1234";
		const invite = await h.call("POST", "/api/invitations", {
			...as(),
			body: { email: user.email, role: "viewer" },
		});
		await h.call("POST", "/api/auth/sign-up/email", {
			body: { ...user, password },
		});
		viewer = await h.signIn(user.email, password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			...as(viewer),
			body: { invitationId: invite.json.id },
		});
	}, 120_000);
	afterAll(async () => {
		await h?.close();
	});

	test("unconfigured: defaults and checks; enabling is refused while a blocker fails", async () => {
		const svc = await create("nolimit", {});
		const path = `/api/services/${svc}/autoscale`;
		const got = await h.call("GET", path, as());
		expect(got.status).toBe(200);
		expect(got.json).toMatchObject({
			configured: false,
			enabled: false,
			minReplicas: 1,
			maxReplicas: 3,
			behavior: "balanced",
			targetCpu: 60,
		});
		expect(
			got.json.checks
				.filter((c: { ok: boolean }) => !c.ok)
				.map((c: { id: string }) => c.id),
		).toEqual(["cpu_limit", "healthcheck", "nodes"]);
		const byId = (id: string) =>
			got.json.checks.find((c: { id: string }) => c.id === id);
		// No history yet and no org default: the smallest seeded size.
		expect(byId("cpu_limit").fix).toMatchObject({
			id: "apply_profile",
			redeploy: true,
			changes: [
				{ label: "CPU limit", before: "None", after: "0.25 CPU (Nano)" },
				{ label: "Memory limit" },
			],
		});
		expect(byId("nodes").link).toEqual({
			label: "Add a server",
			to: "/monitoring",
		});

		const refused = await h.call("PUT", path, {
			...as(),
			body: { enabled: true, minReplicas: 1, maxReplicas: 3 },
		});
		expect(refused.status).toBe(400);
		expect(refused.json.error.details.checks).toMatchObject([
			{ id: "cpu_limit" },
		]);
		// Saving it switched off is allowed: the settings wait for the fix.
		expect(
			(
				await h.call("PUT", path, {
					...as(),
					body: { enabled: false, minReplicas: 1, maxReplicas: 3 },
				})
			).status,
		).toBe(200);
	});

	test("enable with a preset, keep the count in range, audit, and refuse bad input", async () => {
		const svc = await create("web", { cpu: 0.5 });
		const path = `/api/services/${svc}/autoscale`;
		const saved = await h.call("PUT", path, {
			...as(),
			body: {
				enabled: true,
				minReplicas: 2,
				maxReplicas: 4,
				behavior: "economical",
				targetCpu: 20,
			},
		});
		expect(saved.status).toBe(200);
		// A preset sets its own target; spec.replicas 1 is below the range, so it starts at 2.
		expect(saved.json).toMatchObject({
			configured: true,
			enabled: true,
			minReplicas: 2,
			maxReplicas: 4,
			behavior: "economical",
			targetCpu: 75,
			targetMemory: null,
			replicas: 2,
		});

		await h.deps.db
			.update(serviceAutoscale)
			.set({ replicas: 4 })
			.where(eq(serviceAutoscale.serviceId, svc));
		const narrowed = await h.call("PUT", path, {
			...as(),
			body: {
				enabled: true,
				minReplicas: 1,
				maxReplicas: 3,
				behavior: "custom",
				targetCpu: 50,
			},
		});
		expect(narrowed.json).toMatchObject({ replicas: 3, targetCpu: 50 });

		const [audit] = await h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "service.autoscale"),
					eq(auditLog.resourceId, svc),
				),
			)
			.orderBy(asc(auditLog.at))
			.limit(1);
		expect(audit).toMatchObject({
			outcome: "success",
			diff: { after: { targetCpu: 75 }, before: null },
		});

		for (const body of [
			{ enabled: true, minReplicas: 3, maxReplicas: 2 },
			{ enabled: true, minReplicas: 1, maxReplicas: 21 },
			{ enabled: true, minReplicas: 1, maxReplicas: 3, behavior: "custom" },
			// No memory limit to measure against.
			{ enabled: true, minReplicas: 1, maxReplicas: 3, targetMemory: 70 },
		])
			expect((await h.call("PUT", path, { ...as(), body })).status).toBe(400);

		expect(
			(
				await h.call("PUT", path, {
					...as(viewer),
					body: { enabled: false, minReplicas: 1, maxReplicas: 3 },
				})
			).status,
		).toBe(403);
		expect((await h.call("GET", path, as(viewer))).status).toBe(200);
	});

	test("volumes and host ports block; the preview needs history", async () => {
		const hostPort = await create(
			"hostport",
			{ cpu: 1 },
			{ ports: [{ target: 80, published: 18080, protocol: "tcp" }] },
		);
		const res = await h.call("PUT", `/api/services/${hostPort}/autoscale`, {
			...as(),
			body: { enabled: true, minReplicas: 1, maxReplicas: 3 },
		});
		expect(res.status).toBe(400);
		expect(res.json.error.details.checks).toMatchObject([{ id: "host_ports" }]);

		const svc = await create("quiet", { cpu: 0.5 });
		const preview = await h.call(
			"GET",
			`/api/services/${svc}/autoscale/preview?minReplicas=1&maxReplicas=3`,
			as(),
		);
		expect(preview.status).toBe(200);
		expect(preview.json).toEqual({ points: [], enoughData: false });
	});

	test("the manifest exports autoscaling and apply saves a change", async () => {
		const svc = await create("api", { cpu: 0.5 });
		await h.call("PUT", `/api/services/${svc}/autoscale`, {
			...as(),
			body: { enabled: true, minReplicas: 1, maxReplicas: 3 },
		});
		const manifest = (
			await h.call("GET", `/api/environments/${envId}/manifest`, as())
		).json;
		const api = manifest.environment.services.find(
			(s: { slug: string }) => s.slug === "api",
		);
		expect(api.autoscale).toEqual({
			enabled: true,
			minReplicas: 1,
			maxReplicas: 3,
			behavior: "balanced",
			targetMemory: null,
		});

		api.autoscale.maxReplicas = 5;
		const dry = await h.call("POST", `/api/environments/${envId}/apply`, {
			...as(),
			body: { manifest, dryRun: true },
		});
		expect(dry.status).toBe(200);
		expect(JSON.stringify(dry.json.changes)).toContain("autoscale changed");
		const applied = await h.call("POST", `/api/environments/${envId}/apply`, {
			...as(),
			body: { manifest },
		});
		expect(applied.status).toBe(200);
		expect(
			(await h.call("GET", `/api/services/${svc}/autoscale`, as())).json
				.maxReplicas,
		).toBe(5);
		// Applying the same manifest again changes nothing.
		const again = await h.call("POST", `/api/environments/${envId}/apply`, {
			...as(),
			body: { manifest, dryRun: true },
		});
		expect(JSON.stringify(again.json.changes)).not.toContain("autoscale");
	});
});
