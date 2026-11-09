import { z } from "@hono/zod-openapi";
import {
	WorkIcalToken,
	WorkInboxPage,
	WorkInboxRead,
	type WorkNotificationKind,
	WorkPrefs,
	WorkPrefsUpdate,
} from "@logistack/contracts";
import {
	instanceSettings,
	project,
	workNotification,
	workProject,
	workTask,
	workUserPrefs,
} from "@logistack/db";
import { workBaseUrl } from "@logistack/worker/work-mail";
import { and, count, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../../actor.ts";
import { mutation } from "../../audit.ts";
import type { Env } from "../../env.ts";
import { Failure } from "../../errors.ts";
import { body, errors, json, router } from "../../openapi.ts";
import { actorCan } from "../../scope.ts";
import { publishWork, workResource } from "../../work/context.ts";
import { workRoute } from "./collab-shared.ts";

const PAGE = 50;

/** The signed-in person behind the request; API keys act for their owner. */
const me = (c: Context<Env>) => {
	const actor = requireActor(c);
	return { actor, userId: actor.userId, organizationId: actor.organizationId };
};

export const DEFAULT_KINDS: WorkNotificationKind[] = [
	"assigned",
	"mentioned",
	"due_soon",
	"overdue",
];

async function prefsOf(c: Context<Env>): Promise<WorkPrefs> {
	const { userId, organizationId } = me(c);
	const { db } = c.var.deps;
	const [p] = await db
		.select()
		.from(workUserPrefs)
		.where(
			and(
				eq(workUserPrefs.userId, userId),
				eq(workUserPrefs.organizationId, organizationId),
			),
		);
	const [s] = await db
		.select({ mail: instanceSettings.mailEncrypted })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return {
		email: p?.email ?? "off",
		emailKinds: (p?.emailKinds ?? DEFAULT_KINDS) as WorkNotificationKind[],
		dailyHour: p?.dailyHour ?? 8,
		timezone: p?.timezone ?? null,
		capacityHoursPerWeek: p?.capacityHoursPerWeek ?? 32,
		icalEnabled: !!p?.icalTokenHash,
		mailAvailable: !!s?.mail,
	};
}

const validTz = (tz: string) => {
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
};

const cursorOf = (n: { createdAt: Date; id: string }) =>
	Buffer.from(`${n.createdAt.toISOString()}|${n.id}`).toString("base64url");

export const workInbox = router()
	.openapi(
		workRoute("inbox", {
			summary: "Your notifications",
			description:
				"Newest first; notifications on projects you can no longer read are left out.",
			request: {
				query: z.object({
					unread: z.string().optional(),
					cursor: z.string().optional(),
				}),
			},
			responses: { 200: json(WorkInboxPage, "Inbox"), ...errors },
		}),
		async (c) => {
			const { actor, userId, organizationId } = me(c);
			const { unread, cursor } = c.req.valid("query");
			const { db } = c.var.deps;
			const mine = and(
				eq(workNotification.userId, userId),
				eq(workNotification.organizationId, organizationId),
			);
			let after: ReturnType<typeof or> | undefined;
			if (cursor) {
				const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
				const date = new Date(at ?? "");
				if (!id || Number.isNaN(date.getTime()))
					throw new Failure("bad_request", "invalid cursor");
				after = or(
					lt(workNotification.createdAt, date),
					and(
						eq(workNotification.createdAt, date),
						lt(workNotification.id, id),
					),
				);
			}
			const rows = await db
				.select({
					n: workNotification,
					projectId: workTask.projectId,
					projectName: project.name,
					number: workTask.number,
					title: workTask.title,
					key: workProject.key,
				})
				.from(workNotification)
				.innerJoin(workTask, eq(workTask.id, workNotification.taskId))
				.innerJoin(project, eq(project.id, workTask.projectId))
				.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
				.where(
					and(
						mine,
						unread === "1" || unread === "true"
							? isNull(workNotification.readAt)
							: undefined,
						after,
					),
				)
				.orderBy(desc(workNotification.createdAt), desc(workNotification.id))
				.limit(PAGE + 1);
			const page = rows.slice(0, PAGE);
			const readable = new Map<string, boolean>();
			for (const projectId of new Set(page.map((r) => r.projectId)))
				readable.set(
					projectId,
					actorCan(actor, "read:work", await workResource(c, projectId)),
				);
			const [u] = await db
				.select({ n: count() })
				.from(workNotification)
				.where(and(mine, isNull(workNotification.readAt)));
			const last = page.at(-1);
			return c.json(
				{
					items: page
						.filter((r) => readable.get(r.projectId))
						.map((r) => ({
							id: r.n.id,
							kind: r.n.kind,
							organizationId: r.n.organizationId,
							projectId: r.projectId,
							projectName: r.projectName,
							taskId: r.n.taskId,
							taskKey: `${r.key}-${r.number}`,
							taskTitle: r.title,
							commentId: r.n.commentId,
							actorId: r.n.actorId,
							data: r.n.data,
							readAt: r.n.readAt?.toISOString() ?? null,
							createdAt: r.n.createdAt.toISOString(),
						})),
					nextCursor: rows.length > PAGE && last ? cursorOf(last.n) : null,
					unread: u?.n ?? 0,
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"work_inbox.read",
			workRoute("inboxRead", {
				summary: "Mark notifications read",
				request: body(WorkInboxRead),
				responses: {
					200: json(z.object({ updated: z.number().int() }), "Marked"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { userId, organizationId } = me(c);
			const input = c.req.valid("json");
			const updated = await c.var.deps.db
				.update(workNotification)
				.set({ readAt: new Date() })
				.where(
					and(
						eq(workNotification.userId, userId),
						eq(workNotification.organizationId, organizationId),
						isNull(workNotification.readAt),
						"ids" in input
							? inArray(workNotification.id, input.ids)
							: undefined,
					),
				)
				.returning({ taskId: workNotification.taskId });
			const taskIds = [...new Set(updated.map((u) => u.taskId))];
			const projects = taskIds.length
				? await c.var.deps.db
						.selectDistinct({ id: workTask.projectId })
						.from(workTask)
						.where(inArray(workTask.id, taskIds))
				: [];
			for (const p of projects)
				publishWork(c.var.deps, {
					organizationId,
					projectId: p.id,
					entity: "notification",
					op: "upsert",
					userId,
					actorId: userId,
				});
			return c.json({ updated: updated.length }, 200);
		},
	)
	.openapi(
		workRoute("prefsGet", {
			summary: "Your Work notification settings",
			responses: { 200: json(WorkPrefs, "Settings"), ...errors },
		}),
		async (c) => c.json(await prefsOf(c), 200),
	)
	.openapi(
		mutation(
			"work_prefs.update",
			workRoute("prefsUpdate", {
				summary: "Change your Work notification settings",
				description:
					"Email modes other than `off` need instance mail, set up by an instance admin.",
				request: body(WorkPrefsUpdate),
				responses: { 200: json(WorkPrefs, "Settings"), ...errors },
			}),
		),
		async (c) => {
			const { userId, organizationId } = me(c);
			const input = c.req.valid("json");
			if (input.timezone && !validTz(input.timezone))
				throw new Failure("bad_request", `unknown time zone ${input.timezone}`);
			if (
				input.email &&
				input.email !== "off" &&
				!(await prefsOf(c)).mailAvailable
			)
				throw new Failure(
					"conflict",
					"instance email is not set up; ask an admin to set it up",
				);
			const set = {
				...(input.email !== undefined ? { email: input.email } : {}),
				...(input.emailKinds !== undefined
					? { emailKinds: [...new Set(input.emailKinds)] }
					: {}),
				...(input.dailyHour !== undefined
					? { dailyHour: input.dailyHour }
					: {}),
				...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
			};
			await c.var.deps.db
				.insert(workUserPrefs)
				.values({ userId, organizationId, ...set })
				.onConflictDoUpdate({
					target: [workUserPrefs.userId, workUserPrefs.organizationId],
					set: { ...set, updatedAt: new Date() },
				});
			return c.json(await prefsOf(c), 200);
		},
	)
	.openapi(
		mutation(
			"work_prefs.ical_token",
			workRoute("icalToken", {
				summary: "Create or rotate your calendar feed link",
				description:
					"Returns the feed URL once; the previous link stops working. Only a hash of the token is stored.",
				responses: { 200: json(WorkIcalToken, "Feed URL"), ...errors },
			}),
		),
		async (c) => {
			const { userId, organizationId } = me(c);
			const { db, config } = c.var.deps;
			const token = Buffer.from(
				crypto.getRandomValues(new Uint8Array(32)),
			).toString("base64url");
			const icalTokenHash = icalHash(token);
			await db
				.insert(workUserPrefs)
				.values({ userId, organizationId, icalTokenHash })
				.onConflictDoUpdate({
					target: [workUserPrefs.userId, workUserPrefs.organizationId],
					set: { icalTokenHash, updatedAt: new Date() },
				});
			c.set("auditDiff", { rotated: true });
			const base = await workBaseUrl(db, config.WEB_ORIGIN);
			return c.json({ url: `${base}/ical/${token}.ics` }, 200);
		},
	);

export const icalHash = (token: string) =>
	new Bun.CryptoHasher("sha256").update(token).digest("hex");
