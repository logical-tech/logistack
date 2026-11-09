import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ProjectHealth } from "@logistack/contracts";
import {
	deployment,
	serviceStatus,
	workChecklistItem,
	workTask,
} from "@logistack/db";
import { eq } from "drizzle-orm";
import { cluster } from "../src/cluster.ts";
import { envelope } from "../src/events.ts";
import { WORK_CHANNEL, type WorkMessage } from "../src/work/context.ts";
import { eventVisible, workVisible } from "../src/ws.ts";
import { hasDocker } from "./harness.ts";
import {
	type ActorName,
	actorNames,
	startWorld,
	type World,
} from "./work-fixtures.ts";

const caps: Record<ActorName, string> = {
	owner: "RCWA",
	admin: "RCWA",
	developer: "RCW",
	viewer: "RC",
	manager: "RCWA",
	guest: "RC",
	custom: "RCW",
	folder: "RCWA",
	env: "",
};

type Req = { m: string; path: string; body?: unknown };
type Case = {
	name: string;
	/** R read:work, C comment:work, W work, A work:admin; or the actors allowed. */
	need: "R" | "C" | "W" | "A" | ActorName[];
	make: (a: ActorName) => Promise<Req>;
};

let seq = 0;
const uniq = (p: string) => `${p}-${++seq}`;

describe.skipIf(!hasDocker)("work api", () => {
	let w: World;
	beforeAll(async () => {
		w = await startWorld("work-api");
	}, 120_000);
	afterAll(() => w?.close());

	test("permissions matrix: every Work route, every access shape", async () => {
		const { P, P2, work, ok, task, listOf, statuses, users } = w;
		const fresh = () => task(P);
		const one = <T>(make: () => Promise<T>) => {
			let v: Promise<T> | undefined;
			return () => (v ??= make());
		};
		const sharedStatus = one(
			async () =>
				(
					await ok("POST", work(`/projects/${P}/statuses`), {
						name: "Shared",
						color: "blue",
						category: "active",
					})
				).id,
		);
		const sharedList = one(
			async () =>
				(
					await ok("POST", work(`/projects/${P}/lists`), {
						name: "Shared list",
					})
				).id,
		);
		const sharedField = one(
			async () =>
				(
					await ok("POST", work(`/projects/${P}/fields`), {
						name: "Client",
						config: { kind: "text" },
					})
				).id,
		);
		const sharedTag = one(
			async () =>
				(await ok("POST", work(`/projects/${P}/tags`), { name: "urgent-ish" }))
					.id,
		);
		const sharedView = one(
			async () =>
				(
					await ok("POST", work(`/projects/${P}/views`), {
						name: "Shared view",
						kind: "table",
						shared: true,
					})
				).id,
		);
		const item = async (taskId: string, assigneeId: string | null = null) =>
			(
				await w.db
					.insert(workChecklistItem)
					.values({ taskId, text: "Check", assigneeId, position: "V" })
					.returning()
			)[0]?.id as string;
		const ids = async (path: string) =>
			(
				(await ok("GET", work(path))) as {
					id: string;
					ownerId?: string | null;
				}[]
			)
				.filter((x) => x.ownerId == null)
				.map((x) => x.id);
		const cases: Case[] = [
			{
				name: "projectGet",
				need: "R",
				make: async () => ({ m: "GET", path: work(`/projects/${P}`) }),
			},
			{
				name: "projectSettings",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/projects/${P}/settings`),
					body: { workingDays: 31 },
				}),
			},
			{
				name: "projectHealth",
				need: "R",
				make: async () => ({ m: "GET", path: work(`/projects/${P}/health`) }),
			},
			{
				name: "projectSummary",
				need: "R",
				make: async () => ({ m: "GET", path: work(`/projects/${P}/summary`) }),
			},
			{
				name: "projectPeople",
				need: "R",
				make: async () => ({ m: "GET", path: work(`/projects/${P}/people`) }),
			},
			{
				name: "projectServices",
				need: "A",
				make: async () => ({ m: "GET", path: work(`/projects/${P}/services`) }),
			},
			{
				name: "statusList",
				need: "R",
				make: async () => ({ m: "GET", path: work(`/projects/${P}/statuses`) }),
			},
			{
				name: "statusCreate",
				need: "A",
				make: async () => ({
					m: "POST",
					path: work(`/projects/${P}/statuses`),
					body: { name: uniq("S"), color: "gray", category: "active" },
				}),
			},
			{
				name: "statusUpdate",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/statuses/${await sharedStatus()}`),
					body: { color: "teal" },
				}),
			},
			{
				name: "statusDelete",
				need: "A",
				make: async () => ({
					m: "DELETE",
					path: work(
						`/statuses/${(await ok("POST", work(`/projects/${P}/statuses`), { name: uniq("D"), color: "gray", category: "active" })).id}`,
					),
				}),
			},
			{
				name: "statusOrder",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/projects/${P}/statuses/order`),
					body: { ids: (await statuses(P)).map((s) => s.id) },
				}),
			},
			{
				name: "listList",
				need: "R",
				make: async () => ({ m: "GET", path: work(`/projects/${P}/lists`) }),
			},
			{
				name: "listCreate",
				need: "A",
				make: async () => ({
					m: "POST",
					path: work(`/projects/${P}/lists`),
					body: { name: uniq("L") },
				}),
			},
			{
				name: "listUpdate",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/lists/${await sharedList()}`),
					body: { color: "pink" },
				}),
			},
			{
				name: "listDelete",
				need: "A",
				make: async () => ({
					m: "DELETE",
					path: work(
						`/lists/${(await ok("POST", work(`/projects/${P}/lists`), { name: uniq("LD") })).id}`,
					),
				}),
			},
			{
				name: "listArchive",
				need: "A",
				make: async () => ({
					m: "POST",
					path: work(`/lists/${await sharedList()}/archive`),
				}),
			},
			{
				name: "listRestore",
				need: "A",
				make: async () => ({
					m: "POST",
					path: work(`/lists/${await sharedList()}/restore`),
				}),
			},
			{
				name: "listOrder",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/projects/${P}/lists/order`),
					body: { ids: await ids(`/projects/${P}/lists`) },
				}),
			},
			{
				name: "fieldList",
				need: "R",
				make: async () => ({ m: "GET", path: work(`/projects/${P}/fields`) }),
			},
			{
				name: "fieldCreate",
				need: "A",
				make: async () => ({
					m: "POST",
					path: work(`/projects/${P}/fields`),
					body: { name: uniq("F"), config: { kind: "number" } },
				}),
			},
			{
				name: "fieldUpdate",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/fields/${await sharedField()}`),
					body: { description: "Who it's for" },
				}),
			},
			{
				name: "fieldDelete",
				need: "A",
				make: async () => ({
					m: "DELETE",
					path: work(
						`/fields/${(await ok("POST", work(`/projects/${P}/fields`), { name: uniq("FD"), config: { kind: "checkbox" } })).id}`,
					),
				}),
			},
			{
				name: "fieldOrder",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/projects/${P}/fields/order`),
					body: { ids: await ids(`/projects/${P}/fields`) },
				}),
			},
			{
				name: "tagList",
				need: "R",
				make: async () => ({ m: "GET", path: work(`/projects/${P}/tags`) }),
			},
			{
				name: "tagCreate",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work(`/projects/${P}/tags`),
					body: { name: uniq("T") },
				}),
			},
			{
				name: "tagUpdate",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/tags/${await sharedTag()}`),
					body: { color: "red" },
				}),
			},
			{
				name: "tagDelete",
				need: "A",
				make: async () => ({
					m: "DELETE",
					path: work(
						`/tags/${(await ok("POST", work(`/projects/${P}/tags`), { name: uniq("TD") })).id}`,
					),
				}),
			},
			{
				name: "viewList",
				need: "R",
				make: async () => ({ m: "GET", path: work(`/projects/${P}/views`) }),
			},
			{
				name: "viewCreate (personal)",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work(`/projects/${P}/views`),
					body: { name: uniq("V"), kind: "board" },
				}),
			},
			{
				name: "viewCreate (shared)",
				need: "A",
				make: async () => ({
					m: "POST",
					path: work(`/projects/${P}/views`),
					body: { name: uniq("VS"), kind: "board", shared: true },
				}),
			},
			{
				name: "viewUpdate",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/views/${await sharedView()}`),
					body: { config: { showClosed: true } },
				}),
			},
			{
				name: "viewDelete",
				need: "A",
				make: async () => ({
					m: "DELETE",
					path: work(
						`/views/${(await ok("POST", work(`/projects/${P}/views`), { name: uniq("VD"), kind: "table", shared: true })).id}`,
					),
				}),
			},
			{
				name: "viewOrder",
				need: "A",
				make: async () => ({
					m: "PATCH",
					path: work(`/projects/${P}/views/order`),
					body: { ids: await ids(`/projects/${P}/views`) },
				}),
			},
			{
				name: "taskList",
				need: "R",
				make: async () => ({
					m: "GET",
					path: work(
						`/tasks?projectId=${P}&include=assignees,tags,fields,counts`,
					),
				}),
			},
			{
				name: "taskByKey",
				need: "R",
				make: async () => ({
					m: "GET",
					path: work(`/tasks/by-key/${(await fresh()).key}`),
				}),
			},
			{
				name: "taskCreate",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work("/tasks"),
					body: { listId: await listOf(P), title: "New" },
				}),
			},
			{
				name: "taskGet",
				need: "R",
				make: async () => ({
					m: "GET",
					path: work(`/tasks/${(await fresh()).id}`),
				}),
			},
			{
				name: "taskUpdate",
				need: "W",
				make: async () => ({
					m: "PATCH",
					path: work(`/tasks/${(await fresh()).id}`),
					body: { title: "Renamed" },
				}),
			},
			{
				name: "taskMove",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work(`/tasks/${(await fresh()).id}/move`),
					body: { statusId: (await statuses(P))[1]?.id },
				}),
			},
			{
				name: "taskMoveProject",
				need: ["owner", "admin", "developer", "custom", "folder"],
				make: async () => ({
					m: "POST",
					path: work(`/tasks/${(await fresh()).id}/move-project`),
					body: { projectId: P2, listId: await listOf(P2) },
				}),
			},
			{
				name: "taskDuplicate",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work(`/tasks/${(await fresh()).id}/duplicate`),
					body: {},
				}),
			},
			{
				name: "taskArchive",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work(`/tasks/${(await fresh()).id}/archive`),
				}),
			},
			{
				name: "taskRestore",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work(`/tasks/${(await fresh()).id}/restore`),
				}),
			},
			{
				name: "taskDelete",
				need: "A",
				make: async () => ({
					m: "DELETE",
					path: work(`/tasks/${(await fresh()).id}`),
				}),
			},
			{
				name: "taskAssigneeAdd",
				need: "W",
				make: async () => ({
					m: "PUT",
					path: work(
						`/tasks/${(await fresh()).id}/assignees/${users.developer}`,
					),
				}),
			},
			{
				name: "taskAssigneeRemove",
				need: "W",
				make: async () => ({
					m: "DELETE",
					path: work(
						`/tasks/${(await task(P, { assignees: [users.developer] })).id}/assignees/${users.developer}`,
					),
				}),
			},
			{
				name: "taskWatcherAdd (self)",
				need: "R",
				make: async (a) => ({
					m: "PUT",
					path: work(`/tasks/${(await fresh()).id}/watchers/${users[a]}`),
				}),
			},
			{
				name: "taskWatcherRemove (self)",
				need: "R",
				make: async (a) => ({
					m: "DELETE",
					path: work(`/tasks/${(await fresh()).id}/watchers/${users[a]}`),
				}),
			},
			{
				name: "taskWatcherAdd (other)",
				need: "W",
				make: async (a) => ({
					m: "PUT",
					path: work(
						`/tasks/${(await fresh()).id}/watchers/${a === "viewer" ? users.developer : users.viewer}`,
					),
				}),
			},
			{
				name: "taskTagAdd",
				need: "W",
				make: async () => ({
					m: "PUT",
					path: work(`/tasks/${(await fresh()).id}/tags/${await sharedTag()}`),
				}),
			},
			{
				name: "taskTagRemove",
				need: "W",
				make: async () => ({
					m: "DELETE",
					path: work(`/tasks/${(await fresh()).id}/tags/${await sharedTag()}`),
				}),
			},
			{
				name: "taskFieldSet",
				need: "W",
				make: async () => ({
					m: "PUT",
					path: work(
						`/tasks/${(await fresh()).id}/fields/${await sharedField()}`,
					),
					body: { value: "Acme" },
				}),
			},
			{
				name: "taskFieldClear",
				need: "W",
				make: async () => ({
					m: "DELETE",
					path: work(
						`/tasks/${(await fresh()).id}/fields/${await sharedField()}`,
					),
				}),
			},
			{
				name: "taskDependencyAdd",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work(`/tasks/${(await fresh()).id}/dependencies`),
					body: { blockedById: (await fresh()).id },
				}),
			},
			{
				name: "taskDependencyRemove",
				need: "W",
				make: async () => {
					const [a, b] = [await fresh(), await fresh()];
					await ok("POST", work(`/tasks/${a.id}/dependencies`), {
						blockedById: b.id,
					});
					return {
						m: "DELETE",
						path: work(`/tasks/${a.id}/dependencies/${b.id}`),
					};
				},
			},
			{
				name: "taskShiftPreview",
				need: "R",
				make: async () => ({
					m: "POST",
					path: work(`/tasks/${(await fresh()).id}/shift-preview`),
					body: { deltaDays: 2 },
				}),
			},
			{
				name: "checklistList",
				need: "R",
				make: async () => ({
					m: "GET",
					path: work(`/tasks/${(await fresh()).id}/checklist`),
				}),
			},
			{
				name: "checklistCreate",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work(`/tasks/${(await fresh()).id}/checklist`),
					body: { text: "Step" },
				}),
			},
			{
				name: "checklistUpdate",
				need: "W",
				make: async () => ({
					m: "PATCH",
					path: work(`/checklist/${await item((await fresh()).id)}`),
					body: { text: "Edited" },
				}),
			},
			{
				name: "checklistUpdate (tick own)",
				need: "C",
				make: async (a) => ({
					m: "PATCH",
					path: work(`/checklist/${await item((await fresh()).id, users[a])}`),
					body: { done: true },
				}),
			},
			{
				name: "checklistDelete",
				need: "W",
				make: async () => ({
					m: "DELETE",
					path: work(`/checklist/${await item((await fresh()).id)}`),
				}),
			},
			{
				name: "checklistConvert",
				need: "W",
				make: async () => ({
					m: "POST",
					path: work(`/checklist/${await item((await fresh()).id)}/convert`),
				}),
			},
			{
				name: "taskActivity",
				need: "R",
				make: async () => ({
					m: "GET",
					path: work(`/tasks/${(await fresh()).id}/activity`),
				}),
			},
		];
		const failures: string[] = [];
		for (const c of cases)
			for (const a of actorNames) {
				const allowed = Array.isArray(c.need)
					? c.need.includes(a)
					: caps[a].includes(c.need);
				const r = await c.make(a);
				const res = await w.calls[a](r.m, r.path, r.body);
				const passed = allowed
					? res.status < 400 || res.status === 409
					: res.status === 403 || res.status === 404;
				if (!passed)
					failures.push(
						`${c.name} as ${a}: ${res.status} ${res.text.slice(0, 160)}`,
					);
			}
		// Bulk checks each task: a denied actor gets a per-task error, not a 403.
		for (const a of actorNames) {
			const t = await fresh();
			const res = await w.calls[a]("POST", work("/tasks/bulk"), {
				taskIds: [t.id],
				set: { priority: "high" },
			});
			const allowed = caps[a].includes("W");
			if (
				res.status !== 200 ||
				res.json.updated.includes(t.id) !== allowed ||
				(!allowed && res.json.errors[0]?.code !== "forbidden")
			)
				failures.push(
					`taskBulk as ${a}: ${res.status} ${res.text.slice(0, 160)}`,
				);
		}
		// Cross-project routes filter rows instead of refusing.
		const marker = (
			await task(P, { title: "Findable marker", assignees: [users.developer] })
		).id;
		for (const a of actorNames) {
			const reads = caps[a].includes("R");
			const projects = await w.calls[a]("GET", work("/projects"));
			const search = await w.calls[a]("GET", work("/search?q=Findable"));
			const mine = await w.calls[a]("GET", work("/me/tasks"));
			const assigned = await w.calls[a]("GET", work("/tasks?assignee=me"));
			if ([projects, search, mine, assigned].some((r) => r.status !== 200))
				failures.push(
					`filtered routes as ${a}: ${[projects, search, mine, assigned].map((r) => r.status)}`,
				);
			if (projects.json.some((p: { id: string }) => p.id === P) !== reads)
				failures.push(`projectList as ${a}`);
			if (
				search.json.items.some((x: { id: string }) => x.id === marker) !== reads
			)
				failures.push(`search as ${a}`);
		}
		expect(failures).toEqual([]);
	}, 300_000);

	test("50 parallel creates get numbers 1..50", async () => {
		const project = (await w.ok("POST", "/api/projects", { name: "Numbers" }))
			.id;
		const listId = await w.listOf(project);
		const made = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				w.owner("POST", w.work("/tasks"), { listId, title: `T${i}` }),
			),
		);
		expect(made.map((r) => r.status).filter((s) => s !== 201)).toEqual([]);
		expect(made.map((r) => r.json.number).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 50 }, (_, i) => i + 1),
		);
		const positions = made.map((r) => r.json.position);
		expect(new Set(positions).size).toBe(50);
	}, 60_000);

	test("concurrent moves to one spot keep positions unique; long keys rebalance", async () => {
		const project = (await w.ok("POST", "/api/projects", { name: "Board" })).id;
		const listId = await w.listOf(project);
		const tasks = [];
		for (let i = 0; i < 12; i++)
			tasks.push(await w.task(project, { title: `B${i}` }));
		const [anchor, next, ...rest] = tasks as [
			(typeof tasks)[0],
			(typeof tasks)[0],
			...typeof tasks,
		];
		const moves = await Promise.all(
			rest.map((t) =>
				w.owner("POST", w.work(`/tasks/${t.id}/move`), {
					after: anchor.id,
					before: next.id,
				}),
			),
		);
		expect(moves.map((r) => r.status).filter((s) => s !== 200)).toEqual([]);
		const rows = await w.db
			.select({ p: workTask.position })
			.from(workTask)
			.where(eq(workTask.listId, listId));
		expect(new Set(rows.map((r) => r.p)).size).toBe(rows.length);
		// Neighbours so close that the new key would be too long make the whole list re-spread.
		await w.db
			.update(workTask)
			.set({ position: "U".repeat(30) })
			.where(eq(workTask.id, anchor.id));
		await w.db
			.update(workTask)
			.set({ position: `${"U".repeat(30)}1` })
			.where(eq(workTask.id, next.id));
		const moved = await w.owner(
			"POST",
			w.work(`/tasks/${(rest[0] as typeof anchor).id}/move`),
			{ after: anchor.id, before: next.id },
		);
		expect(moved.status).toBe(200);
		const after = await w.db
			.select({ id: workTask.id, p: workTask.position })
			.from(workTask)
			.where(eq(workTask.listId, listId));
		expect(Math.max(...after.map((r) => r.p.length))).toBeLessThan(10);
		expect(new Set(after.map((r) => r.p)).size).toBe(after.length);
		const order = [...after]
			.sort((a, b) => (a.p < b.p ? -1 : 1))
			.map((r) => r.id);
		expect(order.indexOf((rest[0] as typeof anchor).id)).toBe(
			order.indexOf(anchor.id) + 1,
		);
	}, 60_000);

	test("a stale expectedUpdatedAt gets 409 with the current task", async () => {
		const t = await w.task(w.P, { title: "Original" });
		const first = await w.owner("PATCH", w.work(`/tasks/${t.id}`), {
			title: "First",
			expectedUpdatedAt: t.updatedAt,
		});
		expect(first.status).toBe(200);
		const stale = await w.owner("PATCH", w.work(`/tasks/${t.id}`), {
			title: "Second",
			expectedUpdatedAt: t.updatedAt,
		});
		expect(stale.status).toBe(409);
		expect(stale.json.error.details).toMatchObject({
			id: t.id,
			title: "First",
		});
		const fresh = await w.owner("PATCH", w.work(`/tasks/${t.id}`), {
			title: "Second",
			expectedUpdatedAt: first.json.updatedAt,
		});
		expect(fresh.status).toBe(200);
	});

	test("dependency cycles are refused naming the loop", async () => {
		const [a, b, c] = [await w.task(w.P), await w.task(w.P), await w.task(w.P)];
		await w.ok("POST", w.work(`/tasks/${a.id}/dependencies`), {
			blockedById: b.id,
		});
		await w.ok("POST", w.work(`/tasks/${b.id}/dependencies`), {
			blockedById: c.id,
		});
		const loop = await w.owner("POST", w.work(`/tasks/${c.id}/dependencies`), {
			blockedById: a.id,
		});
		expect(loop.status).toBe(409);
		expect(loop.json.error.message).toContain(
			`${c.key} → ${a.key} → ${b.key} → ${c.key}`,
		);
		const full = await w.ok("GET", w.work(`/tasks/${a.id}`));
		expect(full.blocked).toBe(true);
		expect(
			full.dependencies.blockedBy.map((e: { id: string }) => e.id),
		).toEqual([b.id]);
	});

	test("old keys and moved tasks still resolve", async () => {
		const t = await w.task(w.P2);
		const before = t.key;
		await w.ok("PATCH", w.work(`/projects/${w.P2}/settings`), { key: "BLOG" });
		const byOld = await w.ok("GET", w.work(`/tasks/by-key/${before}`));
		expect(byOld).toMatchObject({ taskId: t.id, key: `BLOG-${t.number}` });
		const field = await w.ok("POST", w.work(`/projects/${w.P2}/fields`), {
			name: "Budget",
			config: { kind: "currency", currency: "EUR" },
		});
		await w.ok("PUT", w.work(`/tasks/${t.id}/fields/${field.id}`), {
			value: "12.50",
		});
		const dry = await w.ok(
			"POST",
			w.work(`/tasks/${t.id}/move-project?dryRun=true`),
			{ projectId: w.Q, listId: await w.listOf(w.Q) },
		);
		expect(dry.dropped).toEqual([
			{
				fieldId: field.id,
				name: "Budget",
				reason: "no matching field in the target project",
			},
		]);
		const moved = await w.ok("POST", w.work(`/tasks/${t.id}/move-project`), {
			projectId: w.Q,
			listId: await w.listOf(w.Q),
		});
		expect(moved.key).not.toBe(`BLOG-${t.number}`);
		expect(
			(await w.ok("GET", w.work(`/tasks/by-key/BLOG-${t.number}`))).taskId,
		).toBe(t.id);
		expect((await w.ok("GET", w.work(`/tasks/by-key/${before}`))).key).toBe(
			moved.key,
		);
	});

	test("list filters, groups and CSV", async () => {
		const project = (await w.ok("POST", "/api/projects", { name: "Filters" }))
			.id;
		const [, todo] = await w.statuses(project);
		const a = await w.task(project, {
			title: "Alpha",
			priority: "high",
			assignees: [w.users.developer],
		});
		await w.task(project, { title: "Beta", statusId: todo?.id });
		const q = (filter: unknown) =>
			w.ok(
				"GET",
				w.work(
					`/tasks?projectId=${project}&filter=${encodeURIComponent(JSON.stringify(filter))}`,
				),
			);
		expect(
			(await q({ key: "priority", op: "is", value: "high" })).items.map(
				(t: { id: string }) => t.id,
			),
		).toEqual([a.id]);
		expect(
			(await q({ key: "text", op: "contains", value: "bet" })).items,
		).toHaveLength(1);
		const bad = await w.owner(
			"GET",
			w.work(
				`/tasks?projectId=${project}&filter=${encodeURIComponent(JSON.stringify({ key: "field:nope", op: "is", value: 1 }))}`,
			),
		);
		expect(bad.status).toBe(400);
		const group = await w.ok(
			"GET",
			w.work(`/tasks?projectId=${project}&groupBy=assignee&group=none`),
		);
		expect(group.items.map((t: { title: string }) => t.title)).toEqual([
			"Beta",
		]);
		expect(group.total).toBe(1);
		const csv = await w.owner(
			"GET",
			w.work(`/tasks?projectId=${project}&format=csv`),
		);
		expect(csv.headers.get("content-type")).toContain("text/csv");
		expect(csv.text.split("\r\n")[0]).toStartWith('"Key","Title","Status"');
		expect(csv.text).toContain('"Developer User"');
	});

	test("health returns exactly the section 6.3 keys, with the rollout guard", async () => {
		const project = (await w.ok("POST", "/api/projects", { name: "Healthy" }))
			.id;
		const env = await w.envOf(project);
		const svc = await w.ok("POST", `/api/environments/${env}/services`, {
			name: "Web",
			spec: {
				kind: "application",
				source: { type: "image", image: "nginx:1.27" },
				build: { type: "image" },
				ports: [{ target: 80, protocol: "tcp" }],
				replicas: 2,
				resources: {},
				placement: [],
			},
		});
		const health = () =>
			w.calls.manager("GET", w.work(`/projects/${project}/health`));
		// The manager has no grant here; the folder-less project is the owner's.
		expect((await health()).status).toBe(403);
		const get = () => w.ok("GET", w.work(`/projects/${project}/health`));
		expect((await get()).health).toBe("unknown");
		await w.db.insert(serviceStatus).values({
			serviceId: svc.id,
			observed: "running",
			replicasRunning: 2,
			replicasDesired: 2,
		});
		const h = await get();
		expect(Object.keys(h).sort()).toEqual(
			Object.keys(ProjectHealth.shape).sort(),
		);
		expect(Object.keys(h).sort()).toEqual(["health", "services", "since"]);
		expect(Object.keys(h.services[0]).sort()).toEqual([
			"days",
			"health",
			"icon",
			"id",
			"name",
			"since",
			"uptime30d",
			"url",
		]);
		expect(h).toMatchObject({
			health: "operational",
			services: [{ id: svc.id, name: "Web", health: "operational" }],
		});
		await w.db
			.update(serviceStatus)
			.set({ replicasRunning: 1 })
			.where(eq(serviceStatus.serviceId, svc.id));
		expect((await get()).health).toBe("degraded");
		// A rollout under 10 minutes old isn't a degradation.
		await w.db.insert(deployment).values({
			serviceId: svc.id,
			status: "deploying",
			trigger: "manual",
			startedAt: new Date(Date.now() - 60_000),
		});
		expect((await get()).health).not.toBe("degraded");
		await w.db
			.update(serviceStatus)
			.set({ observed: "failed", replicasRunning: 0 })
			.where(eq(serviceStatus.serviceId, svc.id));
		expect((await get()).health).toBe("down");
		await w.ok("PATCH", w.work(`/projects/${project}/settings`), {
			hiddenServiceIds: [svc.id],
		});
		expect(await get()).toEqual({
			health: "unknown",
			since: null,
			services: [],
		});
	});

	test("a mutation publishes one Work message, delivered only where read:work holds", async () => {
		const got: WorkMessage[] = [];
		const off = await cluster(w.h.config.REDIS_URL).on(WORK_CHANNEL, (m) =>
			got.push(m as WorkMessage),
		);
		const t = await w.task(w.P);
		await w.ok("PATCH", w.work(`/tasks/${t.id}`), { priority: "low" });
		for (
			let i = 0;
			i < 50 && got.filter((m) => m.taskIds?.includes(t.id)).length < 2;
			i++
		)
			await Bun.sleep(20);
		off();
		const mine = got.filter((m) => m.taskIds?.includes(t.id));
		expect(mine.map((m) => m.op)).toEqual(["upsert", "upsert"]);
		const msg = mine[0] as WorkMessage;
		expect(msg).toMatchObject({
			type: "work",
			organizationId: w.orgId,
			projectId: w.P,
			entity: "task",
		});
		const visible = (a: ActorName, m: WorkMessage = msg) =>
			workVisible(w.db, w.actors[a], new Map(), m);
		for (const a of actorNames)
			expect(await visible(a)).toBe(caps[a].includes("R"));
		expect(await visible("owner", { ...msg, projectId: w.Q })).toBe(true);
		expect(await visible("manager", { ...msg, projectId: w.Q })).toBe(false);
		expect(await visible("manager", { ...msg, userId: w.users.owner })).toBe(
			false,
		);
		expect(await visible("manager", { ...msg, organizationId: "other" })).toBe(
			false,
		);
	});

	test("task.* events on the org channel need read:work on the event's project", async () => {
		const ev = (type: "task.created" | "deployment.started", payload = {}) =>
			envelope(type, w.orgId, { type: "task", id: "tsk_x" }, payload);
		const titled = ev("task.created", { projectId: w.P, title: "Secret plan" });
		for (const a of actorNames)
			expect(await eventVisible(w.db, w.actors[a], new Map(), titled)).toBe(
				caps[a].includes("R"),
			);
		expect(
			await eventVisible(w.db, w.actors.manager, new Map(), {
				...titled,
				payload: { ...titled.payload, projectId: w.Q },
			}),
		).toBe(false);
		expect(
			await eventVisible(w.db, w.actors.owner, new Map(), ev("task.created")),
		).toBe(false);
		expect(
			await eventVisible(
				w.db,
				w.actors.env,
				new Map(),
				ev("deployment.started"),
			),
		).toBe(true);
	});

	test("include=dependencies lists each row's blockers in one extra query", async () => {
		// Subtasks of one parent, so a single page holds them all.
		const parent = await w.task(w.P);
		const sub = () => w.task(w.P, { parentId: parent.id });
		const [a, b, c] = [await sub(), await sub(), await sub()];
		await w.ok("POST", w.work(`/tasks/${a.id}/dependencies`), {
			blockedById: b.id,
			lagDays: 2,
		});
		await w.ok("POST", w.work(`/tasks/${a.id}/dependencies`), {
			blockedById: c.id,
		});
		const page = await w.ok(
			"GET",
			w.work(
				`/tasks?projectId=${w.P}&parentId=${parent.id}&include=dependencies`,
			),
		);
		const row = (id: string) =>
			page.items.find((t: { id: string }) => t.id === id);
		expect(
			row(a.id).dependencies.sort(
				(x: { blockedById: string }, y: { blockedById: string }) =>
					x.blockedById.localeCompare(y.blockedById),
			),
		).toEqual(
			[
				{ blockedById: b.id, lagDays: 2 },
				{ blockedById: c.id, lagDays: 0 },
			].sort((x, y) => x.blockedById.localeCompare(y.blockedById)),
		);
		expect(row(b.id).dependencies).toEqual([]);
		const plain = await w.ok(
			"GET",
			w.work(`/tasks?projectId=${w.P}&parentId=${parent.id}`),
		);
		expect(
			plain.items.find((t: { id: string }) => t.id === a.id).dependencies,
		).toBeUndefined();
	});
});
