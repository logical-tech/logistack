import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	renderDigestEmail,
	renderNotificationEmail,
	signUnsubscribe,
	verifyUnsubscribe,
} from "@logistack/core";
import { workNotification, workUserPrefs } from "@logistack/db";
import type { InstanceMailConfig, MailMessage } from "@logistack/providers";
import {
	processDigest,
	processMail,
	type WorkMailDeps,
	workDueTick,
} from "@logistack/worker/work-mail";
import { and, eq } from "drizzle-orm";
import { runQueues } from "../src/run-queues.ts";
import { mailer } from "../src/work/notify.ts";
import { hasDocker } from "./harness.ts";
import { collabFixture, doc } from "./work-collab-fixture.ts";

describe("email rendering", () => {
	test("a mention with the comment quoted", () => {
		expect(
			renderNotificationEmail({
				kind: "mentioned",
				actorName: "Sara <admin>",
				taskKey: "SHOP-42",
				taskTitle: "Fix the <checkout> & cart",
				projectName: "Shop",
				taskUrl: "https://ls.example.com/work/t/SHOP-42",
				comment: doc("Can you look at ", { mention: "u1" }, "?"),
				unsubscribeUrl: "https://ls.example.com/mail/unsubscribe/abc",
			}),
		).toMatchSnapshot();
	});

	test("a bundle and a due reminder", () => {
		const base = {
			actorName: "Sara",
			taskKey: "SHOP-7",
			taskTitle: "Launch",
			projectName: "Shop",
			taskUrl: "https://ls.example.com/work/t/SHOP-7",
			unsubscribeUrl: "https://ls.example.com/mail/unsubscribe/x",
		};
		expect(
			renderNotificationEmail({ ...base, kind: "commented", count: 3 }).subject,
		).toBe("[Shop] Sara changed 3 things on SHOP-7 Launch");
		expect(
			renderNotificationEmail({ ...base, kind: "overdue", actorName: null })
				.subject,
		).toBe("[Shop] SHOP-7 Launch is overdue");
	});

	test("the daily digest, and none when empty", () => {
		const item = (n: number) => ({
			taskKey: `SHOP-${n}`,
			taskTitle: `Task ${n}`,
			projectName: "Shop",
			url: `https://ls.example.com/work/t/SHOP-${n}`,
		});
		const empty = {
			date: "2026-11-09",
			dueToday: [],
			overdue: [],
			assigned: [],
			mentions: [],
			settingsUrl: "https://ls.example.com/account/notifications",
			unsubscribeUrl: "https://ls.example.com/mail/unsubscribe/d",
		};
		expect(renderDigestEmail(empty)).toBeNull();
		expect(
			renderDigestEmail({
				...empty,
				dueToday: [item(1)],
				overdue: [item(2), item(3)],
			}),
		).toMatchSnapshot();
	});

	test("unsubscribe tokens verify and refuse forgeries", async () => {
		const claim = {
			userId: "u1",
			organizationId: "o1",
			kind: "mentioned" as const,
		};
		const token = await signUnsubscribe(claim, "secret");
		expect(await verifyUnsubscribe(token, "secret")).toEqual(claim);
		expect(await verifyUnsubscribe(token, "other")).toBeNull();
		const [p] = token.split(".");
		const forged = btoa(JSON.stringify(["u2", "o1", "mentioned"]))
			.replace(/=+$/, "")
			.replace(/\+/g, "-")
			.replace(/\//g, "_");
		expect(
			await verifyUnsubscribe(`${forged}.${token.split(".")[1]}`, "secret"),
		).toBeNull();
		expect(await verifyUnsubscribe(`${p}`, "secret")).toBeNull();
	});
});

describe.skipIf(!hasDocker)("instance mail and email delivery", () => {
	let f: Awaited<ReturnType<typeof collabFixture>>;
	const sent: { config: InstanceMailConfig; message: MailMessage }[] = [];
	const events: { type: string; id: string }[] = [];
	const jobs: { name: string; opts: unknown }[] = [];
	let d: WorkMailDeps;

	beforeAll(async () => {
		f = await collabFixture("wcol-ml");
		mailer.send = async (config, message) => {
			sent.push({ config, message });
		};
		d = {
			db: f.h.deps.db,
			masterKey: f.h.deps.masterKey,
			secret: f.h.config.LOGISTACK_MASTER_KEY,
			queue: {
				add: (async (name: string, _data: unknown, opts: unknown) => {
					jobs.push({ name, opts });
				}) as never,
			},
			publishEvent: async (type, _org, resource) => {
				events.push({ type, id: resource.id });
			},
			publishRealtime: async () => {},
			send: async (config, message) => {
				sent.push({ config, message });
			},
		};
	}, 120_000);
	afterAll(() => f?.h.close());

	const smtp = {
		transport: "smtp",
		host: "smtp.example.com",
		port: 587,
		username: "ls",
		password: "hunter2",
		from: "LogiStack <ls@example.com>",
	};

	test("only instance admins manage it; the secret never comes back", async () => {
		expect((await f.h.call("GET", "/api/instance/mail", f.mia.as)).status).toBe(
			403,
		);
		expect(
			(await f.h.call("PUT", "/api/instance/mail", { ...f.mia.as, body: smtp }))
				.status,
		).toBe(403);
		expect(
			(await f.h.call("GET", "/api/instance/mail", f.asOwner)).json.configured,
		).toBe(false);
		const put = await f.h.call("PUT", "/api/instance/mail", {
			...f.asOwner,
			body: smtp,
		});
		expect(put.status).toBe(200);
		expect(put.json).toMatchObject({
			configured: true,
			host: "smtp.example.com",
			hasSecret: true,
		});
		expect(JSON.stringify(put.json)).not.toContain("hunter2");
		// Omitting the password keeps it.
		const { password: _, ...noPassword } = smtp;
		await f.h.call("PUT", "/api/instance/mail", {
			...f.asOwner,
			body: { ...noPassword, host: "mail.example.com" },
		});
		const test = await f.h.call("POST", "/api/instance/mail/test", {
			...f.asOwner,
			body: { to: "ops@example.com" },
		});
		expect(test.json).toEqual({ ok: true, error: null });
		expect(sent.at(-1)?.config).toMatchObject({
			host: "mail.example.com",
			password: "hunter2",
		});
		expect(sent.at(-1)?.message.to).toBe("ops@example.com");
		// Resend without a key and none stored: refused.
		expect(
			(
				await f.h.call("POST", "/api/instance/mail/test", {
					...f.asOwner,
					body: {
						to: "a@example.com",
						config: { transport: "resend", from: "a@example.com" },
					},
				})
			).status,
		).toBe(400);
	});

	test("invitations are emailed once instance mail is set up", async () => {
		const before = sent.length;
		const invite = await f.h.call("POST", "/api/invitations", {
			...f.asOwner,
			body: { email: "newbie@example.com", role: "viewer" },
		});
		expect(invite.status).toBe(201);
		const mail = sent
			.slice(before)
			.find((s) => s.message.to === "newbie@example.com");
		expect(mail?.message.text).toContain(invite.json.url);
	});

	test("instant email: queued 2 minutes out, sent once, cancelled by reading", async () => {
		const put = await f.h.call("PUT", "/api/work/me/prefs", {
			...f.mia.as,
			body: { email: "instant" },
		});
		expect(put.status).toBe(200);
		const t = await f.task("Instant");
		await f.h.call("POST", `/api/work/tasks/${t.id}/comments`, {
			...f.dev.as,
			body: { body: doc("look ", { mention: f.mia.userId }) },
		});
		const [n] = await f.h.deps.db
			.select()
			.from(workNotification)
			.where(
				and(
					eq(workNotification.userId, f.mia.userId),
					eq(workNotification.taskId, t.id),
				),
			);
		const job = await runQueues(f.h.config.REDIS_URL).work.getJob(
			`mail-${n?.id}`,
		);
		expect(job?.opts.delay).toBe(120_000);
		const before = sent.length;
		expect(await processMail(d, n?.id as string)).toBe(true);
		expect(await processMail(d, n?.id as string)).toBe(false);
		const mail = sent.slice(before);
		expect(mail).toHaveLength(1);
		expect(mail[0]?.message).toMatchObject({ to: f.mia.email });
		expect(mail[0]?.message.subject).toBe(
			`[Shop] Dev mentioned you on ${f.key}-${t.number} Instant`,
		);
		expect(mail[0]?.message.headers?.["List-Unsubscribe"]).toContain(
			"/mail/unsubscribe/",
		);
		// Read in the app before the delay: nothing goes out.
		const t2 = await f.task("Read first");
		await f.h.call("POST", `/api/work/tasks/${t2.id}/comments`, {
			...f.dev.as,
			body: { body: doc({ mention: f.mia.userId }) },
		});
		const [n2] = await f.h.deps.db
			.select()
			.from(workNotification)
			.where(
				and(
					eq(workNotification.userId, f.mia.userId),
					eq(workNotification.taskId, t2.id),
				),
			);
		await f.h.call("POST", "/api/work/me/inbox/read", {
			...f.mia.as,
			body: { ids: [n2?.id] },
		});
		expect(await processMail(d, n2?.id as string)).toBe(false);
	});

	test("unsubscribe links drop one kind", async () => {
		const token = await signUnsubscribe(
			{ userId: f.mia.userId, organizationId: f.orgId, kind: "mentioned" },
			f.h.config.LOGISTACK_MASTER_KEY,
		);
		expect((await f.h.call("GET", `/mail/unsubscribe/${token}`)).status).toBe(
			200,
		);
		expect((await f.h.call("POST", `/mail/unsubscribe/${token}`)).status).toBe(
			200,
		);
		const p = await f.h.call("GET", "/api/work/me/prefs", f.mia.as);
		expect(p.json.emailKinds).not.toContain("mentioned");
		expect(
			(await f.h.call("POST", "/mail/unsubscribe/forged.token")).status,
		).toBe(404);
	});

	test("the due tick fires due_soon and overdue once, however often it runs", async () => {
		const now = new Date("2026-11-09T12:00:00Z");
		await f.h.deps.db
			.insert(workUserPrefs)
			.values({
				userId: f.vic.userId,
				organizationId: f.orgId,
				dailyHour: 8,
				timezone: "UTC",
			})
			.onConflictDoUpdate({
				target: [workUserPrefs.userId, workUserPrefs.organizationId],
				set: { dailyHour: 8, timezone: "UTC" },
			});
		const today = await f.task("Due today", {
			dueDate: "2026-11-09",
			assignees: [f.vic.userId],
		});
		const late = await f.task("Due yesterday", {
			dueDate: "2026-11-08",
			assignees: [f.vic.userId],
		});
		const timed = await f.task("Due tomorrow 10:00", {
			dueDate: "2026-11-10",
			dueTime: "10:00",
			assignees: [f.vic.userId],
		});
		const later = await f.task("Next week", {
			dueDate: "2026-11-16",
			assignees: [f.vic.userId],
		});
		const ancient = await f.task("Ancient", {
			dueDate: "2026-10-01",
			assignees: [f.vic.userId],
		});
		await workDueTick(d, now);
		await workDueTick(d, now);
		await workDueTick(d, new Date(now.getTime() + 3_600_000));
		const rows = await f.h.deps.db
			.select({ taskId: workNotification.taskId, kind: workNotification.kind })
			.from(workNotification)
			.where(eq(workNotification.userId, f.vic.userId));
		const of = (id: string) =>
			rows.filter((r) => r.taskId === id).map((r) => r.kind);
		expect(of(today.id)).toEqual(["due_soon"]);
		expect(of(late.id)).toEqual(["overdue"]);
		expect(of(timed.id)).toEqual(["due_soon"]);
		expect(of(later.id)).toEqual([]);
		expect(of(ancient.id)).toEqual([]);
		expect(events.filter((e) => e.id === late.id)).toEqual([
			{ type: "task.overdue", id: late.id },
		]);
		expect(events.filter((e) => e.id === today.id)).toEqual([
			{ type: "task.due_soon", id: today.id },
		]);
	});

	test("the daily digest is queued at the user's hour and lists their tasks", async () => {
		await f.h.deps.db
			.update(workUserPrefs)
			.set({ email: "daily", dailyHour: 7, timezone: "Europe/Rome" })
			.where(eq(workUserPrefs.userId, f.vic.userId));
		jobs.length = 0;
		// 06:00 UTC is 07:00 in Rome.
		await workDueTick(d, new Date("2026-11-09T06:00:00Z"));
		expect(jobs.filter((j) => j.name === "digest")).toHaveLength(1);
		expect(jobs.find((j) => j.name === "digest")?.opts).toMatchObject({
			jobId: `digest-${f.vic.userId}-${f.orgId}-2026-11-09`,
		});
		const before = sent.length;
		expect(
			await processDigest(d, {
				userId: f.vic.userId,
				organizationId: f.orgId,
				date: "2026-11-09",
			}),
		).toBe(true);
		const mail = sent.slice(before)[0]?.message;
		expect(mail?.to).toBe(f.vic.email);
		expect(mail?.text).toContain("Due today");
		expect(mail?.text).toContain("Overdue");
	});
});
