import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { adoptedVolume, mount } from "@logistack/db";
import { eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const app = {
	kind: "application",
	source: { type: "image", image: "nginx:1.27" },
	build: { type: "image" },
	ports: [],
	replicas: 1,
	resources: {},
	placement: [],
};
const postgres = {
	kind: "database",
	engine: "postgres",
	version: "16",
	credentialsRef: "ref",
	resources: {},
};

describe.skipIf(!hasDocker)("adopted volumes on service create", () => {
	let h: Harness;
	let envId: string;
	let ownerCookie: string;
	let devKey: string;
	const asOwner = () => ({ headers: { cookie: ownerCookie } });
	const create = (
		body: Record<string, unknown>,
		as: { headers: Record<string, string> } = asOwner(),
	) => h.call("POST", `/api/environments/${envId}/services`, { ...as, body });

	beforeAll(async () => {
		h = await startHarness({ area: "adopt", label: "adopt" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		ownerCookie = await h.signIn(owner.email, owner.password);
		const project = await h.call("POST", "/api/projects", {
			...asOwner(),
			body: { name: "Imported" },
		});
		envId = (
			await h.call(
				"GET",
				`/api/projects/${project.json.id}/environments`,
				asOwner(),
			)
		).json[0].id;
		devKey = (
			await h.call("POST", "/api/api-keys", {
				...asOwner(),
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

	test("a volume mount and a database data dir record their adopted volume", async () => {
		const web = await create({
			name: "web",
			spec: app,
			mounts: [{ kind: "volume", target: "/data", name: "data" }],
			adoptedVolumes: [
				{ target: "/data", volume: "shop-a1b2c3_data", source: "dokploy" },
			],
		});
		expect(web.status).toBe(201);
		const [m] = await h.deps.db
			.select()
			.from(mount)
			.where(eq(mount.serviceId, web.json.id));
		const db = await create({
			name: "db",
			spec: postgres,
			adoptedVolumes: [
				{
					target: "/var/lib/postgresql/data",
					volume: "pg-x1y2z3-data",
					source: "dokploy",
				},
			],
		});
		expect(db.status).toBe(201);
		const rows = await h.deps.db.select().from(adoptedVolume);
		expect(rows.map((r) => [r.volumeName, r.ownerId]).sort()).toEqual(
			[
				["pg-x1y2z3-data", db.json.id],
				["shop-a1b2c3_data", m?.id],
			].sort(),
		);
	});

	test("a volume adopted twice is a conflict", async () => {
		const res = await create({
			name: "web2",
			spec: app,
			mounts: [{ kind: "volume", target: "/data", name: "data" }],
			adoptedVolumes: [
				{ target: "/data", volume: "shop-a1b2c3_data", source: "dokploy" },
			],
		});
		expect(res.status).toBe(409);
	});

	test("a target that is neither a volume mount nor the data dir is refused", async () => {
		const res = await create({
			name: "web3",
			spec: app,
			adoptedVolumes: [
				{ target: "/data", volume: "free-volume", source: "dokploy" },
			],
		});
		expect(res.status).toBe(400);
	});

	test("LogiStack's own volumes cannot be adopted", async () => {
		for (const volume of ["logistack_pgdata", "ls-vol-abc", "x_ls-vol-abc"]) {
			const res = await create({
				name: "db-own",
				spec: postgres,
				adoptedVolumes: [
					{ target: "/var/lib/postgresql/data", volume, source: "dokploy" },
				],
			});
			expect(res.status).toBe(400);
		}
	});

	test("adopting needs admin", async () => {
		const res = await create(
			{
				name: "db-dev",
				spec: postgres,
				adoptedVolumes: [
					{
						target: "/var/lib/postgresql/data",
						volume: "dev-volume",
						source: "dokploy",
					},
				],
			},
			{ headers: { authorization: `Bearer ${devKey}` } },
		);
		expect(res.status).toBe(403);
	});

	test("a database's engine or Postgres major cannot change in place", async () => {
		const res = await create({ name: "versions", spec: postgres });
		expect(res.status).toBe(201);
		const patch = (spec: Record<string, unknown>) =>
			h.call("PATCH", `/api/services/${res.json.id}`, {
				...asOwner(),
				body: { spec: { ...postgres, ...spec } },
			});
		expect((await patch({ version: "16.4" })).status).toBe(200);
		const major = await patch({ version: "18" });
		expect(major.status).toBe(400);
		expect(JSON.stringify(major.json)).toContain("major version");
		expect((await patch({ engine: "mysql", version: "8" })).status).toBe(400);
	});
});
