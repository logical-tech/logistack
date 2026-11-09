import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@logistack/contracts";
import {
	workNotification,
	workTaskWatcher,
	workUserPrefs,
} from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { hasDocker } from "./harness.ts";
import { collabFixture, doc } from "./work-collab-fixture.ts";

describe.skipIf(!hasDocker)("work comments, inbox and prefs", () => {
	let f: Awaited<ReturnType<typeof collabFixture>>;
	const events: EventEnvelope[] = [];

	beforeAll(async () => {
		f = await collabFixture("wcol-cm");
		f.h.deps.bus.onEvent((e) => events.push(e));
	}, 120_000);
	afterAll(() => f?.h.close());

	const notes = (userId: string, taskId: string) =>
		f.h.deps.db
			.select()
			.from(workNotification)
			.where(
				and(
					eq(workNotification.userId, userId),
					eq(workNotification.taskId, taskId),
				),
			);

	test("permissions: viewers comment, ops-only members see nothing", async () => {
		const t = await f.task("Perms");
		const path = `/api/work/tasks/${t.id}/comments`;
		const body = { body: doc("hello") };
		expect((await f.h.call("POST", path, { ...f.vic.as, body })).status).toBe(
			201,
		);
		expect((await f.h.call("POST", path, { ...f.ops.as, body })).status).toBe(
			403,
		);
		expect((await f.h.call("GET", path, f.ops.as)).status).toBe(403);
		const list = await f.h.call("GET", path, f.mia.as);
		expect(list.status).toBe(200);
		expect(list.json).toHaveLength(1);
		const id = list.json[0].id;
		// Only the author edits; resolving needs `work`, which a viewer lacks.
		expect(
			(
				await f.h.call("PATCH", `/api/work/comments/${id}`, {
					...f.dev.as,
					body,
				})
			).status,
		).toBe(403);
		expect(
			(await f.h.call("POST", `/api/work/comments/${id}/resolve`, f.vic.as))
				.status,
		).toBe(403);
		const resolved = await f.h.call(
			"POST",
			`/api/work/comments/${id}/resolve`,
			f.dev.as,
		);
		expect(resolved.status).toBe(200);
		expect(resolved.json.resolvedBy).toBe(f.dev.userId);
		// A developer is not a work admin and not the author: no delete.
		expect(
			(await f.h.call("DELETE", `/api/work/comments/${id}`, f.dev.as)).status,
		).toBe(403);
		const del = await f.h.call("DELETE", `/api/work/comments/${id}`, f.mia.as);
		expect(del.status).toBe(200);
		expect(del.json).toMatchObject({ body: null, bodyText: null });
		expect(del.json.deletedAt).not.toBeNull();
		expect(
			(await f.h.call("GET", "/api/work/tasks/tsk_missing/comments", f.mia.as))
				.status,
		).toBe(404);
	});

	test("comments are sanitized and keep plain text", async () => {
		const t = await f.task("Sanitize");
		const res = await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.dev.as,
			body: {
				body: {
					type: "doc",
					content: [
						{ type: "paragraph", content: [{ type: "text", text: "ok" }] },
						{ type: "script", content: [{ type: "text", text: "alert(1)" }] },
						{
							type: "paragraph",
							content: [
								{
									type: "text",
									text: "x",
									marks: [
										{ type: "link", attrs: { href: "javascript:alert(1)" } },
									],
								},
							],
						},
					],
				},
			},
		});
		expect(res.status).toBe(201);
		expect(JSON.stringify(res.json.body)).not.toContain("script");
		expect(JSON.stringify(res.json.body)).not.toContain("javascript");
		expect(res.json.bodyText).toBe("ok\nx");
	});

	test("a mention notifies once, an edit only notifies newly mentioned people", async () => {
		const t = await f.task("Mentions");
		const created = await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.dev.as,
			body: {
				body: doc("hey ", { mention: f.mia.userId }, { mention: f.ops.userId }),
			},
		});
		expect(created.status).toBe(201);
		const mine = await notes(f.mia.userId, t.id);
		expect(mine.map((n) => n.kind)).toEqual(["mentioned"]);
		// Ops cannot read Work: mentioned in the text, never notified.
		expect(await notes(f.ops.userId, t.id)).toEqual([]);
		// The author and the mentioned reader watch the task now.
		const watchers = await f.h.deps.db
			.select({
				userId: workTaskWatcher.userId,
				reason: workTaskWatcher.reason,
			})
			.from(workTaskWatcher)
			.where(eq(workTaskWatcher.taskId, t.id));
		expect(watchers).toEqual(
			expect.arrayContaining([
				{ userId: f.dev.userId, reason: "comment" },
				{ userId: f.mia.userId, reason: "mention" },
			]),
		);
		await f.h.call("PATCH", `/api/work/comments/${created.json.id}`, {
			...f.dev.as,
			body: {
				body: doc("hey ", { mention: f.mia.userId }, " and ", {
					mention: f.vic.userId,
				}),
			},
		});
		expect(await notes(f.mia.userId, t.id)).toHaveLength(1);
		expect((await notes(f.vic.userId, t.id)).map((n) => n.kind)).toEqual([
			"mentioned",
		]);
		const commented = events.filter(
			(e) => e.type === "task.commented" && e.resource.id === t.id,
		);
		await Bun.sleep(100);
		expect(
			events.filter(
				(e) => e.type === "task.commented" && e.resource.id === t.id,
			),
		).toHaveLength(1);
		expect(commented[0]?.payload).toMatchObject({
			projectId: f.projectId,
			actorId: f.dev.userId,
			taskKey: `${f.key}-${t.number}`,
		});
	});

	test("notifications for the same task within 5 minutes bundle into one row", async () => {
		const t = await f.task("Bundle");
		// Mia watches; three comments by Dev in a row give her one inbox row.
		await f.h.deps.db
			.insert(workTaskWatcher)
			.values({ taskId: t.id, userId: f.mia.userId, reason: "manual" });
		for (const text of ["one", "two", "three"])
			await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
				...f.dev.as,
				body: { body: doc(text) },
			});
		const rows = await notes(f.mia.userId, t.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("commented");
		expect(rows[0]?.data).toMatchObject({ count: 3 });
		// A mention upgrades the bundled row's kind.
		await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.dev.as,
			body: { body: doc({ mention: f.mia.userId }) },
		});
		const after = await notes(f.mia.userId, t.id);
		expect(after).toHaveLength(1);
		expect(after[0]?.kind).toBe("mentioned");
		// The author never gets their own notification.
		expect(await notes(f.dev.userId, t.id)).toEqual([]);
	});

	test("replies join the root thread and notify its participants", async () => {
		const t = await f.task("Replies");
		const root = await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.mia.as,
			body: { body: doc("question?") },
		});
		const reply = await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.vic.as,
			body: { body: doc("answer"), parentId: root.json.id },
		});
		const nested = await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.dev.as,
			body: { body: doc("me too"), parentId: reply.json.id },
		});
		expect(nested.json.parentId).toBe(root.json.id);
		expect((await notes(f.vic.userId, t.id)).map((n) => n.kind)).toEqual([
			"replied",
		]);
	});

	test("reactions: a fixed set, one per user and emoji", async () => {
		const t = await f.task("React");
		const c = await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.mia.as,
			body: { body: doc("ship it") },
		});
		const path = `/api/work/comments/${c.json.id}/reactions/${encodeURIComponent("🚀")}`;
		await f.h.call("PUT", path, f.vic.as);
		const twice = await f.h.call("PUT", path, f.vic.as);
		expect(twice.json.reactions).toEqual([
			{ emoji: "🚀", userIds: [f.vic.userId] },
		]);
		expect(
			(
				await f.h.call(
					"PUT",
					`/api/work/comments/${c.json.id}/reactions/x`,
					f.vic.as,
				)
			).status,
		).toBe(400);
		expect((await f.h.call("DELETE", path, f.vic.as)).json.reactions).toEqual(
			[],
		);
	});

	test("inbox lists, pages and marks read", async () => {
		const page = await f.h.call("GET", "/api/work/me/inbox", f.mia.as);
		expect(page.status).toBe(200);
		expect(page.json.unread).toBeGreaterThan(0);
		expect(page.json.items[0]).toMatchObject({
			projectId: f.projectId,
			projectName: "Shop",
		});
		expect(page.json.items[0].taskKey).toStartWith(`${f.key}-`);
		const first = page.json.items[0].id;
		const read = await f.h.call("POST", "/api/work/me/inbox/read", {
			...f.mia.as,
			body: { ids: [first] },
		});
		expect(read.json.updated).toBe(1);
		const unread = await f.h.call(
			"GET",
			"/api/work/me/inbox?unread=1",
			f.mia.as,
		);
		expect(unread.json.items.map((i: { id: string }) => i.id)).not.toContain(
			first,
		);
		await f.h.call("POST", "/api/work/me/inbox/read", {
			...f.mia.as,
			body: { all: true },
		});
		expect(
			(await f.h.call("GET", "/api/work/me/inbox", f.mia.as)).json.unread,
		).toBe(0);
	});

	test("prefs: defaults, email needs instance mail, time zones are checked", async () => {
		const p = await f.h.call("GET", "/api/work/me/prefs", f.dev.as);
		expect(p.json).toMatchObject({
			email: "off",
			emailKinds: ["assigned", "mentioned", "due_soon", "overdue"],
			mailAvailable: false,
			icalEnabled: false,
		});
		expect(
			(
				await f.h.call("PUT", "/api/work/me/prefs", {
					...f.dev.as,
					body: { email: "instant" },
				})
			).status,
		).toBe(409);
		expect(
			(
				await f.h.call("PUT", "/api/work/me/prefs", {
					...f.dev.as,
					body: { timezone: "Mars/Olympus" },
				})
			).status,
		).toBe(400);
		const ok = await f.h.call("PUT", "/api/work/me/prefs", {
			...f.dev.as,
			body: {
				timezone: "Europe/Rome",
				dailyHour: 9,
				emailKinds: ["mentioned"],
			},
		});
		expect(ok.json).toMatchObject({
			timezone: "Europe/Rome",
			dailyHour: 9,
			emailKinds: ["mentioned"],
		});
	});

	test("the calendar feed lists assigned due tasks, by token only", async () => {
		const due = await f.task("Launch, then; party", {
			dueDate: "2099-01-15",
			assignees: [f.dev.userId],
		});
		await f.task("Not mine", {
			dueDate: "2099-01-16",
			assignees: [f.mia.userId],
		});
		const r1 = await f.h.call("POST", "/api/work/me/ical-token", f.dev.as);
		const r2 = await f.h.call("POST", "/api/work/me/ical-token", f.dev.as);
		const path = (url: string) => new URL(url).pathname;
		expect(path(r2.json.url)).toMatch(/^\/ical\/[\w-]+\.ics$/);
		// Rotation kills the old link.
		expect((await f.h.call("GET", path(r1.json.url))).status).toBe(404);
		const feed = await f.h.call("GET", path(r2.json.url));
		expect(feed.status).toBe(200);
		expect(feed.headers.get("content-type")).toContain("text/calendar");
		const text = feed.json as string;
		expect(text).toContain(
			`SUMMARY:${f.key}-${due.number} Launch\\, then\\; party`,
		);
		expect(text).toContain("DTSTART;VALUE=DATE:20990115");
		expect(text).not.toContain("Not mine");
		expect(
			text.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75),
		).toBe(true);
		const [prefs] = await f.h.deps.db
			.select({ hash: workUserPrefs.icalTokenHash })
			.from(workUserPrefs)
			.where(eq(workUserPrefs.userId, f.dev.userId));
		expect(prefs?.hash).toMatch(/^[0-9a-f]{64}$/);
		expect((await f.h.call("GET", "/ical/nope.ics")).status).toBe(404);
	});
});
