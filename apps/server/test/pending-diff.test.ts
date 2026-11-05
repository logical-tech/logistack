import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encrypt, specSnapshot } from "@logistack/core";
import { deployment } from "@logistack/db";
import { compileInput, loadService } from "@logistack/worker/load";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const SECRET_BEFORE = "sk-live-BEFORE-7f3a9c";
const SECRET_AFTER = "sk-live-AFTER-1b2d4e";

const imageSpec = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [{ target: 80, protocol: "tcp" }],
	replicas: 1,
	resources: { memoryMb: 512 },
	placement: [],
};

describe.skipIf(!hasDocker)("pending diff", () => {
	let h: Harness;
	let serviceId: string;
	let cookie: string;
	const auth = () => ({ headers: { cookie } });
	const setVars = (vars: Record<string, [string, boolean]>) =>
		h.call("PUT", `/api/services/${serviceId}/env-vars`, {
			...auth(),
			body: {
				variables: Object.entries(vars).map(([key, [value, isSecret]]) => ({
					key,
					value,
					isSecret,
					isBuildTime: false,
				})),
			},
		});

	beforeAll(async () => {
		h = await startHarness({ area: "qw5", label: "qw5" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
		const projectId = (
			await h.call("POST", "/api/projects", {
				...auth(),
				body: { name: "Shop" },
			})
		).json.id;
		const environmentId = (
			await h.call("GET", `/api/projects/${projectId}/environments`, auth())
		).json[0].id;
		serviceId = (
			await h.call("POST", `/api/environments/${environmentId}/services`, {
				...auth(),
				body: { name: "Web", spec: imageSpec },
			})
		).json.id;
	}, 90_000);
	afterAll(() => h?.close());

	test("no healthy deployment with a recorded spec: no baseline", async () => {
		const res = await h.call(
			"GET",
			`/api/services/${serviceId}/pending-diff`,
			auth(),
		);
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ baseline: null, changes: [] });
	});

	test("lists what changed since the healthy deployment and never a secret value", async () => {
		expect(
			(
				await setVars({
					API_URL: ["https://a.example.com", false],
					API_KEY: [SECRET_BEFORE, true],
				})
			).status,
		).toBe(200);
		// What the worker's deploy step records, minus the Docker ids it would resolve.
		const [d] = await h.deps.db
			.insert(deployment)
			.values({
				serviceId,
				trigger: "manual",
				status: "healthy",
				imageRef: "nginx:1.27",
			})
			.returning();
		const dep = d as typeof deployment.$inferSelect;
		const sc = await loadService(h.deps, serviceId, { gitAuth: false });
		if (!sc) throw new Error("service not loaded");
		const input = compileInput(sc, dep, {
			networks: { environment: "env-net-id", ingress: "ingress-net-id" },
			scope: {
				namePrefix: "ls-test-qw5-",
				labels: { "logistack.test": "qw5" },
			},
		});
		await h.deps.db
			.update(deployment)
			.set({
				specSnapshotEncrypted: await encrypt(
					h.deps.masterKey,
					JSON.stringify(specSnapshot(input, sc.env)),
				),
			})
			.where(eq(deployment.id, dep.id));

		const unchanged = await h.call(
			"GET",
			`/api/services/${serviceId}/pending-diff`,
			auth(),
		);
		expect(unchanged.json).toEqual({
			baseline: { deploymentId: dep.id, createdAt: expect.any(String) },
			changes: [],
		});

		await setVars({
			API_URL: ["https://b.example.com", false],
			API_KEY: [SECRET_AFTER, true],
		});
		await h.call("PATCH", `/api/services/${serviceId}`, {
			...auth(),
			body: {
				spec: {
					...imageSpec,
					source: { type: "image", image: "nginx:1.28" },
					resources: { memoryMb: 1024 },
				},
			},
		});

		const res = await h.call(
			"GET",
			`/api/services/${serviceId}/pending-diff`,
			auth(),
		);
		expect(res.status).toBe(200);
		expect(res.json.changes.map((c: { summary: string }) => c.summary)).toEqual(
			[
				"image nginx:1.27 → nginx:1.28",
				"env var API_KEY changed",
				"env var API_URL changed",
				"memory limit 512 MB → 1 GB",
			],
		);
		const body = JSON.stringify(res.json);
		expect(body).not.toContain(SECRET_BEFORE);
		expect(body).not.toContain(SECRET_AFTER);
		expect(body).toContain("https://b.example.com");
	});
});
