import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { node } from "@logistack/db";
import { RedisClient } from "bun";
import {
	containerSeries,
	pickResolution,
	windowFor,
} from "../src/metrics-query.ts";
import { canStart } from "../src/routes/nodes.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe("pickResolution", () => {
	test.each([
		["1h", "raw", 10],
		["6h", "1m", 60],
		["24h", "1m", 300],
		["7d", "1m", 1_800],
		["30d", "1h", 7_200],
	] as const)("%s reads %s at %ds", (range, source, stepSec) => {
		expect(pickResolution(range)).toEqual({ source, stepSec });
	});

	test("a shorter retention moves the read to a coarser source", () => {
		const short = { rawHours: 24, minuteDays: 3, hourDays: 90 };
		expect(pickResolution("7d", short)).toEqual({
			source: "1h",
			stepSec: 3_600,
		});
		expect(pickResolution("24h", { ...short, rawHours: 48 })).toEqual({
			source: "1m",
			stepSec: 300,
		});
	});
});

test("wizard steps run in order and one at a time", () => {
	expect(canStart({ step: "test", state: "failed" }, "test")).toBeUndefined();
	expect(canStart({ step: "test", state: "failed" }, "preflight")).toMatch(
		/test step first/,
	);
	expect(
		canStart({ step: "test", state: "succeeded" }, "preflight"),
	).toBeUndefined();
	expect(canStart({ step: "test", state: "succeeded" }, "bootstrap")).toMatch(
		/preflight/,
	);
	expect(
		canStart({ step: "preflight", state: "failed" }, "preflight"),
	).toBeUndefined();
	expect(
		canStart({ step: "preflight", state: "succeeded" }, "bootstrap"),
	).toBeUndefined();
	expect(canStart({ step: "preflight", state: "running" }, "test")).toMatch(
		/still running/,
	);
	expect(canStart({ step: "bootstrap", state: "succeeded" }, "test")).toMatch(
		/already joined/,
	);
});

describe.skipIf(!hasDocker)("monitoring api", () => {
	let h: Harness;
	let cookie: string;
	let orgId: string;
	let redis: RedisClient;
	const nodes: Record<string, string> = {};
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "mon", label: "mon" });
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		redis = new RedisClient(h.config.REDIS_URL);
		for (const [swarm, leader] of [
			["swarm-a", true],
			["swarm-b", false],
		] as const) {
			const [row] = await h.deps.db
				.insert(node)
				.values({
					organizationId: orgId,
					swarmNodeId: swarm,
					hostname: swarm,
					address: "10.0.0.1",
					role: leader ? "manager" : "worker",
					status: "ready",
					facts: { leader, cpus: 4 },
				})
				.returning();
			nodes[swarm] = row?.id as string;
		}
		// 30 samples per node over the last 5 minutes: cpu 20 on a, 40 on b; rx grows 100 B/s on each.
		const now = Date.now();
		for (let i = 0; i < 30; i++)
			for (const [swarm, cpu] of [
				["swarm-a", 20],
				["swarm-b", 40],
			] as const)
				await h.deps.db.$client`insert into metric_host_raw values (${swarm},
					${new Date(now - (30 - i) * 10_000).toISOString()}::timestamptz, ${cpu}, 0.5,
					${swarm === "swarm-a" ? 1000 : 3000}, 4000, 10, 100, ${i * 1000}, 0)`;
		for (let i = 0; i < 6; i++)
			for (const c of ["c1", "c2"])
				await h.deps.db
					.$client`insert into metric_container_raw values ('swarm-b', ${c},
					${new Date(now - (6 - i) * 10_000).toISOString()}::timestamptz, 'svc_x', ${c}, 50, 100, 200, ${i * 10}, 0, 0, 0)`;
	}, 120_000);
	afterAll(async () => {
		redis?.close();
		await h?.close();
	});

	test("host dirs reach the node's agent with a normalized path", async () => {
		const seen: unknown[] = [];
		const real = h.deps.nodes.archive;
		h.deps.nodes.archive = ((nodeId: string, req: unknown) => {
			seen.push({ nodeId, req });
			const listing = {
				path: "/srv",
				entry: {
					name: "srv",
					type: "dir",
					size: 0,
					mode: 0o755,
					modifiedAt: 0,
				},
				entries: [],
				truncated: false,
			};
			return { result: Promise.resolve(listing) };
		}) as unknown as typeof real;
		try {
			const ok = await h.call(
				"GET",
				`/api/nodes/${nodes["swarm-b"]}/host-dirs?path=${encodeURIComponent("/srv//./")}`,
				as(),
			);
			expect(ok.status).toBe(200);
			expect(ok.json.path).toBe("/srv");
			expect(seen).toEqual([
				{ nodeId: "swarm-b", req: { op: "host-dirs", path: "/srv" } },
			]);
			const bad = await h.call(
				"GET",
				`/api/nodes/${nodes["swarm-b"]}/host-dirs?path=${encodeURIComponent("/srv/../etc")}`,
				as(),
			);
			expect(bad.status).toBe(400);
			expect(seen).toHaveLength(1);
		} finally {
			h.deps.nodes.archive = real;
		}
	});

	test("cluster series average CPU and sum bytes and rates", async () => {
		const res = await h.call("GET", "/api/metrics/hosts?range=1h", as());
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ range: "1h", source: "raw", stepSec: 10 });
		const [series] = res.json.series;
		expect(series.nodeId).toBeNull();
		const last = series.points.at(-1);
		expect(last).toMatchObject({
			cpu: 30,
			memUsed: 4000,
			memTotal: 8000,
			diskTotal: 200,
			rx: 200,
		});
		expect(series.points.length).toBeGreaterThanOrEqual(29);
	});

	test("per-node series and a single node", async () => {
		const per = await h.call(
			"GET",
			"/api/metrics/hosts?range=1h&perNode=true",
			as(),
		);
		expect(
			per.json.series.map((s: { nodeId: string }) => s.nodeId).sort(),
		).toEqual(Object.values(nodes).sort());
		const one = await h.call(
			"GET",
			`/api/metrics/hosts?range=6h&nodeId=${nodes["swarm-b"]}`,
			as(),
		);
		expect(one.json).toMatchObject({
			source: "1m",
			stepSec: 60,
			series: [{ nodeId: nodes["swarm-b"] }],
		});
		expect(
			(
				await h.call(
					"GET",
					"/api/metrics/hosts?range=1h&nodeId=nod_other",
					as(),
				)
			).status,
		).toBe(404);
		expect(
			(await h.call("GET", "/api/metrics/hosts?range=2h", as())).status,
		).toBe(400);
		expect((await h.call("GET", "/api/metrics/hosts?range=1h")).status).toBe(
			401,
		);
	});

	test("container series sum replicas per bucket", async () => {
		const w = await windowFor(h.deps.db.$client, "1h");
		const points = await containerSeries(
			h.deps.db.$client,
			{ serviceId: "svc_x" },
			w,
		);
		expect(points.at(-1)).toMatchObject({
			cpu: 100,
			memUsed: 200,
			memLimit: 400,
			rx: 2,
			containers: 2,
		});
		const one = await h.call(
			"GET",
			"/api/metrics/containers/c1?range=1h",
			as(),
		);
		expect(one.status).toBe(200);
		expect(one.json.points.at(-1)).toMatchObject({ cpu: 50, containers: 1 });
		expect(
			(await h.call("GET", "/api/metrics/containers/unknown?range=1h", as()))
				.status,
		).toBe(404);
	});

	test("nodes overlay agent presence and the latest sample", async () => {
		const b = nodes["swarm-b"] as string;
		await h.deps.db.update(node).set({ status: "pending" });
		await redis.set(
			"ls:nodes:swarm-b",
			JSON.stringify({
				version: "0.3.0",
				lastSeenAt: new Date().toISOString(),
			}),
		);
		await redis.set(
			"ls:metrics:last:swarm-b",
			JSON.stringify({
				nodeId: "swarm-b",
				at: Date.now(),
				cpu: 40,
				load1: 0.5,
				memUsed: 3000,
				memTotal: 4000,
				diskUsed: 10,
				diskTotal: 100,
				containers: 2,
			}),
		);
		const list = await h.call("GET", "/api/nodes", as());
		expect(list.status).toBe(200);
		const byId = Object.fromEntries(
			list.json.map((n: { id: string }) => [n.id, n]),
		);
		expect(byId[b]).toMatchObject({
			status: "ready",
			agentVersion: "0.3.0",
			live: { nodeId: b, cpu: 40 },
		});
		expect(byId[nodes["swarm-a"] as string]).toMatchObject({
			status: "pending",
			live: null,
			leader: true,
		});
	});

	test("labels and drain are desired state; the leader cannot be drained or removed", async () => {
		const b = nodes["swarm-b"] as string;
		const a = nodes["swarm-a"] as string;
		const patched = await h.call("PATCH", `/api/nodes/${b}`, {
			...as(),
			body: { labels: { ingress: "true" }, desired: "drain" },
		});
		expect(patched.status).toBe(200);
		expect(patched.json).toMatchObject({
			labels: { ingress: "true" },
			desired: "drain",
			status: "draining",
		});
		expect(
			(
				await h.call("PATCH", `/api/nodes/${b}`, {
					...as(),
					body: { labels: { "-bad": "x" } },
				})
			).status,
		).toBe(400);
		expect(
			(
				await h.call("PATCH", `/api/nodes/${a}`, {
					...as(),
					body: { desired: "drain" },
				})
			).status,
		).toBe(400);
		expect((await h.call("DELETE", `/api/nodes/${a}`, as())).status).toBe(400);
		const removing = await h.call("DELETE", `/api/nodes/${b}`, as());
		expect(removing.status).toBe(202);
		expect(removing.json.desired).toBe("remove");
		expect(
			(
				await h.call("PATCH", `/api/nodes/${b}`, {
					...as(),
					body: { desired: "active" },
				})
			).status,
		).toBe(409);
	});

	test("Add-server runs queue steps in order and validate SSH input", async () => {
		const key = await h.call("POST", "/api/ssh-keys", {
			...as(),
			body: { name: "bootstrap" },
		});
		expect(key.status).toBe(201);
		const input = {
			name: "edge-1",
			host: "203.0.113.20",
			sshUser: "root",
			sshKeyId: key.json.id,
		};
		const bad = await h.call("POST", "/api/nodes/joins", {
			...as(),
			body: { ...input, host: "-oProxyCommand=x" },
		});
		expect(bad.status).toBe(400);
		const created = await h.call("POST", "/api/nodes/joins", {
			...as(),
			body: input,
		});
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({
			step: "test",
			state: "queued",
			port: 22,
			role: "worker",
		});
		expect(created.json.hostKey).toBeUndefined();
		const id = created.json.id;
		const early = await h.call("POST", `/api/nodes/joins/${id}/steps`, {
			...as(),
			body: { step: "preflight" },
		});
		expect(early.status).toBe(409);
		await h.deps.db
			.$client`update node_join set state = 'succeeded' where id = ${id}`;
		const next = await h.call("POST", `/api/nodes/joins/${id}/steps`, {
			...as(),
			body: { step: "preflight" },
		});
		expect(next.status).toBe(202);
		expect(next.json).toMatchObject({ step: "preflight", state: "queued" });
		const edited = await h.call("PUT", `/api/nodes/joins/${id}`, {
			...as(),
			body: { ...input, port: 2222 },
		});
		expect(edited.status).toBe(409);
	});

	test("settings round-trip retention and thresholds", async () => {
		const body = {
			retention: { rawHours: 48, minuteDays: 14, hourDays: 180 },
			thresholds: [
				{
					metric: "cpu",
					nodeId: null,
					percent: 85,
					forSec: 300,
					enabled: true,
				},
			],
		};
		const saved = await h.call("PUT", "/api/monitoring/settings", {
			...as(),
			body,
		});
		expect(saved.status).toBe(200);
		const id = saved.json.thresholds[0].id;
		const again = await h.call("PUT", "/api/monitoring/settings", {
			...as(),
			body: {
				...body,
				thresholds: [{ ...body.thresholds[0], id, percent: 90 }],
			},
		});
		expect(again.json.thresholds).toEqual([
			{ ...body.thresholds[0], id, percent: 90 },
		]);
		expect(
			(await h.call("GET", "/api/monitoring/settings", as())).json.retention,
		).toEqual(body.retention);
		const bad = await h.call("PUT", "/api/monitoring/settings", {
			...as(),
			body: {
				...body,
				retention: { rawHours: 48, minuteDays: 1, hourDays: 90 },
			},
		});
		expect(bad.status).toBe(400);

		// Disabled, so the scheduler sync only removes: an enabled one would let a dev worker prune this machine.
		const cleanup = {
			enabled: false,
			cron: "30 4 * * 0",
			timezone: "Europe/Rome",
			targets: ["images"],
			untilHours: 48,
		};
		const withCleanup = await h.call("PUT", "/api/monitoring/settings", {
			...as(),
			body: { ...body, cleanup },
		});
		expect(withCleanup.status).toBe(200);
		expect(withCleanup.json.cleanup).toEqual(cleanup);
		const kept = await h.call("PUT", "/api/monitoring/settings", {
			...as(),
			body,
		});
		expect(kept.json.cleanup).toEqual(cleanup);
		for (const wrong of [{ cron: "every day" }, { timezone: "Mars/Base" }])
			expect(
				(
					await h.call("PUT", "/api/monitoring/settings", {
						...as(),
						body: { ...body, cleanup: { ...cleanup, ...wrong } },
					})
				).status,
			).toBe(400);
	});

	test("service thresholds save from the service and from the settings", async () => {
		const projectId = (
			await h.call("POST", "/api/projects", { ...as(), body: { name: "Th" } })
		).json.id;
		const envs = await h.call(
			"GET",
			`/api/projects/${projectId}/environments`,
			as(),
		);
		const svc = (
			await h.call("POST", `/api/environments/${envs.json[0].id}/services`, {
				...as(),
				body: {
					name: "Api",
					spec: {
						kind: "application",
						source: { type: "image", image: "nginx:1.27" },
						build: { type: "image" },
						ports: [],
						replicas: 1,
						resources: { memoryMb: 256 },
						placement: [],
					},
				},
			})
		).json.id as string;
		const path = `/api/services/${svc}/thresholds`;
		const cpu = { metric: "cpu", above: 90, forSec: 300, enabled: true };
		const saved = await h.call("PUT", path, {
			...as(),
			body: { thresholds: [cpu] },
		});
		expect(saved.status).toBe(200);
		expect(saved.json).toEqual([
			{
				...cpu,
				id: expect.any(String),
				serviceId: svc,
				firing: null,
				serviceName: "Api",
				projectId,
			},
		]);
		expect(
			(
				await h.call("PUT", path, {
					...as(),
					body: {
						thresholds: [{ ...cpu, metric: "memoryPercent", above: 120 }],
					},
				})
			).status,
		).toBe(400);

		const settings = (await h.call("GET", "/api/monitoring/settings", as()))
			.json;
		expect(settings.serviceThresholds).toEqual(saved.json);
		// Settings saved without the field keep the service thresholds.
		const { lastCleanup: _, serviceThresholds, ...rest } = settings;
		expect(
			(await h.call("PUT", "/api/monitoring/settings", { ...as(), body: rest }))
				.json.serviceThresholds,
		).toEqual(serviceThresholds);
		const edited = await h.call("PUT", "/api/monitoring/settings", {
			...as(),
			body: {
				...rest,
				serviceThresholds: [
					{ ...serviceThresholds[0], above: 50, firing: undefined },
				],
			},
		});
		expect(edited.json.serviceThresholds).toMatchObject([
			{ id: serviceThresholds[0].id, above: 50 },
		]);
		expect(
			(
				await h.call("PUT", "/api/monitoring/settings", {
					...as(),
					body: {
						...rest,
						serviceThresholds: [{ ...cpu, serviceId: "svc_nope" }],
					},
				})
			).status,
		).toBe(404);
		expect(
			(await h.call("PUT", path, { ...as(), body: { thresholds: [] } })).json,
		).toEqual([]);
	});
});
