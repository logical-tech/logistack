import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type FilterCondition,
	type FilterNode,
	type FilterOp,
	relativeDates,
	type WorkFieldConfig,
	type WorkTaskListItem,
} from "@logistack/contracts";
import {
	addDays,
	fieldFilterOps,
	type MatchableTask,
	matchesTask,
	validateFilter,
} from "@logistack/core";
import { workTask } from "@logistack/db";
import { eq } from "drizzle-orm";
import { hasDocker } from "./harness.ts";
import { startWorld, type World } from "./work-fixtures.ts";

/** Seeded so a failure reproduces; bump the seed to explore. */
function rng(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const DATE_OPS: FilterOp[] = [
	"before",
	"after",
	"on",
	"between",
	"relative",
	"empty",
	"not_empty",
];
const ID_OPS: FilterOp[] = ["is", "is_not", "any_of", "none_of"];
const BUILTIN: Record<string, FilterOp[]> = {
	status: ID_OPS,
	statusCategory: ID_OPS,
	priority: ID_OPS,
	list: ID_OPS,
	createdBy: ID_OPS,
	assignee: [...ID_OPS, "all_of", "empty", "not_empty"],
	tag: ["any_of", "all_of", "none_of", "empty", "not_empty"],
	startDate: DATE_OPS,
	dueDate: DATE_OPS,
	createdAt: DATE_OPS,
	updatedAt: DATE_OPS,
	completedAt: DATE_OPS,
	text: ["contains"],
	parent: ["is", "empty", "not_empty"],
	isMilestone: ["is"],
	blocked: ["is"],
};
const WORDS = [
	"alpha",
	"Beta",
	"gamma",
	"delta",
	"launch",
	"QA",
	"copy",
	"Hero",
];

describe.skipIf(!hasDocker)("work filter SQL", () => {
	let w: World;
	beforeAll(async () => {
		w = await startWorld("work-filter");
	}, 120_000);
	afterAll(() => w?.close());

	test("compiled SQL agrees with core matchesTask on random filters", async () => {
		const r = rng(20261109);
		const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;
		const some = <T>(xs: readonly T[]) => xs.filter(() => r() < 0.4);
		const { P, ok, work, users } = w;
		const project = P;
		const listA = await w.listOf(project);
		const listB = (
			await ok("POST", work(`/projects/${project}/lists`), { name: "Second" })
		).id;
		const statuses = await w.statuses(project);
		const tags = [
			(await ok("POST", work(`/projects/${project}/tags`), { name: "red" })).id,
			(await ok("POST", work(`/projects/${project}/tags`), { name: "blue" }))
				.id,
		];
		const options = [
			{ id: "o1", label: "One", color: "blue" },
			{ id: "o2", label: "Two", color: "red" },
			{ id: "o3", label: "Three", color: "gray" },
		];
		const configs: WorkFieldConfig[] = [
			{ kind: "text" },
			{ kind: "number", decimals: 2 },
			{ kind: "currency", currency: "EUR", decimals: 2 },
			{ kind: "select", options } as WorkFieldConfig,
			{ kind: "multi_select", options } as WorkFieldConfig,
			{ kind: "date", withTime: false },
			{ kind: "checkbox" },
			{ kind: "user", multiple: true },
			{ kind: "rating", max: 5, icon: "star" },
		];
		const fields: { id: string; config: WorkFieldConfig }[] = [];
		for (const config of configs)
			fields.push({
				id: (
					await ok("POST", work(`/projects/${project}/fields`), {
						name: config.kind,
						config,
					})
				).id,
				config,
			});
		const people = [users.owner, users.developer, users.custom];
		const day = (n: number) => addDays("2026-11-09", n);
		const value = (c: WorkFieldConfig): unknown => {
			switch (c.kind) {
				case "text":
					return `${pick(WORDS)} ${pick(WORDS)}`;
				case "number":
					return Math.round(r() * 2000 - 1000) / 100;
				case "currency":
					return `${Math.floor(r() * 500)}.${Math.floor(r() * 90 + 10)}`;
				case "select":
					return pick(options).id;
				case "multi_select":
					return some(options).map((o) => o.id);
				case "date":
					return day(Math.floor(r() * 40 - 20));
				case "checkbox":
					return r() < 0.5;
				case "user":
					return some(people);
				default:
					return Math.floor(r() * 6);
			}
		};
		const created: { id: string }[] = [];
		for (let i = 0; i < 40; i++) {
			const start = r() < 0.6 ? Math.floor(r() * 30 - 15) : null;
			const due = r() < 0.7 ? (start ?? -10) + Math.floor(r() * 10) : null;
			const t = await ok("POST", work("/tasks"), {
				listId: r() < 0.7 ? listA : listB,
				title: `${pick(WORDS)} ${pick(WORDS)} ${i}`,
				description:
					r() < 0.5
						? {
								type: "doc",
								content: [
									{
										type: "paragraph",
										content: [{ type: "text", text: `${pick(WORDS)} notes` }],
									},
								],
							}
						: null,
				statusId: pick(statuses).id,
				priority: pick(["urgent", "high", "normal", "low", "none"] as const),
				startDate: start === null ? null : day(start),
				dueDate: due === null ? null : day(due),
				isMilestone: r() < 0.1,
				assignees: some(people),
				tags: some(tags),
				fields: Object.fromEntries(
					fields.filter(() => r() < 0.6).map((f) => [f.id, value(f.config)]),
				),
				...(created.length && r() < 0.2 ? { parentId: pick(created).id } : {}),
			});
			created.push(t);
			const at = new Date(
				Date.parse("2026-11-09T12:00:00Z") +
					Math.floor(r() * 30 - 15) * 86_400_000,
			);
			await w.db
				.update(workTask)
				.set({ createdAt: at, updatedAt: at })
				.where(eq(workTask.id, t.id));
		}
		for (let i = 0; i < 8; i++) {
			const [a, b] = [pick(created), pick(created)];
			if (a.id !== b.id)
				await w.owner("POST", work(`/tasks/${a.id}/dependencies`), {
					blockedById: b.id,
				});
		}
		const list = await ok(
			"GET",
			work(
				`/tasks?projectId=${project}&include=assignees,tags,fields&includeClosed=true&includeArchived=true&limit=200`,
			),
		);
		const category = new Map(statuses.map((s) => [s.id, s.category]));
		const rows = await w.db
			.select({ id: workTask.id, d: workTask.descriptionText })
			.from(workTask)
			.where(eq(workTask.projectId, project));
		const desc = new Map(rows.map((x) => [x.id, x.d]));
		const tasks: MatchableTask[] = (list.items as WorkTaskListItem[]).map(
			(t) => ({
				...t,
				statusCategory: category.get(t.statusId) as string,
				assigneeIds: t.assigneeIds ?? [],
				tagIds: t.tagIds ?? [],
				descriptionText: desc.get(t.id) ?? null,
				blocked: t.blocked ?? false,
				fields: t.fields ?? {},
			}),
		);
		expect(tasks).toHaveLength(created.length);

		const dateValue = (op: FilterOp) =>
			op === "between"
				? [day(Math.floor(r() * 20 - 15)), day(Math.floor(r() * 20))]
				: op === "relative"
					? pick(relativeDates)
					: day(Math.floor(r() * 40 - 20));
		const condition = (): FilterCondition => {
			const fieldKey = r() < 0.4;
			if (fieldKey) {
				const f = pick(fields);
				const op = pick(fieldFilterOps(f.config.kind));
				const key = `field:${f.id}` as const;
				const k = f.config.kind;
				let v: unknown;
				if (["empty", "not_empty"].includes(op)) v = undefined;
				else if (k === "date") v = dateValue(op);
				else if (k === "checkbox") v = r() < 0.5;
				else if (k === "select" || k === "multi_select")
					v = ["is", "is_not"].includes(op)
						? pick(options).id
						: some(options)
								.map((o) => o.id)
								.concat("o1");
				else if (k === "user")
					v = ["is", "is_not"].includes(op)
						? pick([...people, "me"])
						: [pick([...people, "me"])];
				else if (op === "contains") v = pick(WORDS).slice(1, 4).toLowerCase();
				else if (op === "between")
					v = [Math.floor(r() * 10 - 5), Math.floor(r() * 400)];
				else v = Math.floor(r() * 12 - 6);
				return { key, op, ...(v === undefined ? {} : { value: v }) };
			}
			const key = pick(Object.keys(BUILTIN));
			const op = pick(BUILTIN[key] as FilterOp[]);
			const ids: Record<string, string[]> = {
				status: statuses.map((s) => s.id),
				statusCategory: ["backlog", "active", "done", "cancelled"],
				priority: ["urgent", "high", "normal", "low", "none"],
				list: [listA, listB],
				createdBy: [...people, "me"],
				assignee: [...people, "me"],
				tag: tags,
				parent: created.map((t) => t.id),
			};
			let v: unknown;
			if (["empty", "not_empty"].includes(op)) v = undefined;
			else if (key === "isMilestone" || key === "blocked") v = r() < 0.5;
			else if (key === "text") v = pick(WORDS).slice(0, 3).toLowerCase();
			else if (DATE_OPS.includes(op)) v = dateValue(op);
			else if (["any_of", "none_of", "all_of"].includes(op))
				v = [pick(ids[key] as string[]), ...some(ids[key] as string[])];
			else v = pick(ids[key] as string[]);
			return {
				key: key as FilterCondition["key"],
				op,
				...(v === undefined ? {} : { value: v }),
			};
		};
		const node = (depth: number): FilterNode => {
			if (depth >= 3 || r() < 0.5) return condition();
			const kids = Array.from({ length: 1 + Math.floor(r() * 3) }, () =>
				node(depth + 1),
			);
			return r() < 0.5 ? { and: kids } : { or: kids };
		};
		const ctx = { me: users.owner, now: new Date(), tz: "UTC" };
		const mismatches: string[] = [];
		let checked = 0;
		for (let i = 0; i < 400 && mismatches.length < 5; i++) {
			const filter = node(1);
			if (
				!validateFilter(
					filter,
					fields.map((f) => ({ id: f.id, kind: f.config.kind })),
				).ok
			)
				continue;
			checked++;
			const res = await ok(
				"GET",
				work(
					`/tasks?projectId=${project}&includeClosed=true&includeArchived=true&limit=200&filter=${encodeURIComponent(JSON.stringify(filter))}`,
				),
			);
			const sqlIds = (res.items as { id: string }[]).map((t) => t.id).sort();
			const coreIds = tasks
				.filter((t) => matchesTask(filter, t, ctx))
				.map((t) => t.id)
				.sort();
			if (JSON.stringify(sqlIds) !== JSON.stringify(coreIds))
				mismatches.push(
					`${JSON.stringify(filter)}\n  sql only: ${sqlIds.filter((x) => !coreIds.includes(x))}\n  core only: ${coreIds.filter((x) => !sqlIds.includes(x))}`,
				);
		}
		expect(mismatches).toEqual([]);
		expect(checked).toBeGreaterThan(200);
	}, 180_000);
});
