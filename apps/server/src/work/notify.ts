import type {
	EventType,
	PermissionAction,
	WorkNotificationKind,
} from "@logistack/contracts";
import { can, type Resource } from "@logistack/core";
import { workNotification } from "@logistack/db";
import { sendMail } from "@logistack/providers";
import {
	loadInstanceMail,
	queueInstantMails,
	taskUrl,
	workBaseUrl,
} from "@logistack/worker/work-mail";
import { and, desc, eq, gt, isNull, notInArray } from "drizzle-orm";
import { grantsFor } from "../actor.ts";
import type { Deps } from "../env.ts";
import { envelope } from "../events.ts";
import { log } from "../log.ts";
import { runQueues } from "../run-queues.ts";
import { hostPolicy } from "../ssrf.ts";
import { publishWork } from "./context.ts";

/**
 * Personal notifications (plan 14.2): who gets what is decided by the callers (comment routes,
 * task routes); this module filters out the actor, bundles, fans out realtime and queues email.
 */

export type NotifyInput = {
	userId: string;
	kind: WorkNotificationKind;
	taskId: string;
	projectId: string;
	organizationId: string;
	actorId: string | null;
	commentId?: string | null;
	data?: Record<string, unknown>;
};

/** Bundling window: notifications for the same task and user collapse into one inbox row. */
export const BUNDLE_MS = 5 * 60_000;

// When notifications bundle, the row keeps the most important kind.
const RANK: WorkNotificationKind[] = [
	"mentioned",
	"assigned",
	"replied",
	"checklist_assigned",
	"unassigned",
	"commented",
	"status_changed",
];
const rank = (k: WorkNotificationKind) => {
	const i = RANK.indexOf(k);
	return i === -1 ? RANK.length : i;
};

/** One notification per user per call (the first, most specific kind wins). Returns rows written. */
export async function notify(deps: Deps, items: NotifyInput[]) {
	const { db } = deps;
	const seen = new Set<string>();
	const fresh: {
		id: string;
		userId: string;
		organizationId: string;
		kind: WorkNotificationKind;
	}[] = [];
	const touched: NotifyInput[] = [];
	for (const n of items) {
		if (n.actorId && n.userId === n.actorId) continue;
		if (seen.has(`${n.userId}:${n.taskId}`)) continue;
		seen.add(`${n.userId}:${n.taskId}`);
		const [prev] = await db
			.select()
			.from(workNotification)
			.where(
				and(
					eq(workNotification.userId, n.userId),
					eq(workNotification.taskId, n.taskId),
					isNull(workNotification.readAt),
					isNull(workNotification.emailedAt),
					isNull(workNotification.dueDate),
					notInArray(workNotification.kind, ["due_soon", "overdue"]),
					gt(workNotification.createdAt, new Date(Date.now() - BUNDLE_MS)),
				),
			)
			.orderBy(desc(workNotification.createdAt))
			.limit(1);
		if (prev) {
			const data = prev.data as { count?: number; kinds?: string[] };
			await db
				.update(workNotification)
				.set({
					kind: rank(n.kind) < rank(prev.kind) ? n.kind : prev.kind,
					actorId: n.actorId,
					commentId: n.commentId ?? prev.commentId,
					createdAt: new Date(),
					data: {
						...data,
						...n.data,
						count: (data.count ?? 1) + 1,
						kinds: [...new Set([...(data.kinds ?? [prev.kind]), n.kind])],
					},
				})
				.where(eq(workNotification.id, prev.id));
		} else {
			const [row] = await db
				.insert(workNotification)
				.values({
					userId: n.userId,
					organizationId: n.organizationId,
					taskId: n.taskId,
					commentId: n.commentId ?? null,
					actorId: n.actorId,
					kind: n.kind,
					data: n.data ?? {},
				})
				.returning({ id: workNotification.id });
			if (row)
				fresh.push({
					id: row.id,
					userId: n.userId,
					organizationId: n.organizationId,
					kind: n.kind,
				});
		}
		touched.push(n);
	}
	for (const n of touched)
		publishWork(deps, {
			organizationId: n.organizationId,
			projectId: n.projectId,
			taskIds: [n.taskId],
			entity: "notification",
			op: "upsert",
			userId: n.userId,
			actorId: n.actorId,
		});
	await queueInstantMails(
		db,
		runQueues(deps.config.REDIS_URL).work,
		fresh,
	).catch((error: unknown) =>
		log("error", "work email not queued", { error: String(error) }),
	);
	return touched.length;
}

/** `read:work` (or another action) of an arbitrary member on a project; grants cached per call site. */
export function memberAccess(deps: Deps, organizationId: string) {
	const cache = new Map<string, ReturnType<typeof grantsFor>>();
	return async (
		userId: string,
		action: PermissionAction,
		resource: Resource,
	): Promise<boolean> => {
		let g = cache.get(userId);
		if (!g) {
			g = grantsFor(deps.db, userId, userId, organizationId);
			cache.set(userId, g);
		}
		const grants = await g;
		return !!grants && can({ id: userId }, action, resource, grants);
	};
}

/** `task.*` on the event bus (rules route them to org channels); never fails the request. */
export async function publishTaskEvent(
	deps: Deps,
	type: EventType,
	t: {
		organizationId: string;
		id: string;
		projectId: string;
		key: string;
		number: number;
		title: string;
	},
	extra: { actorId: string | null } & Record<string, unknown>,
) {
	const base = await workBaseUrl(deps.db, deps.config.WEB_ORIGIN);
	await deps.bus
		.publishEvent(
			envelope(
				type,
				t.organizationId,
				{ type: "task", id: t.id },
				{
					projectId: t.projectId,
					taskKey: `${t.key}-${t.number}`,
					title: t.title,
					url: taskUrl(base, t.key, t.number),
					...extra,
				},
			),
		)
		.catch((error: unknown) =>
			log("error", "task event not published", { error: String(error) }),
		);
}

/** The transport instance mail goes through; tests swap `send`. */
export const mailer = { send: sendMail };

/** Instance mail, when configured; returns whether it was sent. Never throws. */
export async function sendInstanceMail(
	deps: Deps,
	message: { to: string; subject: string; text: string; html?: string },
): Promise<boolean> {
	try {
		const config = await loadInstanceMail(deps.db, deps.masterKey);
		if (!config) return false;
		await mailer.send(config, message, {
			hostPolicy: await hostPolicy(deps.db),
		});
		return true;
	} catch (error) {
		log("error", "instance mail failed", { error: String(error) });
		return false;
	}
}
