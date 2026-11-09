import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RecurrenceRule } from "@logistack/contracts";
import { addDays, localDate } from "@logistack/core";
import {
	user,
	workDependency,
	workNotification,
	workProject,
	workStatus,
	workTask,
	workTimeEntry,
} from "@logistack/db";
import {
	notifyLongTimers,
	tickRecurrence,
} from "@logistack/worker/work-recurrence";
import { and, asc, eq, isNull } from "drizzle-orm";
import { setPriceCatalog } from "../src/ai/catalog.ts";
import { ensureWorkProject, nextTaskNumber } from "../src/work/context.ts";
import { applyRecurrenceOnComplete } from "../src/work/recurrence.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const dev = {
	name: "Dana Dev",
	email: "dana@example.com",
	password: "dana password 12",
};
const viewer = {
	name: "Vic Viewer",
	email: "vic@example.com",
	password: "vic password 1234",
};

/** A fake OpenAI-compatible model: JSON subtasks when asked to break a task down, bullets otherwise. */
function fakeModel() {
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (new URL(req.url).pathname === "/v1/models")
				return Response.json({ data: [{ id: "tiny" }] });
			const body = (await req.json()) as {
				messages: { content: string }[];
			};
			const ask = body.messages.at(-1)?.content ?? "";
			const content = ask.startsWith("Break")
				? '[{"title":"Write copy","estimateMinutes":60},{"title":"Review"}]'
				: "- Agreed on the launch date\n- Copy is still open";
			return Response.json({
				id: "x",
				object: "chat.completion",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 10 },
			});
		},
	});
	return { server, url: `http://127.0.0.1:${server.port}/v1` };
}

describe.skipIf(!hasDocker)(
	"work extras: time, templates, recurrence, AI",
	() => {
		let h: Harness;
		let ownerCookie: string;
		let devCookie: string;
		let viewerCookie: string;
		let ownerId: string;
		let devId: string;
		let projectId: string;
		let listId: string;
		let todoId: string;
		let doneId: string;
		const model = fakeModel();
		const as = (cookie: string) => ({ headers: { cookie } });
		const asOwner = () => as(ownerCookie);
		const asDev = () => as(devCookie);

		async function task(
			title: string,
			extra: Partial<typeof workTask.$inferInsert> = {},
		) {
			const [row] = await h.deps.db
				.insert(workTask)
				.values({
					projectId,
					listId,
					number: await nextTaskNumber(h.deps.db, projectId),
					title,
					statusId: todoId,
					position: `a${Math.random().toString(36).slice(2, 8)}`,
					...extra,
				})
				.returning();
			if (!row) throw new Error("task not inserted");
			return row;
		}

		async function join(u: typeof dev, role: string) {
			await h.call("POST", "/api/auth/sign-up/email", { body: u });
			await h.deps.db
				.update(user)
				.set({ emailVerified: true })
				.where(eq(user.email, u.email));
			const added = await h.call("POST", "/api/members", {
				...asOwner(),
				body: { email: u.email, role },
			});
			expect(added.status).toBe(201);
			return {
				cookie: await h.signIn(u.email, u.password),
				id: added.json.userId as string,
			};
		}

		beforeAll(async () => {
			setPriceCatalog({});
			h = await startHarness({ area: "work-extras-a", label: "work-extras-a" });
			await h.call("POST", "/api/setup", { body: setupBody });
			ownerCookie = await h.signIn(owner.email, owner.password);
			ownerId = (await h.call("GET", "/api/me", asOwner())).json.userId;
			({ cookie: devCookie, id: devId } = await join(dev, "developer"));
			({ cookie: viewerCookie } = await join(viewer, "viewer"));
			projectId = (
				await h.call("POST", "/api/projects", {
					...asOwner(),
					body: { name: "Shop" },
				})
			).json.id;
			const wp = await ensureWorkProject(h.deps.db, projectId);
			listId = wp.defaultListId as string;
			const statuses = await h.deps.db
				.select()
				.from(workStatus)
				.where(eq(workStatus.projectId, projectId))
				.orderBy(asc(workStatus.position));
			todoId = statuses.find((s) => s.name === "To do")?.id as string;
			doneId = statuses.find((s) => s.category === "done")?.id as string;
		}, 120_000);
		afterAll(async () => {
			model.server.stop(true);
			await h?.close();
		});

		describe("time", () => {
			test("concurrent starts leave exactly one running timer", async () => {
				const a = await task("Checkout page");
				const b = await task("Payment flow");
				const res = await Promise.all(
					[a, b, a, b, a].map((t) =>
						h.call("POST", `/api/work/tasks/${t.id}/timer/start`, asOwner()),
					),
				);
				expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
				const running = await h.deps.db
					.select()
					.from(workTimeEntry)
					.where(
						and(
							eq(workTimeEntry.userId, ownerId),
							isNull(workTimeEntry.endedAt),
						),
					);
				expect(running).toHaveLength(1);
				const me = await h.call("GET", "/api/work/me/timer", asOwner());
				expect(me.json.running.id).toBe(running[0]?.id);
				expect(me.json.running.taskKey).toMatch(/^SHOP-\d+$/);
				const stop = await h.call("POST", "/api/work/me/timer/stop", asOwner());
				expect(stop.json).toEqual({ running: null });
				expect(
					(await h.call("GET", "/api/work/me/timer", asOwner())).json.running,
				).toBeNull();
			});

			test("viewers can't track time; overlapping entries are refused", async () => {
				const t = await task("Hero banner");
				expect(
					(
						await h.call(
							"POST",
							`/api/work/tasks/${t.id}/timer/start`,
							as(viewerCookie),
						)
					).status,
				).toBe(403);
				const first = await h.call("POST", `/api/work/tasks/${t.id}/time`, {
					...asDev(),
					body: { startedAt: "2026-10-05T10:00:00Z", durationSec: 3600 },
				});
				expect(first.status).toBe(201);
				const clash = await h.call("POST", `/api/work/tasks/${t.id}/time`, {
					...asDev(),
					body: { startedAt: "2026-10-05T10:30:00+00:00", durationSec: 3600 },
				});
				expect(clash.status).toBe(409);
				expect(clash.json.error.details.entry.id).toBe(first.json.id);
				// Back to back is fine.
				const next = await h.call("POST", `/api/work/tasks/${t.id}/time`, {
					...asDev(),
					body: { startedAt: "2026-10-05T11:00:00Z", durationSec: 600 },
				});
				expect(next.status).toBe(201);

				// Someone else's entry needs work:admin: the developer can't, the owner can.
				const mine = await h.call("POST", `/api/work/tasks/${t.id}/time`, {
					...asOwner(),
					body: { startedAt: "2026-10-06T09:00:00Z", durationSec: 600 },
				});
				expect(
					(
						await h.call("PATCH", `/api/work/time/${mine.json.id}`, {
							...asDev(),
							body: { note: "nope" },
						})
					).status,
				).toBe(403);
				const edited = await h.call(
					"PATCH",
					`/api/work/time/${first.json.id}`,
					{
						...asOwner(),
						body: { billable: false, note: "Call with client" },
					},
				);
				expect(edited.json).toMatchObject({
					billable: false,
					durationSec: 3600,
				});

				// The lock date makes older entries read-only.
				await h.deps.db
					.update(workProject)
					.set({ timeLockedBefore: "2026-10-06" })
					.where(eq(workProject.projectId, projectId));
				expect(
					(await h.call("DELETE", `/api/work/time/${first.json.id}`, asOwner()))
						.status,
				).toBe(403);
				expect(
					(
						await h.call("POST", `/api/work/tasks/${t.id}/time`, {
							...asDev(),
							body: { startedAt: "2026-10-01T09:00:00Z", durationSec: 600 },
						})
					).status,
				).toBe(403);
				await h.deps.db
					.update(workProject)
					.set({ timeLockedBefore: null })
					.where(eq(workProject.projectId, projectId));
				const list = await h.call(
					"GET",
					`/api/work/tasks/${t.id}/time`,
					asDev(),
				);
				expect(list.json).toHaveLength(3);
			});

			test("the report cuts days in the requested zone, across midnight", async () => {
				const t = await task('Fix "cart", totals');
				// 22:30–00:30 UTC; in Rome (UTC+1 in March) 23:30–01:30.
				await h.call("POST", `/api/work/tasks/${t.id}/time`, {
					...asDev(),
					body: { startedAt: "2026-03-10T22:30:00Z", durationSec: 7200 },
				});
				const q = `from=2026-03-10&to=2026-03-11&userId=${devId}`;
				const utc = await h.call(
					"GET",
					`/api/work/time/report?${q}&groupBy=day&tz=UTC`,
					asDev(),
				);
				expect(utc.json.rows).toEqual([
					expect.objectContaining({ key: "2026-03-10", seconds: 5400 }),
					expect.objectContaining({ key: "2026-03-11", seconds: 1800 }),
				]);
				const rome = await h.call(
					"GET",
					`/api/work/time/report?${q}&groupBy=day&tz=Europe/Rome`,
					asDev(),
				);
				expect(
					rome.json.rows.map((r: { seconds: number }) => r.seconds),
				).toEqual([1800, 5400]);
				expect(rome.json.totals).toEqual({
					seconds: 7200,
					billableSeconds: 7200,
					entries: 1,
				});
				const byTask = await h.call(
					"GET",
					`/api/work/time/report?${q}&groupBy=task`,
					asDev(),
				);
				expect(byTask.json.rows[0].label).toBe(`SHOP-${t.number} ${t.title}`);
				const csv = await h.call(
					"GET",
					`/api/work/time/report?${q}&groupBy=task&format=csv`,
					asDev(),
				);
				expect(csv.headers.get("content-type")).toContain("text/csv");
				expect(csv.json).toBe(
					`task,hours,billable_hours,entries\r\n"SHOP-${t.number} Fix ""cart"", totals",2.00,2.00,1\r\nTotal,2.00,2.00,1\r\n`,
				);
			});

			test("a timer running over 12 hours notifies once, and keeps running", async () => {
				const t = await task("Long one");
				const [e] = await h.deps.db
					.insert(workTimeEntry)
					.values({
						organizationId: (await h.call("GET", "/api/me", asDev())).json
							.organizationId,
						projectId,
						taskId: t.id,
						userId: devId,
						startedAt: new Date(Date.now() - 13 * 3_600_000),
						source: "timer",
					})
					.returning();
				expect(await notifyLongTimers(h.deps.db)).toBe(1);
				expect(await notifyLongTimers(h.deps.db)).toBe(0);
				const notes = await h.deps.db
					.select()
					.from(workNotification)
					.where(eq(workNotification.userId, devId));
				expect(notes).toHaveLength(1);
				expect(notes[0]?.kind).toBe("timer_running_long");
				const [still] = await h.deps.db
					.select()
					.from(workTimeEntry)
					.where(eq(workTimeEntry.id, e?.id as string));
				expect(still?.endedAt).toBeNull();
			});
		});

		describe("templates", () => {
			test("built-ins are listed once and are read-only", async () => {
				const a = await h.call("GET", "/api/work/templates", asDev());
				const b = await h.call(
					"GET",
					`/api/work/templates?projectId=${projectId}`,
					asDev(),
				);
				const names = (r: typeof a) =>
					r.json
						.filter((t: { builtin: boolean }) => t.builtin)
						.map((t: { name: string }) => t.name);
				expect(names(a)).toEqual([
					"Bug triage",
					"Client onboarding",
					"Website launch",
				]);
				expect(names(b)).toEqual(names(a));
				const id = a.json[0].id;
				expect(
					(await h.call("DELETE", `/api/work/templates/${id}`, asOwner()))
						.status,
				).toBe(403);
			});

			test("Website launch back-schedules to the finish date with placeholders and dependencies", async () => {
				const list = await h.call("GET", "/api/work/templates", asDev());
				const tpl = list.json.find(
					(t: { name: string }) => t.name === "Website launch",
				);
				const before = await h.deps.db.$count(
					workTask,
					eq(workTask.projectId, projectId),
				);
				const dry = await h.call(
					"POST",
					`/api/work/templates/${tpl.id}/instantiate`,
					{
						...asDev(),
						body: {
							target: { listId },
							anchor: { date: "2026-12-04", mode: "finish" },
							placeholders: { Developer: devId },
							dryRun: true,
						},
					},
				);
				expect(dry.status).toBe(200);
				expect(dry.json).toMatchObject({ dryRun: true, created: { tasks: 7 } });
				expect(
					await h.deps.db.$count(workTask, eq(workTask.projectId, projectId)),
				).toBe(before);

				const res = await h.call(
					"POST",
					`/api/work/templates/${tpl.id}/instantiate`,
					{
						...asDev(),
						body: {
							target: { listId },
							anchor: { date: "2026-12-04", mode: "finish" },
							placeholders: { Developer: devId },
						},
					},
				);
				expect(res.status).toBe(200);
				expect(res.json.taskIds).toHaveLength(7);
				expect(res.json.warnings).toContain(
					'Placeholder "Designer" left unassigned',
				);
				const rows = await h.deps.db
					.select()
					.from(workTask)
					.where(eq(workTask.projectId, projectId));
				const launch = rows.find((r) => r.title === "Launch");
				expect(launch).toMatchObject({
					isMilestone: true,
					dueDate: "2026-12-04",
					listId,
				});
				const discovery = rows.find((r) => r.title === "Discovery workshop");
				// 36 working days before Fri 4 Dec.
				expect(discovery?.startDate).toBe("2026-10-15");
				const deps = await h.deps.db
					.select()
					.from(workDependency)
					.where(eq(workDependency.taskId, launch?.id as string));
				expect(deps).toHaveLength(1);
				const again = await h.call(
					"GET",
					`/api/work/templates/${tpl.id}`,
					asDev(),
				);
				expect(again.json.usageCount).toBe(1);
			});

			test("save as template, then instantiate the copy", async () => {
				const parent = await task("Newsletter", {
					startDate: "2026-11-09",
					dueDate: "2026-11-13",
					estimateMinutes: 120,
				});
				await task("Draft", { parentId: parent.id, dueDate: "2026-11-11" });
				const body = {
					name: "Newsletter",
					projectId,
					source: { kind: "task", taskId: parent.id },
					include: {
						subtasks: true,
						checklist: true,
						fieldValues: true,
						assignees: "placeholders",
						attachments: false,
						descriptions: true,
					},
				};
				expect(
					(await h.call("POST", "/api/work/templates", { ...asDev(), body }))
						.status,
				).toBe(403);
				const saved = await h.call("POST", "/api/work/templates", {
					...asOwner(),
					body,
				});
				expect(saved.status).toBe(201);
				expect(saved.json.payload.tasks[0]).toMatchObject({
					title: "Newsletter",
					startOffset: 0,
					dueOffset: 4,
					statusRef: "To do",
					subtasks: [{ title: "Draft", dueOffset: 2 }],
				});
				const made = await h.call(
					"POST",
					`/api/work/templates/${saved.json.id}/instantiate`,
					{
						...asDev(),
						body: {
							target: { listId },
							anchor: { date: "2026-11-16", mode: "start" },
						},
					},
				);
				expect(made.json.created.tasks).toBe(2);
				const [copy, sub] = await h.deps.db
					.select()
					.from(workTask)
					.where(eq(workTask.id, made.json.taskIds[0]))
					.then(async (r) => [
						r[0],
						(
							await h.deps.db
								.select()
								.from(workTask)
								.where(eq(workTask.parentId, made.json.taskIds[0]))
						)[0],
					]);
				expect(copy).toMatchObject({
					startDate: "2026-11-16",
					dueDate: "2026-11-20",
				});
				expect(sub).toMatchObject({ title: "Draft", dueDate: "2026-11-18" });
			});
		});

		describe("recurrence", () => {
			const rule = (
				mode: RecurrenceRule["mode"],
				p: Partial<RecurrenceRule> = {},
			) =>
				({
					freq: "daily",
					interval: 1,
					mode,
					ends: { kind: "never" },
					copy: {
						subtasks: false,
						checklist: true,
						fields: true,
						assignees: true,
						description: true,
					},
					...p,
				}) satisfies RecurrenceRule;

			test("completing twice concurrently creates one next occurrence", async () => {
				const t = await task("Daily standup notes", {
					startDate: "2026-11-10",
					dueDate: "2026-11-10",
					recurrence: rule("on_complete"),
				});
				const complete = () =>
					h.deps.db.transaction(async (tx) => {
						await tx
							.update(workTask)
							.set({ statusId: doneId, completedAt: new Date() })
							.where(eq(workTask.id, t.id));
						return applyRecurrenceOnComplete(
							tx,
							t,
							{ category: "active" },
							{ category: "done" },
							ownerId,
						);
					});
				const ids = (await Promise.all([complete(), complete()])).filter(
					Boolean,
				);
				expect(ids).toHaveLength(1);
				const series = await h.deps.db
					.select()
					.from(workTask)
					.where(eq(workTask.recurrenceSeriesId, t.id));
				expect(series.map((r) => r.dueDate).sort()).toEqual([
					"2026-11-10",
					"2026-11-11",
				]);
				const next = series.find((r) => r.dueDate === "2026-11-11");
				expect(next).toMatchObject({ statusId: todoId, completedAt: null });
				expect(next?.recurrence?.mode).toBe("on_complete");
			});

			const occurrences = async (seriesId: string) =>
				(
					await h.deps.db
						.select({ dueDate: workTask.dueDate })
						.from(workTask)
						.where(eq(workTask.recurrenceSeriesId, seriesId))
				)
					.map((r) => r.dueDate)
					.sort();

			test("completing through PATCH creates exactly one next occurrence", async () => {
				const t = await task("Water the plants", {
					dueDate: "2026-11-12",
					recurrence: rule("on_complete"),
				});
				await h.deps.db
					.update(workTask)
					.set({ recurrenceSeriesId: t.id })
					.where(eq(workTask.id, t.id));
				const res = await h.call("PATCH", `/api/work/tasks/${t.id}`, {
					...asOwner(),
					body: { statusId: doneId },
				});
				expect(res.status).toBe(200);
				// A repeated PATCH to the same status is not a second completion.
				await h.call("PATCH", `/api/work/tasks/${t.id}`, {
					...asOwner(),
					body: { statusId: doneId },
				});
				expect(await occurrences(t.id)).toEqual(["2026-11-12", "2026-11-13"]);
			});

			test("completing through bulk creates exactly one next occurrence", async () => {
				const t = await task("Back up the laptop", {
					dueDate: "2026-11-12",
					recurrence: rule("on_complete"),
				});
				await h.deps.db
					.update(workTask)
					.set({ recurrenceSeriesId: t.id })
					.where(eq(workTask.id, t.id));
				const res = await h.call("POST", "/api/work/tasks/bulk", {
					...asOwner(),
					body: { taskIds: [t.id], set: { statusId: doneId } },
				});
				expect(res.status).toBe(200);
				expect(res.json.errors).toEqual([]);
				expect(await occurrences(t.id)).toEqual(["2026-11-12", "2026-11-13"]);
			});

			test("the on_schedule tick is idempotent across workers", async () => {
				const today = localDate(new Date(), "UTC");
				const t = await task("Weekly report", {
					dueDate: today,
					recurrence: rule("on_schedule", {
						freq: "weekly",
						createDaysBefore: 7,
					}),
				});
				const counts = await Promise.all([
					tickRecurrence(h.deps.db),
					tickRecurrence(h.deps.db),
				]);
				expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
				expect(await tickRecurrence(h.deps.db)).toBe(0);
				const series = await h.deps.db
					.select()
					.from(workTask)
					.where(eq(workTask.recurrenceSeriesId, t.id));
				expect(series.map((r) => r.dueDate).sort()).toEqual([
					today,
					addDays(today, 7),
				]);
			});
		});

		describe("AI assist", () => {
			let taskId: string;
			beforeAll(async () => {
				taskId = (await task("Launch announcement")).id;
				await h.call("PATCH", "/api/instance/settings", {
					...asOwner(),
					body: { allowPrivateHosts: true },
				});
				await h.call("POST", "/api/ai/provider-keys", {
					...asOwner(),
					body: { provider: "custom", label: "Fake", baseUrl: model.url },
				});
				await h.call("PUT", "/api/ai/settings", {
					...asOwner(),
					body: { autoChain: ["custom/tiny"] },
				});
			});

			test("refused without the ai permission", async () => {
				for (const kind of ["summarise", "subtasks", "description"])
					expect(
						(
							await h.call(
								"POST",
								`/api/work/tasks/${taskId}/ai/${kind}`,
								asDev(),
							)
						).status,
					).toBe(403);
			});

			test("drafts through the gateway, writing nothing", async () => {
				const subs = await h.call(
					"POST",
					`/api/work/tasks/${taskId}/ai/subtasks`,
					asOwner(),
				);
				expect(subs.status).toBe(200);
				expect(subs.json.subtasks).toEqual([
					{ title: "Write copy", estimateMinutes: 60 },
					{ title: "Review", estimateMinutes: null },
				]);
				const desc = await h.call(
					"POST",
					`/api/work/tasks/${taskId}/ai/description`,
					asOwner(),
				);
				expect(desc.json.description.type).toBe("doc");
				expect(JSON.stringify(desc.json.description)).toContain("launch date");
				// No comments yet: nothing to summarise.
				expect(
					(
						await h.call(
							"POST",
							`/api/work/tasks/${taskId}/ai/summarise`,
							asOwner(),
						)
					).status,
				).toBe(400);
				expect(
					await h.deps.db.$count(workTask, eq(workTask.parentId, taskId)),
				).toBe(0);
			});
		});
	},
);
