import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { node } from "@logistack/db";
import { serviceUsage, usageTrend, usageWindow } from "../src/usage-query.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const guest = {
	name: "Gus Guest",
	email: "gus@example.com",
	password: "gus password 123",
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

describe.skipIf(!hasDocker)("usage", () => {
	let h: Harness;
	let ownerCookie: string;
	let guestCookie: string;
	const ids = {} as Record<"shop" | "blog" | "prod" | "web" | "api", string>;
	const asOwner = () => ({ headers: { cookie: ownerCookie } });
	const asGuest = () => ({ headers: { cookie: guestCookie } });
	const minute = (t: number) => Math.floor(t / 60_000) * 60_000;

	/** One 1-minute rollup row per container per minute, ending at the last whole minute. */
	async function seed(
		serviceId: string,
		containers: string[],
		minutes: number,
		row: { cpu: number; mem: number; rx: number },
		endAgoMin = 0,
	) {
		const end = minute(Date.now()) - endAgoMin * 60_000;
		for (const c of containers)
			for (let i = 1; i <= minutes; i++)
				await h.deps.db
					.$client`insert into metric_container_1m values ('swarm-u', ${c},
					${new Date(end - i * 60_000).toISOString()}::timestamptz, ${serviceId}, ${c},
					${row.cpu}, ${row.cpu}, ${row.mem}, 0, ${row.rx}, 0, 0, 0, 6)`;
	}

	beforeAll(async () => {
		h = await startHarness({ area: "usage", label: "usage" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		ownerCookie = await h.signIn(owner.email, owner.password);
		await h.deps.db.insert(node).values({
			organizationId: orgId,
			swarmNodeId: "swarm-u",
			hostname: "u",
			address: "10.0.0.9",
			role: "manager",
			status: "ready",
			facts: { leader: true, cpus: 8, memoryBytes: 16_000 },
		});
		for (const name of ["shop", "blog"] as const)
			ids[name] = (
				await h.call("POST", "/api/projects", {
					...asOwner(),
					body: { name },
				})
			).json.id;
		ids.prod = (
			await h.call("GET", `/api/projects/${ids.shop}/environments`, asOwner())
		).json[0].id;
		for (const name of ["web", "api"] as const)
			ids[name] = (
				await h.call("POST", `/api/environments/${ids.prod}/services`, {
					...asOwner(),
					body: { name, spec: imageSpec },
				})
			).json.id;
		await seed(ids.web, ["w1", "w2"], 60, { cpu: 50, mem: 1_000, rx: 100 });
		await seed(ids.api, ["a1"], 30, { cpu: 200, mem: 4_000, rx: 0 });
		// Older than the 24h window: counts only in 7d.
		await h.deps.db
			.$client`select metric_ensure_partitions('metric_container_1m',
			(now() at time zone 'UTC')::date - 3, (now() at time zone 'UTC')::date - 2)`;
		await seed(ids.api, ["a1"], 10, { cpu: 100, mem: 0, rx: 0 }, 2 * 1_440);
		await h.deps.db
			.$client`insert into metric_host_1m values ('swarm-u', now() - interval '2 minutes',
			10, 10, 0.1, 500, 32_000, 100, 64_000, 0, 0, 6)`;

		await h.call("POST", "/api/auth/sign-up/email", { body: guest });
		const invite = await h.call("POST", "/api/invitations", {
			...asOwner(),
			body: { email: guest.email, role: "viewer" },
		});
		guestCookie = await h.signIn(guest.email, guest.password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			...asGuest(),
			body: { invitationId: invite.json.id },
		});
		// An unknown membership role grants nothing organization-wide.
		await h.deps.db
			.$client`update member set role = 'nobody' where user_id = (select id from "user" where email = ${guest.email})`;
		const me = await h.call("GET", "/api/me", asGuest());
		const grant = await h.call("POST", "/api/grants", {
			...asOwner(),
			body: {
				userId: me.json.userId,
				role: "viewer",
				scope: { kind: "project", id: ids.shop },
			},
		});
		expect(grant.status).toBe(201);
	}, 120_000);
	afterAll(() => h?.close());

	test("services average over the window and sum their replicas", async () => {
		const w = await usageWindow(h.deps.db.$client, "24h");
		const rows = await serviceUsage(h.deps.db.$client, [ids.shop, ids.blog], w);
		const web = rows.find((r) => r.serviceId === ids.web);
		const api = rows.find((r) => r.serviceId === ids.api);
		// 2 containers x 60 min x 0.5 core = 1 core-hour over 24 h.
		expect(web?.cpu).toBeCloseTo(1 / 24, 6);
		expect(web?.memUsed).toBeCloseTo((2 * 60 * 1_000) / 1_440, 6);
		expect(web?.rx).toBe(2 * 60 * 100 * 60);
		expect(api?.cpu).toBeCloseTo((30 * 2) / 1_440, 6);
		expect(rows.find((r) => r.projectId === ids.blog)).toMatchObject({
			serviceId: null,
			cpu: 0,
		});

		const week = await serviceUsage(
			h.deps.db.$client,
			[ids.shop],
			await usageWindow(h.deps.db.$client, "7d"),
		);
		expect(week.find((r) => r.serviceId === ids.api)?.cpu).toBeCloseTo(
			(30 * 2 + 10) / (7 * 1_440),
			6,
		);
	});

	test("the trend sums services per step in cores and bytes per second", async () => {
		const w = await usageWindow(h.deps.db.$client, "24h");
		expect(w.stepSec).toBe(300);
		const trend = await usageTrend(h.deps.db.$client, [ids.shop], w);
		// A 5-minute step 40 minutes ago is fully covered by web only: 2 x 0.5 core, 2 x 100 B/s.
		const t =
			Math.floor((minute(Date.now()) - 40 * 60_000) / 300_000) * 300_000;
		expect(trend.find((p) => p.t === t)).toMatchObject({
			cpu: 1,
			memUsed: 2_000,
			rx: 200,
		});
		expect(await usageTrend(h.deps.db.$client, [ids.blog], w)).toEqual([]);
	});

	test("the organization view totals projects against capacity", async () => {
		const res = await h.call("GET", "/api/usage?range=24h", asOwner());
		expect(res.status).toBe(200);
		expect(res.json.projects.map((p: { id: string }) => p.id).sort()).toEqual(
			[ids.shop, ids.blog].sort(),
		);
		expect(res.json.capacity).toEqual({
			cpus: 8,
			memory: 32_000,
			disk: 64_000,
		});
		expect(res.json.totals.cpu).toBeCloseTo(1 / 24 + 60 / 1_440, 6);
		// No agent answered, so volume size is unknown rather than zero.
		expect(res.json.totals.disk).toBeNull();
		expect((await h.call("GET", "/api/usage?range=1h", asOwner())).status).toBe(
			400,
		);
		expect((await h.call("GET", "/api/usage")).status).toBe(401);
	});

	test("a project's view nests environments and services", async () => {
		const res = await h.call(
			"GET",
			`/api/projects/${ids.shop}/usage?range=7d`,
			asOwner(),
		);
		expect(res.status).toBe(200);
		const [env] = res.json.environments;
		expect(env.id).toBe(ids.prod);
		expect(env.services.map((s: { name: string }) => s.name)).toEqual([
			"api",
			"web",
		]);
		expect(env.cpu).toBeCloseTo(res.json.totals.cpu, 9);
	});

	test("a member sees only the projects they can read", async () => {
		const res = await h.call("GET", "/api/usage", asGuest());
		expect(res.status).toBe(200);
		expect(res.json.projects.map((p: { id: string }) => p.id)).toEqual([
			ids.shop,
		]);
		expect(res.json.capacity).toBeNull();
		expect(
			(await h.call("GET", `/api/projects/${ids.shop}/usage`, asGuest()))
				.status,
		).toBe(200);
		expect(
			(await h.call("GET", `/api/projects/${ids.blog}/usage`, asGuest()))
				.status,
		).toBe(403);
	});

	test("hours the hourly rollup finished are read from it, not from minute rows", async () => {
		const sql = h.deps.db.$client;
		const cut = new Date(minute(Date.now()) - 30 * 60_000);
		await sql`insert into metric_rollup_state (name, through) values ('1h', ${cut.toISOString()}::timestamptz)`;
		await sql`insert into metric_container_1h values ('swarm-u', 'a1',
			date_bin('1 hour', now() - interval '5 hours', timestamptz 'epoch'), ${ids.api}, 'a1',
			400, 400, 0, 0, 0, 0, 0, 0, 360)`;
		const rows = await serviceUsage(
			sql,
			[ids.shop],
			await usageWindow(sql, "24h"),
		);
		// web: only its 30 minute rows after the cut (2 x 0.5 core); api: 30 minutes x 2 cores + 1 hour x 4 cores.
		expect(rows.find((r) => r.serviceId === ids.web)?.cpu).toBeCloseTo(
			30 / 1_440,
			6,
		);
		expect(rows.find((r) => r.serviceId === ids.api)?.cpu).toBeCloseTo(
			(60 + 240) / 1_440,
			6,
		);
	});
});
