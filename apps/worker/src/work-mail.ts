import type { EventType, WorkNotificationKind } from "@logistack/contracts";
import {
	addDays,
	decrypt,
	localDate,
	renderDigestEmail,
	renderNotificationEmail,
	signUnsubscribe,
	zonedMidnight,
} from "@logistack/core";
import {
	type Db,
	instanceSettings,
	project,
	user,
	workComment,
	workNotification,
	workProject,
	workStatus,
	workTask,
	workTaskAssignee,
	workUserPrefs,
} from "@logistack/db";
import {
	type InstanceMailConfig,
	instanceMailConfig,
	type MailMessage,
	sendMail,
} from "@logistack/providers";
import type { Queue } from "bullmq";
import {
	and,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	notInArray,
} from "drizzle-orm";

/**
 * Work notifications outside the request path (plan 14.2, 14.3): the hourly `work-due` tick,
 * instant emails (a delayed job per notification, cancelled by reading it) and the daily digest.
 * The api imports the loaders and `queueInstantMails` from here.
 */

export const WORK_QUEUE = "work";
/** Same channel as apps/server/src/work/context.ts. */
export const WORK_CHANNEL = "ls:work";
/** Lets bundling and read-in-app cancel an email before it goes. */
export const INSTANT_MAIL_DELAY_MS = 2 * 60_000;

export type WorkJob =
	| { name: "mail"; notificationId: string }
	| { name: "digest"; userId: string; organizationId: string; date: string }
	| { name: "migrate-blobs"; organizationId: string };

export type WorkMailDeps = {
	db: Db;
	masterKey: CryptoKey;
	/** HMAC secret of unsubscribe links (the master key string; the api verifies with the same). */
	secret: string;
	queue: Pick<Queue, "add">;
	publishEvent(
		type: EventType,
		organizationId: string,
		resource: { type: string; id: string },
		payload: Record<string, unknown>,
	): Promise<void>;
	publishRealtime(message: Record<string, unknown>): Promise<void>;
	/** Tests capture messages here. */
	send?: (config: InstanceMailConfig, message: MailMessage) => Promise<void>;
};

export async function loadInstanceMail(
	db: Db,
	masterKey: CryptoKey,
): Promise<InstanceMailConfig | null> {
	const [row] = await db
		.select({ mail: instanceSettings.mailEncrypted })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	if (!row?.mail) return null;
	const parsed = instanceMailConfig.safeParse(
		JSON.parse(await decrypt(masterKey, row.mail)),
	);
	return parsed.success ? parsed.data : null;
}

/** Links in emails and feeds: the instance's public URL, else `fallback`. */
export async function workBaseUrl(db: Db, fallback = "http://localhost") {
	const [row] = await db
		.select({ url: instanceSettings.publicUrl })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return (row?.url ?? fallback).replace(/\/+$/, "");
}

export const taskUrl = (base: string, key: string, number: number) =>
	`${base}/work/t/${key}-${number}`;

export async function unsubscribeUrl(
	base: string,
	secret: string,
	claim: Parameters<typeof signUnsubscribe>[0],
) {
	return `${base}/mail/unsubscribe/${await signUnsubscribe(claim, secret)}`;
}

/**
 * Queues a delayed email for each notification whose user wants instant email of its kind.
 * The job id is the notification's, so a bundled update never queues a second one.
 */
export async function queueInstantMails(
	db: Db,
	queue: Pick<Queue, "add">,
	notes: {
		id: string;
		userId: string;
		organizationId: string;
		kind: WorkNotificationKind;
	}[],
) {
	if (notes.length === 0) return;
	const prefs = await db
		.select()
		.from(workUserPrefs)
		.where(
			and(
				inArray(workUserPrefs.userId, [...new Set(notes.map((n) => n.userId))]),
				eq(workUserPrefs.email, "instant"),
			),
		);
	for (const n of notes) {
		const p = prefs.find(
			(p) => p.userId === n.userId && p.organizationId === n.organizationId,
		);
		if (!p?.emailKinds.includes(n.kind)) continue;
		await queue.add(
			"mail",
			{ name: "mail", notificationId: n.id },
			{
				jobId: `mail-${n.id}`,
				delay: INSTANT_MAIL_DELAY_MS,
				attempts: 3,
				backoff: { type: "exponential", delay: 30_000 },
				removeOnComplete: true,
				removeOnFail: { count: 500 },
			},
		);
	}
}

/** Sends one instant email; a no-op once the notification is read, emailed or opted out of. */
export async function processMail(d: WorkMailDeps, notificationId: string) {
	const [n] = await d.db
		.select({
			id: workNotification.id,
			userId: workNotification.userId,
			organizationId: workNotification.organizationId,
			kind: workNotification.kind,
			data: workNotification.data,
			readAt: workNotification.readAt,
			emailedAt: workNotification.emailedAt,
			actorId: workNotification.actorId,
			commentId: workNotification.commentId,
			email: user.email,
			number: workTask.number,
			title: workTask.title,
			key: workProject.key,
			projectName: project.name,
		})
		.from(workNotification)
		.innerJoin(user, eq(user.id, workNotification.userId))
		.innerJoin(workTask, eq(workTask.id, workNotification.taskId))
		.innerJoin(project, eq(project.id, workTask.projectId))
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
		.where(eq(workNotification.id, notificationId));
	if (!n || n.readAt || n.emailedAt) return false;
	const [p] = await d.db
		.select()
		.from(workUserPrefs)
		.where(
			and(
				eq(workUserPrefs.userId, n.userId),
				eq(workUserPrefs.organizationId, n.organizationId),
			),
		);
	if (p?.email !== "instant" || !p.emailKinds.includes(n.kind)) return false;
	const config = await loadInstanceMail(d.db, d.masterKey);
	if (!config) return false;
	const [actor] = n.actorId
		? await d.db
				.select({ name: user.name })
				.from(user)
				.where(eq(user.id, n.actorId))
		: [];
	const [comment] = n.commentId
		? await d.db
				.select({ body: workComment.body })
				.from(workComment)
				.where(eq(workComment.id, n.commentId))
		: [];
	const base = await workBaseUrl(d.db);
	const unsubscribe = await unsubscribeUrl(base, d.secret, {
		userId: n.userId,
		organizationId: n.organizationId,
		kind: n.kind,
	});
	const mail = renderNotificationEmail({
		kind: n.kind,
		actorName: actor?.name ?? null,
		taskKey: `${n.key}-${n.number}`,
		taskTitle: n.title,
		projectName: n.projectName,
		taskUrl: taskUrl(base, n.key, n.number),
		count: Number((n.data as { count?: number }).count ?? 1),
		comment: comment?.body ?? null,
		baseUrl: base,
		unsubscribeUrl: unsubscribe,
	});
	// Claimed first: a retry after a send that did go through must not send twice.
	const [claimed] = await d.db
		.update(workNotification)
		.set({ emailedAt: new Date() })
		.where(
			and(
				eq(workNotification.id, n.id),
				isNull(workNotification.emailedAt),
				isNull(workNotification.readAt),
			),
		)
		.returning({ id: workNotification.id });
	if (!claimed) return false;
	try {
		await (d.send ?? sendMail)(config, {
			to: n.email,
			...mail,
			headers: { "List-Unsubscribe": `<${unsubscribe}>` },
		});
	} catch (err) {
		await d.db
			.update(workNotification)
			.set({ emailedAt: null })
			.where(eq(workNotification.id, n.id));
		throw err;
	}
	return true;
}

const OPEN = ["done", "cancelled"] as const;

async function openTasksOf(
	db: Db,
	userId: string,
	organizationId: string,
	due: ReturnType<typeof eq>,
) {
	return db
		.select({
			taskId: workTask.id,
			number: workTask.number,
			title: workTask.title,
			key: workProject.key,
			projectName: project.name,
		})
		.from(workTask)
		.innerJoin(workTaskAssignee, eq(workTaskAssignee.taskId, workTask.id))
		.innerJoin(workStatus, eq(workStatus.id, workTask.statusId))
		.innerJoin(project, eq(project.id, workTask.projectId))
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
		.where(
			and(
				eq(workTaskAssignee.userId, userId),
				eq(project.organizationId, organizationId),
				isNull(workTask.archivedAt),
				notInArray(workStatus.category, [...OPEN]),
				due,
			),
		)
		.orderBy(workTask.dueDate, workTask.number)
		.limit(50);
}

/** The daily digest of one user for their local `date`; skipped when empty. */
export async function processDigest(
	d: WorkMailDeps,
	job: { userId: string; organizationId: string; date: string },
) {
	const [p] = await d.db
		.select({ email: workUserPrefs.email, address: user.email })
		.from(workUserPrefs)
		.innerJoin(user, eq(user.id, workUserPrefs.userId))
		.where(
			and(
				eq(workUserPrefs.userId, job.userId),
				eq(workUserPrefs.organizationId, job.organizationId),
			),
		);
	if (p?.email !== "daily") return false;
	const config = await loadInstanceMail(d.db, d.masterKey);
	if (!config) return false;
	const base = await workBaseUrl(d.db);
	const item = (r: {
		key: string;
		number: number;
		title: string;
		projectName: string;
	}) => ({
		taskKey: `${r.key}-${r.number}`,
		taskTitle: r.title,
		projectName: r.projectName,
		url: taskUrl(base, r.key, r.number),
	});
	const since = new Date(Date.now() - 86_400_000);
	const recent = await d.db
		.select({
			id: workNotification.id,
			kind: workNotification.kind,
			taskId: workNotification.taskId,
			number: workTask.number,
			title: workTask.title,
			key: workProject.key,
			projectName: project.name,
		})
		.from(workNotification)
		.innerJoin(workTask, eq(workTask.id, workNotification.taskId))
		.innerJoin(project, eq(project.id, workTask.projectId))
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
		.where(
			and(
				eq(workNotification.userId, job.userId),
				eq(workNotification.organizationId, job.organizationId),
				inArray(workNotification.kind, ["assigned", "mentioned"]),
				gte(workNotification.createdAt, since),
			),
		);
	const unique = (rows: typeof recent) =>
		[...new Map(rows.map((r) => [r.taskId, r])).values()].map(item);
	const mail = renderDigestEmail({
		date: job.date,
		dueToday: (
			await openTasksOf(
				d.db,
				job.userId,
				job.organizationId,
				eq(workTask.dueDate, job.date),
			)
		).map(item),
		overdue: (
			await openTasksOf(
				d.db,
				job.userId,
				job.organizationId,
				lt(workTask.dueDate, job.date) as ReturnType<typeof eq>,
			)
		).map(item),
		assigned: unique(recent.filter((r) => r.kind === "assigned")),
		mentions: unique(recent.filter((r) => r.kind === "mentioned")),
		settingsUrl: `${base}/account/notifications`,
		unsubscribeUrl: await unsubscribeUrl(base, d.secret, {
			userId: job.userId,
			organizationId: job.organizationId,
			kind: "digest",
		}),
	});
	if (!mail) return false;
	await (d.send ?? sendMail)(config, { to: p.address, ...mail });
	if (recent.length)
		await d.db
			.update(workNotification)
			.set({ emailedAt: new Date() })
			.where(
				and(
					inArray(
						workNotification.id,
						recent.map((r) => r.id),
					),
					isNull(workNotification.emailedAt),
				),
			);
	return true;
}

/** Whole hours since local midnight in `tz` (off by one on DST days, which only shifts a send). */
const localHour = (now: Date, tz: string) =>
	Math.floor(
		(now.getTime() - zonedMidnight(localDate(now, tz), tz).getTime()) /
			3_600_000,
	);

const safeTz = (tz: string | null) => {
	if (!tz) return "UTC";
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz });
		return tz;
	} catch {
		return "UTC";
	}
};

/** Overdue notices stop this many days after the due date, so old backlogs never flood an inbox. */
const OVERDUE_WINDOW_DAYS = 7;

/**
 * `work-due` (hourly): due_soon 24 h before a timed due (or the morning of a date-only one, at
 * the user's `dailyHour`), overdue the morning after. The unique index on
 * `(userId, taskId, kind, dueDate)` makes each fire once whatever the number of workers or runs.
 * It also queues the daily digests whose hour has come.
 */
export async function workDueTick(d: WorkMailDeps, now = new Date()) {
	const today = now.toISOString().slice(0, 10);
	const rows = await d.db
		.select({
			taskId: workTask.id,
			projectId: workTask.projectId,
			organizationId: project.organizationId,
			number: workTask.number,
			title: workTask.title,
			key: workProject.key,
			dueDate: workTask.dueDate,
			dueTime: workTask.dueTime,
			userId: workTaskAssignee.userId,
			tz: workUserPrefs.timezone,
			dailyHour: workUserPrefs.dailyHour,
		})
		.from(workTask)
		.innerJoin(workTaskAssignee, eq(workTaskAssignee.taskId, workTask.id))
		.innerJoin(workStatus, eq(workStatus.id, workTask.statusId))
		.innerJoin(project, eq(project.id, workTask.projectId))
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
		.leftJoin(
			workUserPrefs,
			and(
				eq(workUserPrefs.userId, workTaskAssignee.userId),
				eq(workUserPrefs.organizationId, project.organizationId),
			),
		)
		.where(
			and(
				isNull(workTask.archivedAt),
				notInArray(workStatus.category, [...OPEN]),
				gte(workTask.dueDate, addDays(today, -(OVERDUE_WINDOW_DAYS + 1))),
				lte(workTask.dueDate, addDays(today, 2)),
			),
		);
	const values: (typeof workNotification.$inferInsert)[] = [];
	for (const r of rows) {
		if (!r.dueDate) continue;
		const tz = safeTz(r.tz);
		const local = localDate(now, tz);
		const morning = localHour(now, tz) >= (r.dailyHour ?? 8);
		let kind: "due_soon" | "overdue" | null = null;
		if (local > r.dueDate) {
			if (
				(morning || local > addDays(r.dueDate, 1)) &&
				local <= addDays(r.dueDate, OVERDUE_WINDOW_DAYS)
			)
				kind = "overdue";
		} else if (r.dueTime) {
			const [h = 0, m = 0] = r.dueTime.split(":").map(Number);
			const at = zonedMidnight(r.dueDate, tz).getTime() + (h * 60 + m) * 60_000;
			if (now.getTime() < at && now.getTime() >= at - 86_400_000)
				kind = "due_soon";
		} else if (local === r.dueDate && morning) kind = "due_soon";
		if (!kind) continue;
		values.push({
			userId: r.userId,
			organizationId: r.organizationId,
			taskId: r.taskId,
			kind,
			dueDate: r.dueDate,
		});
	}
	const inserted = values.length
		? await d.db
				.insert(workNotification)
				.values(values)
				.onConflictDoNothing()
				.returning({
					id: workNotification.id,
					userId: workNotification.userId,
					organizationId: workNotification.organizationId,
					taskId: workNotification.taskId,
					kind: workNotification.kind,
				})
		: [];
	const base = inserted.length ? await workBaseUrl(d.db) : "";
	const fired = new Set<string>();
	for (const n of inserted) {
		const r = rows.find((r) => r.taskId === n.taskId);
		if (!r) continue;
		await d
			.publishRealtime({
				type: "work",
				organizationId: n.organizationId,
				projectId: r.projectId,
				taskIds: [n.taskId],
				entity: "notification",
				op: "upsert",
				userId: n.userId,
				actorId: null,
			})
			.catch(() => {});
		if (fired.has(`${n.kind}:${n.taskId}`)) continue;
		fired.add(`${n.kind}:${n.taskId}`);
		await d
			.publishEvent(
				n.kind === "overdue" ? "task.overdue" : "task.due_soon",
				n.organizationId,
				{ type: "task", id: n.taskId },
				{
					projectId: r.projectId,
					taskKey: `${r.key}-${r.number}`,
					title: r.title,
					actorId: null,
					assigneeIds: rows
						.filter((x) => x.taskId === n.taskId)
						.map((x) => x.userId),
					url: taskUrl(base, r.key, r.number),
				},
			)
			.catch(() => {});
	}
	await queueInstantMails(d.db, d.queue, inserted);
	const digests = await queueDigests(d, now);
	return { notified: inserted.length, digests };
}

async function queueDigests(d: WorkMailDeps, now: Date) {
	const daily = await d.db
		.select({
			userId: workUserPrefs.userId,
			organizationId: workUserPrefs.organizationId,
			tz: workUserPrefs.timezone,
			dailyHour: workUserPrefs.dailyHour,
		})
		.from(workUserPrefs)
		.where(eq(workUserPrefs.email, "daily"));
	let queued = 0;
	for (const p of daily) {
		const tz = safeTz(p.tz);
		if (localHour(now, tz) !== p.dailyHour) continue;
		const date = localDate(now, tz);
		await d.queue.add(
			"digest",
			{
				name: "digest",
				userId: p.userId,
				organizationId: p.organizationId,
				date,
			},
			{
				// One per user and day, however many ticks see the hour.
				jobId: `digest-${p.userId}-${p.organizationId}-${date}`,
				attempts: 3,
				backoff: { type: "exponential", delay: 60_000 },
				removeOnComplete: { age: 2 * 86_400 },
				removeOnFail: { age: 2 * 86_400 },
			},
		);
		queued++;
	}
	return queued;
}
