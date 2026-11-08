import { describe, expect, test } from "bun:test";
import type { ApplicationSpec } from "@logistack/contracts";
import {
	autoscaleChecks,
	decideScale,
	type LoadPoint,
	previewScale,
	type ScaleInput,
	scaledReplicas,
	targetCpuFor,
} from "../src/autoscale.ts";

const now = new Date("2026-11-06T12:00:00Z");
const ago = (sec: number) => new Date(now.getTime() - sec * 1000);

const base = (over: Partial<ScaleInput> = {}): ScaleInput => ({
	current: 2,
	min: 1,
	max: 10,
	targetCpu: 60,
	targetMemory: null,
	recent: { cpu: 60, memory: 40 },
	sustained: { cpu: 60, memory: 40 },
	lastScaledAt: null,
	now,
	pending: false,
	...over,
});

const at = (cpu: number, memory: number | null = null) => ({ cpu, memory });

describe("decideScale", () => {
	test.each<[string, Partial<ScaleInput>, number | undefined]>([
		["holds on target", {}, undefined],
		[
			"holds within the tolerance",
			{ recent: at(65), sustained: at(55) },
			undefined,
		],
		["scales up proportionally", { recent: at(90) }, 3],
		["at most doubles", { current: 2, recent: at(400) }, 4],
		["at most +4 per step", { current: 8, max: 20, recent: at(300) }, 12],
		["clamps to max", { current: 3, max: 4, recent: at(150) }, 4],
		["already at max", { current: 4, max: 4, recent: at(150) }, undefined],
		[
			"up waits for its cooldown",
			{ recent: at(90), lastScaledAt: ago(30) },
			undefined,
		],
		["up after its cooldown", { recent: at(90), lastScaledAt: ago(61) }, 3],
		[
			"scales down one at a time",
			{ current: 5, recent: at(10), sustained: at(10) },
			4,
		],
		[
			"down waits for its cooldown",
			{ current: 5, recent: at(10), sustained: at(10), lastScaledAt: ago(120) },
			undefined,
		],
		[
			"down not below min",
			{ current: 2, min: 2, recent: at(5), sustained: at(5) },
			undefined,
		],
		[
			"recent dip alone does not scale down",
			{ current: 3, recent: at(10), sustained: at(60) },
			undefined,
		],
		[
			"no samples holds",
			{
				recent: { cpu: null, memory: null },
				sustained: { cpu: null, memory: null },
			},
			undefined,
		],
		["pending tasks hold", { recent: at(200), pending: true }, undefined],
		[
			"below min jumps to min, ignoring cooldown",
			{ current: 1, min: 3, lastScaledAt: ago(5), pending: true },
			3,
		],
		["above max drops to max", { current: 8, max: 5 }, 5],
		["memory can scale up", { targetMemory: 50, recent: at(30, 100) }, 4],
		[
			"memory blocks scale-down",
			{
				current: 4,
				targetMemory: 50,
				recent: at(10, 52),
				sustained: at(10, 52),
			},
			undefined,
		],
		[
			"memory and cpu agree to scale down",
			{
				current: 4,
				targetMemory: 50,
				recent: at(10, 10),
				sustained: at(10, 10),
			},
			3,
		],
		[
			"memory target without samples blocks scale-down",
			{ current: 4, targetMemory: 50, recent: at(10), sustained: at(10) },
			undefined,
		],
	])("%s", (_name, over, expected) => {
		expect(decideScale(base(over))?.replicas).toBe(expected);
	});

	test("explains the decision", () => {
		expect(decideScale(base({ recent: at(78) }))?.reason).toBe(
			"CPU 78% above target 60%",
		);
		expect(
			decideScale(base({ current: 3, recent: at(20), sustained: at(20) }))
				?.reason,
		).toBe("CPU 20% below target 60%");
		expect(
			decideScale(base({ targetMemory: 50, recent: at(30, 100) }))?.reason,
		).toBe("Memory 100% above target 50%");
	});
});

describe("scaledReplicas", () => {
	test("only an enabled autoscaler with a decision applies", () => {
		expect(scaledReplicas(undefined)).toBeUndefined();
		expect(scaledReplicas({ enabled: false, replicas: 3 })).toBeUndefined();
		expect(scaledReplicas({ enabled: true, replicas: null })).toBeUndefined();
		expect(scaledReplicas({ enabled: true, replicas: 3 })).toBe(3);
	});
});

const spec = (over: Partial<ApplicationSpec> = {}): ApplicationSpec => ({
	kind: "application",
	source: { type: "image", image: "nginx:1" },
	build: { type: "image" },
	ports: [],
	replicas: 1,
	resources: { cpu: 0.5 },
	placement: [],
	...over,
});

describe("autoscaleChecks", () => {
	const failed = (...a: Parameters<typeof autoscaleChecks>) =>
		autoscaleChecks(...a)
			.filter((c) => !c.ok)
			.map((c) => `${c.level}:${c.id}`);

	test("a stateless service with a limit, a healthcheck and two nodes passes", () => {
		expect(
			failed({
				spec: spec({
					healthcheck: { type: "http", port: 80, path: "/health" },
					ports: [
						{ target: 80, published: 8080, protocol: "tcp", mode: "ingress" },
					],
				}),
				volumes: 0,
				nodes: 2,
			}),
		).toEqual([]);
	});

	test("each blocker and warning", () => {
		expect(
			failed({
				spec: spec({
					resources: {},
					ports: [{ target: 80, published: 8080, protocol: "tcp" }],
				}),
				volumes: 1,
				nodes: 1,
			}),
		).toEqual([
			"blocker:cpu_limit",
			"blocker:volumes",
			"blocker:host_ports",
			"warning:healthcheck",
			"warning:nodes",
		]);
		expect(
			failed({
				spec: spec({
					mounts: [{ kind: "bind", hostPath: "/srv/x", target: "/x" }],
				}),
				volumes: 0,
				nodes: 2,
			}),
		).toEqual(["blocker:volumes", "warning:healthcheck"]);
		// An unpublished port binds nothing on the host.
		expect(
			failed({
				spec: spec({ ports: [{ target: 80, protocol: "tcp" }] }),
				volumes: 0,
				nodes: 2,
			}),
		).toEqual(["warning:healthcheck"]);
		// Behind a domain the compiler already checks the port for listening.
		expect(
			failed({
				spec: spec({ ports: [{ target: 80, protocol: "tcp" }] }),
				volumes: 0,
				nodes: 2,
				fallbackPort: 80,
			}),
		).toEqual([]);
	});
});

test("targetCpuFor: presets override, custom keeps its own", () => {
	expect(targetCpuFor("responsive", 90)).toBe(45);
	expect(targetCpuFor("balanced", undefined)).toBe(60);
	expect(targetCpuFor("economical", undefined)).toBe(75);
	expect(targetCpuFor("custom", 70)).toBe(70);
});

describe("previewScale", () => {
	const minute = (k: number, cpu: number): LoadPoint => ({
		at: new Date(now.getTime() + k * 60_000),
		cpu,
		memory: null,
	});
	const settings = { min: 1, max: 4, targetCpu: 60, targetMemory: null };

	test("a spike scales up within minutes and back down slowly; total CPU spreads over copies", () => {
		// One copy at 30% of 0.5 core = 15; then 6x the load for 10 minutes; then quiet again.
		const points = [
			...Array.from({ length: 10 }, (_, k) => minute(k, 15)),
			...Array.from({ length: 10 }, (_, k) => minute(10 + k, 90)),
			...Array.from({ length: 30 }, (_, k) => minute(20 + k, 15)),
		];
		const out = previewScale(points, settings, 0.5, 1);
		const replicas = out.map((p) => p.replicas);
		expect(replicas.slice(0, 10)).toEqual(Array(10).fill(1));
		// 90 on one 0.5-core copy is 180%: doubling caps the first step at two, three a minute later.
		expect(replicas.slice(10, 13)).toEqual([2, 3, 3]);
		expect(out[12]?.cpu).toBe(60);
		expect(Math.max(...replicas)).toBe(3);
		expect(replicas.at(-1)).toBe(1);
		// Down one at a time, never faster than the cooldown.
		const downs = replicas.flatMap((r, i) =>
			i > 0 && r < (replicas[i - 1] as number) ? [i] : [],
		);
		expect(downs.length).toBe(2);
		expect((downs[1] as number) - (downs[0] as number)).toBeGreaterThanOrEqual(
			3,
		);
	});

	test("starts inside the range and stays there", () => {
		const out = previewScale([minute(0, 0)], { ...settings, min: 2 }, 0.5, 1);
		expect(out[0]?.replicas).toBe(2);
	});
});
