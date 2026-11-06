import { describe, expect, test } from "bun:test";
import {
	decideScale,
	type ScaleInput,
	scaledReplicas,
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
