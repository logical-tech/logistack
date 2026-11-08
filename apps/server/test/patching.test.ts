import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, node } from "@logistack/db";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("node patching routes", () => {
	let h: Harness;
	let cookie: string;
	let devKey: string;
	let nodeIds: string[];
	const as = () => ({ headers: { cookie } });
	const asDev = () => ({ headers: { authorization: `Bearer ${devKey}` } });

	beforeAll(async () => {
		h = await startHarness({ area: "patching", label: "patching" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		nodeIds = (
			await h.deps.db
				.insert(node)
				.values(
					["a", "b"].map((n) => ({
						organizationId: orgId,
						swarmNodeId: `swarm-${n}`,
						hostname: n,
						address: "10.0.0.1",
						role: "worker" as const,
					})),
				)
				.returning()
		).map((r) => r.id);
		devKey = (
			await h.call("POST", "/api/api-keys", {
				...as(),
				body: {
					name: "dev",
					scopes: [
						{ role: "developer", scope: { kind: "organization", id: orgId } },
					],
				},
			})
		).json.key;
	}, 90_000);
	afterAll(() => h?.close());

	test("nodes never scanned list as empty", async () => {
		const r = await h.call("GET", "/api/patching/nodes", as());
		expect(r.status).toBe(200);
		expect(r.json).toHaveLength(2);
		expect(r.json[0]).toMatchObject({ updates: [], scannedAt: null });
		const one = await h.call("GET", `/api/nodes/${nodeIds[0]}/patches`, as());
		expect(one.json.nodeId).toBe(nodeIds[0]);
	});

	test("a scan of a node whose agent is offline is a conflict", async () => {
		const r = await h.call(
			"POST",
			`/api/nodes/${nodeIds[0]}/patches/scan`,
			as(),
		);
		expect(r.status).toBe(409);
	});

	test("runs: admins only, one active at a time, a queued one cancels at once", async () => {
		const body = { nodeIds, securityOnly: true };
		expect(
			(await h.call("POST", "/api/patching/runs", { ...asDev(), body })).status,
		).toBe(403);
		expect(
			(
				await h.call("POST", "/api/patching/runs", {
					...as(),
					body: { nodeIds: ["nod_nope"] },
				})
			).status,
		).toBe(404);
		const run = await h.call("POST", "/api/patching/runs", { ...as(), body });
		expect(run.status).toBe(201);
		expect(run.json).toMatchObject({
			state: "queued",
			securityOnly: true,
			reboot: "if_needed",
			trigger: "manual",
		});
		expect(run.json.nodes.map((n: { hostname: string }) => n.hostname)).toEqual(
			["a", "b"],
		);
		expect(
			(await h.call("POST", "/api/patching/runs", { ...as(), body })).status,
		).toBe(409);
		const cancel = await h.call(
			"POST",
			`/api/patching/runs/${run.json.id}/cancel`,
			as(),
		);
		expect(cancel.json.state).toBe("cancelled");
		expect((await h.call("GET", "/api/patching/runs", as())).json).toHaveLength(
			1,
		);
		const audit = await h.deps.db
			.select({ action: auditLog.action })
			.from(auditLog)
			.where(eq(auditLog.resourceId, run.json.id));
		expect(audit.map((a) => a.action).sort()).toEqual([
			"patch_run.cancel",
			"patch_run.create",
		]);
	});

	test("the patch window validates its cron and round-trips", async () => {
		expect(
			(await h.call("GET", "/api/patching/policy", as())).json,
		).toMatchObject({
			enabled: false,
		});
		const bad = await h.call("PUT", "/api/patching/policy", {
			...as(),
			body: {
				enabled: true,
				cron: "every sunday",
				timezone: "UTC",
				securityOnly: true,
				reboot: "if_needed",
			},
		});
		expect(bad.status).toBe(400);
		const policy = {
			enabled: true,
			cron: "0 4 * * 0",
			timezone: "Europe/Rome",
			securityOnly: false,
			reboot: "never",
		};
		expect(
			(await h.call("PUT", "/api/patching/policy", { ...as(), body: policy }))
				.status,
		).toBe(200);
		expect((await h.call("GET", "/api/patching/policy", as())).json).toEqual(
			policy,
		);
	});
});
