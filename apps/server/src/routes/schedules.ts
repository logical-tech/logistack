import { createRoute, z } from "@hono/zod-openapi";
import {
	RunStatus,
	ScheduleConcurrency,
	ScheduleTarget,
} from "@logistack/contracts";
import type { Resource } from "@logistack/core";
import { newId } from "@logistack/core";
import { node, schedule, scheduleRun } from "@logistack/db";
import { syncScheduleScheduler } from "@logistack/worker/schedulers";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { Cron, nextRun, nextRuns, Timezone } from "../cron.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import {
	body,
	errors,
	IdParam,
	json,
	Name,
	router,
	security,
} from "../openapi.ts";
import { runQueues } from "../run-queues.ts";
import {
	assertInstanceAdmin,
	check,
	inOrganization,
	locate,
	organizationResource,
	type ResolveResource,
	requirePermission,
} from "../scope.ts";

export const ScheduleRunView = z
	.object({
		id: z.string(),
		scheduleId: z.string(),
		status: RunStatus,
		trigger: z.enum(["cron", "manual"]),
		exitCode: z.int().nullable(),
		outputBytes: z.number().nullable(),
		error: z.string().nullable(),
		startedAt: z.string(),
		finishedAt: z.string().nullable(),
		durationMs: z.number().nullable(),
	})
	.openapi("ScheduleRun");

const ScheduleRunDetail = ScheduleRunView.extend({
	output: z.string().nullable(),
	/** Bytes the run may keep; output beyond it is counted but dropped. */
	outputLimitBytes: z.number(),
}).openapi("ScheduleRunDetail");

export const ScheduleView = z
	.object({
		id: z.string(),
		projectId: z.string().nullable(),
		name: z.string(),
		cron: z.string(),
		timezone: z.string(),
		script: z.string(),
		target: ScheduleTarget,
		timeoutS: z.int(),
		concurrency: ScheduleConcurrency,
		notifyOnFailure: z.boolean(),
		enabled: z.boolean(),
		nextRunAt: z.string().nullable(),
		lastRun: ScheduleRunView.nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi("Schedule");

const ScheduleFields = z.object({
	name: Name,
	projectId: z.string().nullable().default(null),
	cron: Cron,
	timezone: Timezone.default("UTC"),
	script: z
		.string()
		.min(1)
		.max(64 * 1024),
	target: ScheduleTarget.default({ kind: "ephemeral", image: "alpine:3.22" }),
	timeoutS: z.int().min(1).max(86_400).default(3600),
	concurrency: ScheduleConcurrency.default("forbid"),
	notifyOnFailure: z.boolean().default(true),
	enabled: z.boolean().default(true),
});

const SchedulePatch = ScheduleFields.partial().refine(
	(o) => Object.keys(o).length > 0,
	"nothing to update",
);

/** Kept in step with the worker's LS_SCHEDULE_OUTPUT_LIMIT default; shown next to a capped run. */
const OUTPUT_LIMIT_BYTES = 1024 * 1024;

type RunRow = typeof scheduleRun.$inferSelect;
type ScheduleRow = typeof schedule.$inferSelect;

const iso = (d: Date | null) => d?.toISOString() ?? null;

const runView = (r: RunRow): z.infer<typeof ScheduleRunView> => ({
	id: r.id,
	scheduleId: r.scheduleId,
	status: r.status,
	trigger: r.trigger,
	exitCode: r.exitCode,
	outputBytes: r.outputBytes,
	error: r.error,
	startedAt: r.startedAt.toISOString(),
	finishedAt: iso(r.finishedAt),
	durationMs: r.finishedAt
		? r.finishedAt.getTime() - r.startedAt.getTime()
		: null,
});

const view = (s: ScheduleRow, last?: RunRow): z.infer<typeof ScheduleView> => ({
	id: s.id,
	projectId: s.projectId,
	name: s.name,
	cron: s.cron,
	timezone: s.timezone,
	script: s.script,
	target: s.target,
	timeoutS: s.timeoutS,
	concurrency: s.concurrency,
	notifyOnFailure: s.notifyOnFailure,
	enabled: s.enabled,
	nextRunAt: nextRun(s.cron, s.timezone, s.enabled),
	lastRun: last ? runView(last) : null,
	createdAt: s.createdAt.toISOString(),
	updatedAt: s.updatedAt.toISOString(),
});

/** A schedule's scope: its project when it has one, the organization otherwise. */
async function scopeOf(
	c: Context<Env>,
	projectId: string | null,
): Promise<Resource> {
	const orgId = requireActor(c).organizationId;
	return projectId
		? locate(c.var.deps.db, orgId, "project", projectId)
		: organizationResource(orgId);
}

function viaSchedule(from: "schedule" | "run"): ResolveResource {
	return async (c, actor) => {
		const { db } = c.var.deps;
		const id = c.req.param("id") ?? "";
		const [row] =
			from === "schedule"
				? await db
						.select({
							org: schedule.organizationId,
							projectId: schedule.projectId,
						})
						.from(schedule)
						.where(eq(schedule.id, id))
				: await db
						.select({
							org: schedule.organizationId,
							projectId: schedule.projectId,
						})
						.from(scheduleRun)
						.innerJoin(schedule, eq(schedule.id, scheduleRun.scheduleId))
						.where(eq(scheduleRun.id, id));
		const what = from === "schedule" ? "schedule" : "schedule run";
		if (!row || row.org !== actor.organizationId) throw notFound(what);
		return scopeOf(c, row.projectId).catch(() => {
			throw notFound(what);
		});
	};
}

/**
 * Running inside a service needs deploy there; on a host, instance admin: the script runs as root
 * on a node other organizations may share.
 */
async function checkTarget(
	c: Context<Env>,
	target: z.infer<typeof ScheduleTarget>,
) {
	const actor = requireActor(c);
	if (target.kind === "service")
		check(
			c,
			"deploy",
			await locate(
				c.var.deps.db,
				actor.organizationId,
				"service",
				target.serviceId,
			),
		);
	if (target.kind === "host") {
		assertInstanceAdmin(c);
		check(c, "admin", organizationResource(actor.organizationId));
		const n = await c.var.deps.db.$count(
			node,
			and(
				eq(node.id, target.nodeId),
				eq(node.organizationId, actor.organizationId),
			),
		);
		if (!n) throw new Failure("bad_request", "unknown node");
	}
}

async function lastRuns(c: Context<Env>, ids: string[]) {
	if (!ids.length) return new Map<string, RunRow>();
	const rows = await c.var.deps.db
		.selectDistinctOn([scheduleRun.scheduleId])
		.from(scheduleRun)
		.where(inArray(scheduleRun.scheduleId, ids))
		.orderBy(scheduleRun.scheduleId, desc(scheduleRun.startedAt));
	return new Map(rows.map((r) => [r.scheduleId, r]));
}

const sync = (c: Context<Env>, s: ScheduleRow) =>
	syncScheduleScheduler(runQueues(c.var.deps.config.REDIS_URL), s);

export const schedules = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/schedules",
			tags: ["schedules"],
			security,
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(ScheduleView), "Schedules"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select()
				.from(schedule)
				.where(eq(schedule.organizationId, requireActor(c).organizationId))
				.orderBy(asc(schedule.name));
			const last = await lastRuns(
				c,
				rows.map((r) => r.id),
			);
			return c.json(
				rows.map((r) => view(r, last.get(r.id))),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/schedules/preview",
			tags: ["schedules"],
			security,
			summary: "The next five times a cron fires in a time zone",
			middleware: [requirePermission("read", inOrganization)],
			request: { query: z.object({ cron: Cron, timezone: Timezone }) },
			responses: {
				200: json(z.object({ next: z.array(z.string()) }), "Next runs"),
				...errors,
			},
		}),
		(c) => {
			const { cron, timezone } = c.req.valid("query");
			return c.json({ next: nextRuns(cron, timezone, 5) }, 200);
		},
	)
	.openapi(
		mutation(
			"schedule.create",
			createRoute({
				method: "post",
				path: "/schedules",
				tags: ["schedules"],
				security,
				description:
					"A `host` target runs the script as root on the node itself (chroot into its filesystem, host network) and needs admin.",
				middleware: [requirePermission("read", inOrganization)],
				request: body(ScheduleFields),
				responses: { 201: json(ScheduleView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			check(c, "write", await scopeOf(c, input.projectId));
			await checkTarget(c, input.target);
			const row = one(
				await c.var.deps.db
					.insert(schedule)
					.values({ ...input, organizationId: requireActor(c).organizationId })
					.returning(),
			);
			c.set("auditResourceId", row.id);
			await sync(c, row);
			return c.json(view(row), 201);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/schedules/{id}",
			tags: ["schedules"],
			security,
			summary: "A schedule with its newest 50 runs",
			middleware: [requirePermission("read", viaSchedule("schedule"))],
			request: { params: IdParam },
			responses: {
				200: json(
					ScheduleView.extend({ runs: z.array(ScheduleRunView) }),
					"Schedule",
				),
				...errors,
			},
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const row = one(
				await db.select().from(schedule).where(eq(schedule.id, id)),
				"schedule",
			);
			const runs = await db
				.select()
				.from(scheduleRun)
				.where(eq(scheduleRun.scheduleId, id))
				.orderBy(desc(scheduleRun.startedAt))
				.limit(50);
			return c.json({ ...view(row, runs[0]), runs: runs.map(runView) }, 200);
		},
	)
	.openapi(
		mutation(
			"schedule.update",
			createRoute({
				method: "patch",
				path: "/schedules/{id}",
				tags: ["schedules"],
				security,
				summary: "Edit, enable or disable a schedule",
				middleware: [requirePermission("write", viaSchedule("schedule"))],
				request: { params: IdParam, ...body(SchedulePatch) },
				responses: { 200: json(ScheduleView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			c.set("auditResourceId", id);
			if (input.projectId !== undefined)
				check(c, "write", await scopeOf(c, input.projectId));
			if (input.target) await checkTarget(c, input.target);
			const { db } = c.var.deps;
			const [current] = await db
				.select({ target: schedule.target })
				.from(schedule)
				.where(eq(schedule.id, id));
			// Changing what runs, or turning it on, is running it on the target too.
			if (
				current &&
				!input.target &&
				(current.target.kind === "host" ||
					input.script !== undefined ||
					input.enabled !== undefined)
			)
				await checkTarget(c, current.target);
			const row = one(
				await db
					.update(schedule)
					.set(input)
					.where(eq(schedule.id, id))
					.returning(),
				"schedule",
			);
			await sync(c, row);
			return c.json(view(row, (await lastRuns(c, [id])).get(id)), 200);
		},
	)
	.openapi(
		mutation(
			"schedule.delete",
			createRoute({
				method: "delete",
				path: "/schedules/{id}",
				tags: ["schedules"],
				security,
				middleware: [requirePermission("write", viaSchedule("schedule"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			await c.var.deps.db.delete(schedule).where(eq(schedule.id, id));
			await runQueues(c.var.deps.config.REDIS_URL).schedule.removeJobScheduler(
				id,
			);
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"schedule.run",
			createRoute({
				method: "post",
				path: "/schedules/{id}/run",
				tags: ["schedules"],
				security,
				summary: "Run now",
				description:
					"Queues a manual run under the schedule's concurrency policy: with `forbid` it is recorded as skipped while another run is going.",
				middleware: [requirePermission("deploy", viaSchedule("schedule"))],
				request: { params: IdParam },
				responses: { 202: json(ScheduleRunView, "Queued"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const s = one(
				await db.select().from(schedule).where(eq(schedule.id, id)),
				"schedule",
			);
			await checkTarget(c, s.target);
			const run = one(
				await db
					.insert(scheduleRun)
					.values({ id: newId("scr"), scheduleId: id, trigger: "manual" })
					.returning(),
			);
			c.set("auditResourceId", run.id);
			await runQueues(c.var.deps.config.REDIS_URL).schedule.add(
				"run",
				{ scheduleId: id, runId: run.id, trigger: "manual" },
				{
					jobId: run.id,
					attempts: 1,
					removeOnComplete: { count: 200 },
					removeOnFail: { count: 500 },
				},
			);
			return c.json(runView(run), 202);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/schedule-runs/{id}",
			tags: ["schedules"],
			security,
			summary: "A run with its (capped) output",
			middleware: [requirePermission("read", viaSchedule("run"))],
			request: { params: IdParam },
			responses: { 200: json(ScheduleRunDetail, "Run"), ...errors },
		}),
		async (c) => {
			const r = one(
				await c.var.deps.db
					.select()
					.from(scheduleRun)
					.where(eq(scheduleRun.id, c.req.valid("param").id)),
				"schedule run",
			);
			return c.json(
				{
					...runView(r),
					output: r.output,
					outputLimitBytes: OUTPUT_LIMIT_BYTES,
				},
				200,
			);
		},
	);
