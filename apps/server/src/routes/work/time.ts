import { z } from "@hono/zod-openapi";
import {
	WorkTimeEntry,
	WorkTimeEntryCreate,
	WorkTimeEntryPatch,
	WorkTimeReport,
	WorkTimeReportQuery,
	WorkTimer,
	WorkTimerStart,
} from "@logistack/contracts";
import {
	addDays,
	daysBetween,
	localDate,
	overlaps,
	rollupTime,
	zonedMidnight,
} from "@logistack/core";
import {
	type Db,
	project,
	user,
	workProject,
	workTask,
	workTimeEntry,
	workUserPrefs,
} from "@logistack/db";
import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../../actor.ts";
import type { Env } from "../../env.ts";
import { Failure, notFound } from "../../errors.ts";
import { body, errors, IdParam, json, router } from "../../openapi.ts";
import { actorCan, locate } from "../../scope.ts";
import { checkWork, type DbOrTx, publishWork } from "../../work/context.ts";
import { mutationSpec, spec } from "./extras-a-spec.ts";

type EntryRow = typeof workTimeEntry.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The task with what time routes need from its project; 404 outside the actor's organization. */
async function taskOf(db: DbOrTx, organizationId: string, taskId: string) {
	const [row] = await db
		.select({
			id: workTask.id,
			projectId: workTask.projectId,
			number: workTask.number,
			title: workTask.title,
			key: workProject.key,
			timeTracking: workProject.timeTracking,
			timeLockedBefore: workProject.timeLockedBefore,
		})
		.from(workTask)
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
		.where(
			and(
				eq(workTask.id, taskId),
				eq(workProject.organizationId, organizationId),
			),
		);
	if (!row) throw notFound("task");
	return row;
}

const isLocked = (startedAt: Date, lockedBefore: string | null) =>
	!!lockedBefore && localDate(startedAt, "UTC") < lockedBefore;

/** Entries as DTOs, with the task key/title and the lock flag. */
async function toDtos(db: DbOrTx, rows: EntryRow[]): Promise<WorkTimeEntry[]> {
	if (!rows.length) return [];
	const tasks = await db
		.select({
			id: workTask.id,
			number: workTask.number,
			title: workTask.title,
			key: workProject.key,
			lockedBefore: workProject.timeLockedBefore,
		})
		.from(workTask)
		.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
		.where(inArray(workTask.id, [...new Set(rows.map((r) => r.taskId))]));
	const byId = new Map(tasks.map((t) => [t.id, t]));
	return rows.map((r) => {
		const t = byId.get(r.taskId);
		return {
			id: r.id,
			projectId: r.projectId,
			taskId: r.taskId,
			taskKey: t ? `${t.key}-${t.number}` : "",
			taskTitle: t?.title ?? "",
			userId: r.userId,
			startedAt: r.startedAt.toISOString(),
			endedAt: r.endedAt?.toISOString() ?? null,
			durationSec: r.durationSec,
			note: r.note,
			billable: r.billable,
			source: r.source,
			locked: isLocked(r.startedAt, t?.lockedBefore ?? null),
			createdAt: r.createdAt.toISOString(),
		};
	});
}

const dto = async (db: DbOrTx, row: EntryRow) =>
	(await toDtos(db, [row]))[0] as WorkTimeEntry;

/** Serializes one user's timer and entry writes. */
const lockUser = (tx: Tx, userId: string) =>
	tx.execute(
		sql`select pg_advisory_xact_lock(hashtext('work-time'), hashtext(${userId}))`,
	);

/** Stops the user's running timer, if any; returns the stopped row. */
async function stopRunning(tx: Tx, userId: string, now: Date) {
	const [row] = await tx
		.update(workTimeEntry)
		.set({
			endedAt: now,
			durationSec: sql`greatest(0, round(extract(epoch from ${now.toISOString()}::timestamptz - ${workTimeEntry.startedAt})))::int`,
			updatedAt: now,
		})
		.where(and(eq(workTimeEntry.userId, userId), isNull(workTimeEntry.endedAt)))
		.returning();
	return row ?? null;
}

/** 409 with the clashing entry when [start, end) overlaps another entry of the same user. */
async function assertNoOverlap(
	tx: Tx,
	userId: string,
	candidate: { id: string; startedAt: Date; endedAt: Date | null },
	now: Date,
) {
	const end = candidate.endedAt ?? now;
	const near = await tx
		.select()
		.from(workTimeEntry)
		.where(
			and(
				eq(workTimeEntry.userId, userId),
				ne(workTimeEntry.id, candidate.id),
				lt(workTimeEntry.startedAt, end),
				sql`coalesce(${workTimeEntry.endedAt}, ${now.toISOString()}::timestamptz) > ${candidate.startedAt.toISOString()}::timestamptz`,
			),
		)
		.limit(5);
	const clash = overlaps(near, { ...candidate, userId }, now);
	if (clash)
		throw new Failure("conflict", "overlaps another time entry", {
			entry: await dto(tx, clash as EntryRow),
		});
}

/** Own entries need `work`; anyone else's `work:admin`. Locked entries are read-only. */
async function editable(c: Context<Env>, id: string) {
	const actor = requireActor(c);
	const { db } = c.var.deps;
	const [row] = await db
		.select({
			entry: workTimeEntry,
			lockedBefore: workProject.timeLockedBefore,
		})
		.from(workTimeEntry)
		.innerJoin(workProject, eq(workProject.projectId, workTimeEntry.projectId))
		.where(
			and(
				eq(workTimeEntry.id, id),
				eq(workTimeEntry.organizationId, actor.organizationId),
			),
		);
	if (!row) throw notFound("time entry");
	await checkWork(
		c,
		row.entry.userId === actor.userId ? "work" : "work:admin",
		row.entry.projectId,
	);
	if (isLocked(row.entry.startedAt, row.lockedBefore))
		throw new Failure(
			"forbidden",
			`time before ${row.lockedBefore} is locked for this project`,
		);
	return { entry: row.entry, lockedBefore: row.lockedBefore };
}

const publishTime = (
	c: Context<Env>,
	e: { projectId: string; taskId: string },
) =>
	publishWork(c.var.deps, {
		organizationId: requireActor(c).organizationId,
		projectId: e.projectId,
		entity: "time",
		op: "upsert",
		taskIds: [e.taskId],
		actorId: requireActor(c).userId,
	});

/** RFC 4180 field; a leading `= + - @` is defused so spreadsheets never run it as a formula. */
export function csvField(v: string | number): string {
	let s = String(v);
	if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const hours = (sec: number) => (sec / 3600).toFixed(2);

async function reportTz(
	db: Db,
	userId: string,
	organizationId: string,
	tz?: string,
) {
	const pick =
		tz ??
		(
			await db
				.select({ tz: workUserPrefs.timezone })
				.from(workUserPrefs)
				.where(
					and(
						eq(workUserPrefs.userId, userId),
						eq(workUserPrefs.organizationId, organizationId),
					),
				)
		)[0]?.tz ??
		"UTC";
	try {
		new Intl.DateTimeFormat("en", { timeZone: pick });
		return pick;
	} catch {
		throw new Failure("bad_request", `unknown time zone '${pick}'`);
	}
}

export const workTime = router()
	.openapi(
		mutationSpec("work_time.timer_start", "timerStart", {
			summary: "Start a timer on a task (stops the running one)",
			request: { params: IdParam },
			responses: { 200: json(WorkTimerStart, "Started"), ...errors },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const task = await taskOf(db, actor.organizationId, id);
			await checkWork(c, "work", task.projectId);
			if (!task.timeTracking)
				throw new Failure(
					"bad_request",
					"time tracking is off for this project",
				);
			const now = new Date();
			const { started, stopped } = await db.transaction(async (tx) => {
				await lockUser(tx, actor.userId);
				const stopped = await stopRunning(tx, actor.userId, now);
				const [started] = await tx
					.insert(workTimeEntry)
					.values({
						organizationId: actor.organizationId,
						projectId: task.projectId,
						taskId: task.id,
						userId: actor.userId,
						startedAt: now,
						source: "timer",
					})
					.returning();
				return { started: started as EntryRow, stopped };
			});
			c.set("auditResourceId", started.id);
			publishTime(c, started);
			if (stopped) publishTime(c, stopped);
			return c.json(
				{
					started: await dto(db, started),
					stopped: stopped ? await dto(db, stopped) : null,
				},
				200,
			);
		},
	)
	.openapi(
		mutationSpec("work_time.timer_stop", "timerStop", {
			summary: "Stop the caller's running timer",
			responses: { 200: json(WorkTimer, "Stopped"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const [running] = await db
				.select()
				.from(workTimeEntry)
				.where(
					and(
						eq(workTimeEntry.userId, actor.userId),
						eq(workTimeEntry.organizationId, actor.organizationId),
						isNull(workTimeEntry.endedAt),
					),
				);
			if (running) {
				await checkWork(c, "work", running.projectId);
				const stopped = await db.transaction(async (tx) => {
					await lockUser(tx, actor.userId);
					return stopRunning(tx, actor.userId, new Date());
				});
				if (stopped) {
					c.set("auditResourceId", stopped.id);
					publishTime(c, stopped);
				}
			}
			return c.json({ running: null }, 200);
		},
	)
	.openapi(
		spec("timerGet", {
			summary: "The caller's running timer",
			responses: { 200: json(WorkTimer, "Running timer or null"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const [running] = await db
				.select()
				.from(workTimeEntry)
				.where(
					and(
						eq(workTimeEntry.userId, actor.userId),
						eq(workTimeEntry.organizationId, actor.organizationId),
						isNull(workTimeEntry.endedAt),
					),
				);
			if (!running) return c.json({ running: null }, 200);
			await checkWork(c, "read:work", running.projectId);
			return c.json({ running: await dto(db, running) }, 200);
		},
	)
	.openapi(
		spec("timeList", {
			summary: "Time entries on a task, newest first",
			request: { params: IdParam },
			responses: { 200: json(z.array(WorkTimeEntry), "Entries"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const task = await taskOf(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			await checkWork(c, "read:work", task.projectId);
			const rows = await db
				.select()
				.from(workTimeEntry)
				.where(eq(workTimeEntry.taskId, task.id))
				.orderBy(desc(workTimeEntry.startedAt));
			return c.json(await toDtos(db, rows), 200);
		},
	)
	.openapi(
		mutationSpec("work_time.create", "timeCreate", {
			summary: "Add time by hand",
			request: { params: IdParam, ...body(WorkTimeEntryCreate) },
			responses: { 201: json(WorkTimeEntry, "Created"), ...errors },
		}),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const task = await taskOf(
				db,
				actor.organizationId,
				c.req.valid("param").id,
			);
			await checkWork(c, "work", task.projectId);
			if (!task.timeTracking)
				throw new Failure(
					"bad_request",
					"time tracking is off for this project",
				);
			const startedAt = new Date(input.startedAt);
			if (isLocked(startedAt, task.timeLockedBefore))
				throw new Failure(
					"forbidden",
					`time before ${task.timeLockedBefore} is locked for this project`,
				);
			const endedAt = new Date(startedAt.getTime() + input.durationSec * 1000);
			const now = new Date();
			const row = await db.transaction(async (tx) => {
				await lockUser(tx, actor.userId);
				await assertNoOverlap(
					tx,
					actor.userId,
					{ id: "", startedAt, endedAt },
					now,
				);
				const [row] = await tx
					.insert(workTimeEntry)
					.values({
						organizationId: actor.organizationId,
						projectId: task.projectId,
						taskId: task.id,
						userId: actor.userId,
						startedAt,
						endedAt,
						durationSec: input.durationSec,
						note: input.note ?? null,
						billable: input.billable ?? true,
						source: "manual",
					})
					.returning();
				return row as EntryRow;
			});
			c.set("auditResourceId", row.id);
			publishTime(c, row);
			return c.json(await dto(db, row), 201);
		},
	)
	.openapi(
		mutationSpec("work_time.update", "timeUpdate", {
			summary: "Edit a time entry",
			request: { params: IdParam, ...body(WorkTimeEntryPatch) },
			responses: { 200: json(WorkTimeEntry, "Updated"), ...errors },
		}),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const { entry, lockedBefore } = await editable(
				c,
				c.req.valid("param").id,
			);
			if (entry.endedAt === null && input.durationSec !== undefined)
				throw new Failure(
					"bad_request",
					"stop the timer before setting its duration",
				);
			const startedAt = input.startedAt
				? new Date(input.startedAt)
				: entry.startedAt;
			if (isLocked(startedAt, lockedBefore))
				throw new Failure(
					"forbidden",
					`time before ${lockedBefore} is locked for this project`,
				);
			const durationSec = input.durationSec ?? entry.durationSec;
			const endedAt =
				entry.endedAt === null
					? null
					: new Date(startedAt.getTime() + (durationSec ?? 0) * 1000);
			const now = new Date();
			const row = await db.transaction(async (tx) => {
				await lockUser(tx, entry.userId);
				await assertNoOverlap(
					tx,
					entry.userId,
					{ id: entry.id, startedAt, endedAt },
					now,
				);
				const [row] = await tx
					.update(workTimeEntry)
					.set({
						startedAt,
						endedAt,
						durationSec: endedAt === null ? null : durationSec,
						...(input.note !== undefined ? { note: input.note } : {}),
						...(input.billable !== undefined
							? { billable: input.billable }
							: {}),
						updatedAt: now,
					})
					.where(eq(workTimeEntry.id, entry.id))
					.returning();
				return row as EntryRow;
			});
			publishTime(c, row);
			return c.json(await dto(db, row), 200);
		},
	)
	.openapi(
		mutationSpec("work_time.delete", "timeDelete", {
			summary: "Delete a time entry",
			request: { params: IdParam },
			responses: { 204: { description: "Deleted" }, ...errors },
		}),
		async (c) => {
			const { entry } = await editable(c, c.req.valid("param").id);
			await c.var.deps.db
				.delete(workTimeEntry)
				.where(eq(workTimeEntry.id, entry.id));
			publishTime(c, entry);
			return c.body(null, 204);
		},
	)
	.openapi(
		spec("timeReport", {
			summary: "Tracked time grouped by project, person, task, day or week",
			request: { query: WorkTimeReportQuery },
			responses: {
				200: {
					description: "Report rows and totals (or CSV with format=csv)",
					content: {
						"application/json": { schema: WorkTimeReport },
						"text/csv": { schema: z.string() },
					},
				},
				...errors,
			},
		}),
		async (c) => {
			const q = c.req.valid("query");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			if (q.from > q.to || daysBetween(q.from, q.to) > 366)
				throw new Failure(
					"bad_request",
					"from must be before to, at most a year apart",
				);
			if (q.projectId) await checkWork(c, "read:work", q.projectId);
			const tz = await reportTz(db, actor.userId, actor.organizationId, q.tz);
			const now = new Date();
			const lo = zonedMidnight(q.from, tz);
			const hi = zonedMidnight(addDays(q.to, 1), tz);
			const rows = await db
				.select()
				.from(workTimeEntry)
				.where(
					and(
						eq(workTimeEntry.organizationId, actor.organizationId),
						lt(workTimeEntry.startedAt, hi),
						sql`coalesce(${workTimeEntry.endedAt}, now()) > ${lo.toISOString()}::timestamptz`,
						q.projectId ? eq(workTimeEntry.projectId, q.projectId) : undefined,
						q.userId ? eq(workTimeEntry.userId, q.userId) : undefined,
						q.billable
							? eq(workTimeEntry.billable, q.billable === "true")
							: undefined,
					),
				);
			// Without a project filter, keep only projects the actor may read Work on.
			const readable = new Set<string>();
			for (const pid of new Set(rows.map((r) => r.projectId)))
				if (
					actorCan(
						actor,
						"read:work",
						await locate(db, actor.organizationId, "project", pid),
					)
				)
					readable.add(pid);
			const entries = rows.filter((r) => readable.has(r.projectId));
			const rolled = rollupTime(entries, q.groupBy, q, tz, now);
			const labels = await labelsFor(
				db,
				q.groupBy,
				rolled.rows.map((r) => r.key),
			);
			const report: WorkTimeReport = {
				groupBy: q.groupBy,
				rows: rolled.rows.map((r) => ({
					...r,
					label: labels.get(r.key) ?? r.key,
				})),
				totals: rolled.totals,
			};
			if (q.format !== "csv") return c.json(report, 200);
			const lines = [
				[q.groupBy, "hours", "billable_hours", "entries"],
				...report.rows.map((r) => [
					r.label,
					hours(r.seconds),
					hours(r.billableSeconds),
					r.entries,
				]),
				[
					"Total",
					hours(report.totals.seconds),
					hours(report.totals.billableSeconds),
					report.totals.entries,
				],
			];
			return c.body(
				`${lines.map((l) => l.map(csvField).join(",")).join("\r\n")}\r\n`,
				200,
				{
					"content-type": "text/csv; charset=utf-8",
					"content-disposition": `attachment; filename="time-${q.from}-${q.to}.csv"`,
				},
			) as never;
		},
	);

/** Display labels per group key; task rows read "SHOP-42 Title" (the week grid splits on the first space). */
async function labelsFor(db: Db, groupBy: string, keys: string[]) {
	const out = new Map<string, string>();
	if (!keys.length) return out;
	if (groupBy === "project")
		for (const r of await db
			.select({ id: project.id, name: project.name })
			.from(project)
			.where(inArray(project.id, keys)))
			out.set(r.id, r.name);
	else if (groupBy === "user")
		for (const r of await db
			.select({ id: user.id, name: user.name })
			.from(user)
			.where(inArray(user.id, keys)))
			out.set(r.id, r.name);
	else if (groupBy === "task")
		for (const r of await db
			.select({
				id: workTask.id,
				n: workTask.number,
				title: workTask.title,
				key: workProject.key,
			})
			.from(workTask)
			.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
			.where(inArray(workTask.id, keys)))
			out.set(r.id, `${r.key}-${r.n} ${r.title}`);
	return out;
}
