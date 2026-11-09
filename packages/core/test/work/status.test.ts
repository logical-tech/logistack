import { describe, expect, test } from "bun:test";
import {
	applyStatusChange,
	canDeleteStatus,
	requiredFieldsMissing,
} from "../../src/work/status.ts";

const now = new Date("2026-11-09T10:00:00Z");
const earlier = new Date("2026-11-01T10:00:00Z");

describe("applyStatusChange", () => {
	test("active → done sets completedAt", () => {
		expect(
			applyStatusChange(
				{ completedAt: null },
				{ category: "active" },
				{ category: "done" },
				now,
			),
		).toEqual({ completedAt: now });
	});
	test("done → active clears it", () => {
		expect(
			applyStatusChange(
				{ completedAt: earlier },
				{ category: "done" },
				{ category: "active" },
				now,
			),
		).toEqual({ completedAt: null });
	});
	test("done → done keeps the original", () => {
		expect(
			applyStatusChange(
				{ completedAt: earlier },
				{ category: "done" },
				{ category: "done" },
				now,
			),
		).toEqual({ completedAt: earlier });
	});
	test("cancelled isn't completion", () => {
		expect(
			applyStatusChange(
				{ completedAt: null },
				{ category: "active" },
				{ category: "cancelled" },
				now,
			),
		).toEqual({ completedAt: null });
	});
});

describe("canDeleteStatus", () => {
	const statuses = [
		{ id: "bk", category: "backlog" as const },
		{ id: "a1", category: "active" as const },
		{ id: "d1", category: "done" as const },
		{ id: "d2", category: "done" as const },
	];
	test("last backlog and last done are protected", () => {
		expect(canDeleteStatus(statuses, "bk").ok).toBe(false);
		expect(canDeleteStatus(statuses, "d1").ok).toBe(true);
		expect(
			canDeleteStatus(
				statuses.filter((s) => s.id !== "d2"),
				"d1",
			).ok,
		).toBe(false);
		expect(canDeleteStatus(statuses, "a1").ok).toBe(true);
		expect(canDeleteStatus(statuses, "zz").ok).toBe(false);
	});
});

describe("requiredFieldsMissing", () => {
	const fields = [
		{
			id: "f1",
			name: "Client",
			listId: null,
			required: true,
			config: { kind: "text" as const },
		},
		{
			id: "f2",
			name: "Other list",
			listId: "wls_2",
			required: true,
			config: { kind: "text" as const },
		},
		{
			id: "f3",
			name: "Optional",
			listId: null,
			required: false,
			config: { kind: "text" as const },
		},
	];
	const task = { listId: "wls_1", fields: {} };
	test("checked on create and on moving to done only", () => {
		expect(requiredFieldsMissing(task, fields, null).map((f) => f.id)).toEqual([
			"f1",
		]);
		expect(
			requiredFieldsMissing(task, fields, { category: "done" }).map(
				(f) => f.id,
			),
		).toEqual(["f1"]);
		expect(requiredFieldsMissing(task, fields, { category: "active" })).toEqual(
			[],
		);
		expect(
			requiredFieldsMissing({ ...task, fields: { f1: "Acme" } }, fields, {
				category: "done",
			}),
		).toEqual([]);
	});
});
