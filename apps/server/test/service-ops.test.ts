import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, deployment } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { createBus } from "../../worker/src/bus.ts";
import { followDeploymentLog, type StreamMessage } from "../src/streams.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const dev = {
	name: "Dana Dev",
	email: "dana@example.com",
	password: "dana password 12",
};

const imageSpec = {
	kind: "application",
	source: { type: "image", image: "nginx:alpine" },
	build: { type: "image" },
	ports: [{ target: 80, protocol: "tcp" }],
	replicas: 1,
	resources: {},
	placement: [],
};

describe.skipIf(!hasDocker)("service operations", () => {
	let h: Harness;
	let orgId: string;
	let projectId: string;
	let environmentId: string;
	let serviceId: string;
	let ownerCookie: string;
	let devCookie: string;
	const asOwner = () => ({ headers: { cookie: ownerCookie } });
	const asDev = () => ({ headers: { cookie: devCookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "svc", label: "svc" });
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		ownerCookie = await h.signIn(owner.email, owner.password);
		projectId = (
			await h.call("POST", "/api/projects", {
				...asOwner(),
				body: { name: "Shop" },
			})
		).json.id;
		environmentId = (
			await h.call("GET", `/api/projects/${projectId}/environments`, asOwner())
		).json[0].id;
		serviceId = (
			await h.call("POST", `/api/environments/${environmentId}/services`, {
				...asOwner(),
				body: { name: "Web", spec: imageSpec },
			})
		).json.id;

		const invite = await h.call("POST", "/api/invitations", {
			...asOwner(),
			body: { email: dev.email, role: "developer" },
		});
		await h.call("POST", "/api/auth/sign-up/email", { body: dev });
		devCookie = await h.signIn(dev.email, dev.password);
		const accepted = await h.call(
			"POST",
			"/api/auth/organization/accept-invitation",
			{ ...asDev(), body: { invitationId: invite.json.id } },
		);
		expect(accepted.status).toBe(200);
	}, 90_000);
	afterAll(() => h?.close());

	async function insertDeployment(
		values: Partial<typeof deployment.$inferInsert>,
	) {
		const [row] = await h.deps.db
			.insert(deployment)
			.values({ serviceId, trigger: "manual", ...values })
			.returning();
		return row as typeof deployment.$inferSelect;
	}

	test("rollback queues a rollback deployment that reuses the healthy image, not a build", async () => {
		const healthy = await insertDeployment({
			status: "healthy",
			imageRef: "registry.local/acme/web:dep_old",
			commitSha: "0123456789abcdef",
			commitMessage: "known good",
		});
		const res = await h.call(
			"POST",
			`/api/deployments/${healthy.id}/rollback`,
			asDev(),
		);
		expect(res.status).toBe(202);
		expect(res.json).toMatchObject({
			serviceId,
			status: "queued",
			trigger: "rollback",
			imageRef: "registry.local/acme/web:dep_old",
			commitSha: "0123456789abcdef",
			commitMessage: "known good",
		});
		expect(res.json.id).not.toBe(healthy.id);

		const failed = await insertDeployment({
			status: "failed",
			imageRef: "registry.local/acme/web:dep_bad",
		});
		const refused = await h.call(
			"POST",
			`/api/deployments/${failed.id}/rollback`,
			asDev(),
		);
		expect(refused.status).toBe(409);

		const [audit] = await h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "deployment.rollback"),
					eq(auditLog.outcome, "success"),
				),
			);
		expect(audit).toMatchObject({
			resourceId: res.json.id,
			diff: {
				rollbackOf: healthy.id,
				imageRef: "registry.local/acme/web:dep_old",
			},
		});
	});

	test("cancel stops a queued deployment and refuses one Swarm already owns", async () => {
		const queued = await insertDeployment({});
		const res = await h.call(
			"POST",
			`/api/deployments/${queued.id}/cancel`,
			asDev(),
		);
		expect(res.status).toBe(200);
		expect(res.json.status).toBe("cancelled");
		const deploying = await insertDeployment({ status: "deploying" });
		const refused = await h.call(
			"POST",
			`/api/deployments/${deploying.id}/cancel`,
			asDev(),
		);
		expect(refused.status).toBe(409);
	});

	test("stop and start set the desired state", async () => {
		const stop = await h.call(
			"POST",
			`/api/services/${serviceId}/stop`,
			asDev(),
		);
		expect(stop.json.desiredState).toBe("stopped");
		const start = await h.call(
			"POST",
			`/api/services/${serviceId}/start`,
			asDev(),
		);
		expect(start.json.desiredState).toBe("running");
	});

	test("a developer without `exec` is denied a terminal, and the denial is audited", async () => {
		const body = { shell: "sh", rows: 24, cols: 80 };
		const denied = await h.call("POST", `/api/services/${serviceId}/exec`, {
			...asDev(),
			body,
		});
		expect(denied.status).toBe(403);
		expect(denied.json.error.message).toContain("'exec'");
		const rows = await h.deps.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "service.exec"));
		expect(rows.map((r) => r.outcome)).toEqual(["denied"]);
		// The owner passes the permission check; with no running replica it is a conflict, not a 403.
		const owned = await h.call("POST", `/api/services/${serviceId}/exec`, {
			...asOwner(),
			body,
		});
		expect(owned.status).toBe(409);
	});

	test("the env view lists every inherited scope, flags overrides and masks secrets without read:secrets", async () => {
		const put = (
			scope: string,
			scopeId: string,
			key: string,
			value: string,
			isSecret = false,
		) =>
			h.call("POST", "/api/env-vars", {
				...asOwner(),
				body: { scope, scopeId, key, value, isSecret, isBuildTime: false },
			});
		expect((await put("organization", orgId, "LOG_LEVEL", "info")).status).toBe(
			201,
		);
		await put("project", projectId, "DATABASE_URL", "postgres://project", true);
		await put("environment", environmentId, "LOG_LEVEL", "warn");
		const replaced = await h.call(
			"PUT",
			`/api/services/${serviceId}/env-vars`,
			{
				...asOwner(),
				body: {
					variables: [
						{
							key: "DATABASE_URL",
							value: "postgres://service",
							isSecret: true,
							isBuildTime: false,
						},
						{ key: "PORT", value: "8080", isSecret: false, isBuildTime: false },
					],
				},
			},
		);
		expect(replaced.status).toBe(200);

		const view = (cookie: { headers: { cookie: string } }) =>
			h.call("GET", `/api/services/${serviceId}/env-vars`, cookie);
		const pick = (
			rows: {
				scope: string;
				key: string;
				value: string | null;
				overridden: boolean;
			}[],
		) =>
			rows.map(({ scope, key, value, overridden }) => ({
				scope,
				key,
				value,
				overridden,
			}));

		expect(pick((await view(asDev())).json)).toEqual([
			{ scope: "project", key: "DATABASE_URL", value: null, overridden: true },
			{ scope: "service", key: "DATABASE_URL", value: null, overridden: false },
			{
				scope: "organization",
				key: "LOG_LEVEL",
				value: "info",
				overridden: true,
			},
			{
				scope: "environment",
				key: "LOG_LEVEL",
				value: "warn",
				overridden: false,
			},
			{ scope: "service", key: "PORT", value: "8080", overridden: false },
		]);
		const asOwnerView = pick((await view(asOwner())).json);
		expect(
			asOwnerView.filter((r) => r.key === "DATABASE_URL").map((r) => r.value),
		).toEqual(["postgres://project", "postgres://service"]);

		// A masked secret sent back without a value keeps it; a key left out is deleted.
		const kept = await h.call("PUT", `/api/services/${serviceId}/env-vars`, {
			...asDev(),
			body: {
				variables: [
					{ key: "DATABASE_URL", isSecret: true, isBuildTime: false },
				],
			},
		});
		expect(kept.status).toBe(200);
		expect(
			pick((await view(asOwner())).json).filter((r) => r.scope === "service"),
		).toEqual([
			{
				scope: "service",
				key: "DATABASE_URL",
				value: "postgres://service",
				overridden: false,
			},
		]);
	});

	test("a deployment log replays what is stored, then follows live lines without gaps or repeats", async () => {
		const d = await insertDeployment({ status: "building" });
		const bus = await createBus(h.config.REDIS_URL);
		try {
			for (const n of [0, 1, 2]) await bus.publishLog(d.id, `stored ${n}`);
			const got: StreamMessage[] = [];
			const stop = await followDeploymentLog(
				h.deps,
				d.id,
				"deployment-log:x",
				(m) => got.push(m),
			);
			for (const n of [3, 4]) await bus.publishLog(d.id, `live ${n}`);
			const deadline = Date.now() + 5_000;
			while (got.length < 5 && Date.now() < deadline) await Bun.sleep(20);
			stop();
			expect(
				got.map((m) => (m.type === "line" ? [m.seq, m.line] : m.type)),
			).toEqual([
				[0, "stored 0"],
				[1, "stored 1"],
				[2, "stored 2"],
				[3, "live 3"],
				[4, "live 4"],
			]);

			await h.deps.db
				.update(deployment)
				.set({ status: "failed" })
				.where(eq(deployment.id, d.id));
			const after: StreamMessage[] = [];
			await followDeploymentLog(h.deps, d.id, "deployment-log:x", (m) =>
				after.push(m),
			);
			expect(after.at(-1)).toEqual({
				type: "end",
				channel: "deployment-log:x",
				reason: "failed",
			});
			expect(after.filter((m) => m.type === "line")).toHaveLength(5);
		} finally {
			bus.close();
		}
	});
});
