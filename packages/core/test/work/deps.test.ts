import { describe, expect, test } from "bun:test";
import {
	blockedState,
	type DepEdge,
	shiftDependants,
	topoOrder,
	violatedEdges,
	wouldCycle,
} from "../../src/work/deps.ts";

// a → b → c, a → d → c (diamond): "b blocked by a" etc.
const diamond: DepEdge[] = [
	{ taskId: "b", blockedById: "a" },
	{ taskId: "d", blockedById: "a" },
	{ taskId: "c", blockedById: "b" },
	{ taskId: "c", blockedById: "d" },
];

describe("wouldCycle", () => {
	test("self and direct loops", () => {
		expect(wouldCycle([], "a", "a")).toEqual(["a", "a"]);
		expect(wouldCycle([{ taskId: "b", blockedById: "a" }], "a", "b")).toEqual([
			"a",
			"b",
			"a",
		]);
	});
	test("transitive loop names the path", () => {
		expect(wouldCycle(diamond, "a", "c")).toEqual(["a", "c", "b", "a"]);
	});
	test("diamond edges that don't loop", () => {
		expect(wouldCycle(diamond, "c", "a")).toBeNull();
		expect(wouldCycle(diamond, "d", "b")).toBeNull();
	});
});

describe("topoOrder", () => {
	test("blockers first", () => {
		const order = topoOrder(diamond);
		const at = (id: string) => order.indexOf(id);
		expect(at("a")).toBeLessThan(at("b"));
		expect(at("b")).toBeLessThan(at("c"));
		expect(at("d")).toBeLessThan(at("c"));
	});
	test("throws on cycles", () => {
		expect(() =>
			topoOrder([
				{ taskId: "a", blockedById: "b" },
				{ taskId: "b", blockedById: "a" },
			]),
		).toThrow();
	});
});

describe("shiftDependants", () => {
	// 2026-11-02 is a Monday.
	const tasks = [
		{ id: "a", startDate: "2026-11-02", dueDate: "2026-11-04" },
		{ id: "b", startDate: "2026-11-05", dueDate: "2026-11-06" },
		{ id: "d", startDate: "2026-11-05", dueDate: "2026-11-05" },
		{ id: "c", startDate: "2026-11-09", dueDate: "2026-11-10" },
	];
	test("pushes dependants, skipping weekends, keeping duration", () => {
		const out = shiftDependants(tasks, diamond, "a", 2);
		expect(out).toEqual([
			{ id: "a", startDate: "2026-11-04", dueDate: "2026-11-06" },
			{ id: "b", startDate: "2026-11-09", dueDate: "2026-11-10" },
			{ id: "d", startDate: "2026-11-09", dueDate: "2026-11-09" },
			{ id: "c", startDate: "2026-11-11", dueDate: "2026-11-12" },
		]);
	});
	test("lag days", () => {
		const out = shiftDependants(
			tasks.slice(0, 2),
			[{ taskId: "b", blockedById: "a", lagDays: 2 }],
			"a",
			0,
		);
		expect(out).toEqual([
			{ id: "b", startDate: "2026-11-09", dueDate: "2026-11-10" },
		]);
	});
	test("moving earlier never pulls dependants earlier", () => {
		expect(shiftDependants(tasks, diamond, "a", -2)).toEqual([
			{ id: "a", startDate: "2026-10-29", dueDate: "2026-11-02" },
		]);
	});
	test("dependants already late enough stay", () => {
		const late = [
			...tasks.slice(0, 3),
			{ id: "c", startDate: "2026-11-20", dueDate: "2026-11-24" },
		];
		expect(shiftDependants(late, diamond, "a", 1).map((t) => t.id)).toEqual([
			"a",
			"b",
			"d",
		]);
	});
});

test("blockedState ignores done and cancelled blockers", () => {
	expect(blockedState("c", diamond, { b: "done", d: "active" })).toEqual({
		blocked: true,
		blockers: ["d"],
	});
	expect(blockedState("c", diamond, { b: "done", d: "cancelled" })).toEqual({
		blocked: false,
		blockers: [],
	});
});

test("violatedEdges", () => {
	const ts = [
		{ id: "a", startDate: "2026-11-02", dueDate: "2026-11-06" },
		{ id: "b", startDate: "2026-11-05", dueDate: "2026-11-09" },
	];
	expect(violatedEdges(ts, [{ taskId: "b", blockedById: "a" }])).toHaveLength(
		1,
	);
});
