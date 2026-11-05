import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildInventory } from "../src/migration/dokploy/inventory.ts";
import { planMigration } from "../src/migration/import.ts";
import { runQueues } from "../src/run-queues.ts";
import { app, db, snapshot } from "./fixtures/dokploy-snapshot.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("migration wizard routes", () => {
	let h: Harness;
	let cookie: string;
	let migrationId: string;
	const api = (method: string, path: string) =>
		h.call(method, `/api${path}`, { headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "migroutes", label: "migroutes" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		migrationId = await planMigration(
			h.deps,
			orgId,
			"dokploy",
			buildInventory(
				snapshot({
					applications: [
						app({ applicationId: "web", env: "SECRET_KEY=fake-route-secret" }),
					],
					databases: [
						db({
							id: "vec",
							engine: "postgres",
							dockerImage: "pgvector/pgvector:pg16",
						}),
					],
				}),
			),
		);
	}, 60_000);
	afterAll(() => h?.close());

	test("the source says what install.sh found and which migration to resume", async () => {
		expect((await api("GET", "/migrations/source")).json).toEqual({
			source: null,
			migrationId,
		});
		const create = await api("POST", "/migrations");
		expect(create.status).toBe(409);
		expect(create.json.error.message).toContain("no Dokploy");
	});

	test("a migration shows its items with notes, never a value", async () => {
		const res = await api("GET", `/migrations/${migrationId}`);
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({
			id: migrationId,
			source: "dokploy",
			status: "planned",
			proxy: { status: "not_started", probes: [] },
		});
		const [vec, web] = res.json.items;
		expect(web).toMatchObject({
			kind: "application",
			name: "web",
			project: "Shop",
			environment: "production",
			status: "planned",
			support: "full",
			services: [
				{
					slug: "web-abc123",
					kind: "application",
					running: true,
					stateful: false,
				},
			],
		});
		expect(vec).toMatchObject({ status: "skipped", support: "unsupported" });
		expect(JSON.stringify(res.json)).not.toContain("fake-route-secret");
	});

	test("Dokploy is not removed while traffic still goes through it", async () => {
		const res = await api("POST", `/migrations/${migrationId}/decommission`);
		expect(res.status).toBe(409);
		expect(res.json.error.message).toContain("cannot remove Dokploy yet");
		const view = (await api("GET", `/migrations/${migrationId}`)).json;
		expect(view.decommission).toMatchObject({
			status: "not_started",
			removed: [],
		});
		expect(view.decommissionBlocker).toBeTruthy();
	});

	test("skipping is undone only for what can be imported", async () => {
		const items = (await api("GET", `/migrations/${migrationId}`)).json.items;
		const web = items.find((i: { name: string }) => i.name === "web");
		const vec = items.find((i: { name: string }) => i.name === "vec");
		expect(
			(await api("POST", `/migration-items/${web.id}/skip`)).json.status,
		).toBe("skipped");
		expect(
			(await api("POST", `/migration-items/${web.id}/unskip`)).json.status,
		).toBe("planned");
		expect(
			(await api("POST", `/migration-items/${vec.id}/unskip`)).status,
		).toBe(409);
	});

	test("a cutover is queued only for an imported item", async () => {
		const items = (await api("GET", `/migrations/${migrationId}`)).json.items;
		const web = items.find((i: { name: string }) => i.name === "web");
		expect(
			(await api("POST", `/migration-items/${web.id}/cutover`)).status,
		).toBe(409);
		expect(
			(await api("POST", `/migrations/${migrationId}/import`)).status,
		).toBe(202);
		for (let i = 0; i < 100; i++) {
			const status = (await api("GET", `/migrations/${migrationId}`)).json
				.status;
			if (status === "imported") break;
			await Bun.sleep(100);
		}
		const imported = (
			await api("GET", `/migrations/${migrationId}`)
		).json.items.find((i: { name: string }) => i.name === "web");
		expect(imported.status).toBe("imported");
		expect(
			(await api("POST", `/migration-items/${web.id}/cutover`)).status,
		).toBe(202);
		const job = await runQueues(h.config.REDIS_URL).migration.getJob(
			`item-${web.id}`,
		);
		expect(job?.data).toEqual({ itemId: web.id, action: "cutover" });
	});
});
