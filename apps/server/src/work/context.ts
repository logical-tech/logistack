import type { PermissionAction, WorkViewConfig } from "@logistack/contracts";
import { type Resource, rankN } from "@logistack/core";
import {
	type Db,
	project,
	workActivity,
	workList,
	workProject,
	workStatus,
	workView,
} from "@logistack/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Actor } from "../actor.ts";
import { requireActor } from "../actor.ts";
import { cluster } from "../cluster.ts";
import type { Deps, Env } from "../env.ts";
import { check, locate } from "../scope.ts";

/**
 * Shared plumbing for every Work route: permission checks on the project resource, lazy
 * creation of `work_project` with its seeded statuses/list/views, activity writing and the
 * realtime fan-out channel. Routes import from here; nobody else writes these concerns.
 */

/** Redis channel Work mutations publish on; the WebSocket hub forwards to sockets that may `read:work`. */
export const WORK_CHANNEL = "ls:work";

export type WorkMessage = {
	type: "work";
	organizationId: string;
	projectId: string;
	entity:
		| "task"
		| "list"
		| "status"
		| "field"
		| "view"
		| "comment"
		| "tag"
		| "project"
		| "health"
		| "time"
		| "notification";
	op: "upsert" | "delete";
	taskIds?: string[];
	/** Notifications target one user only. */
	userId?: string;
	actorId: string | null;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

/** The project's `Resource` (with folder ancestry) in the actor's organization; 404 when absent. */
export async function workResource(
	c: Context<Env>,
	projectId: string,
): Promise<Resource> {
	return locate(
		c.var.deps.db,
		requireActor(c).organizationId,
		"project",
		projectId,
	);
}

/** 403 unless the actor holds `action` on the project; returns both for the handler. */
export async function checkWork(
	c: Context<Env>,
	action: PermissionAction,
	projectId: string,
): Promise<{ actor: Actor; resource: Resource }> {
	const resource = await workResource(c, projectId);
	return { actor: check(c, action, resource), resource };
}

/** `SHOP` from "Shop", `BR` from "Blog relaunch"; letters only, 2–6 chars. */
export function deriveKey(name: string): string {
	const words = name
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9 ]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
	let key =
		words.length > 1
			? words.map((w) => w[0]).join("")
			: (words[0] ?? "WORK").slice(0, 4);
	key = key.toUpperCase().replace(/^[0-9]+/, "");
	if (key.length < 2) key = `${key}X`.padEnd(2, "X");
	return key.slice(0, 6);
}

const SEED_STATUSES = [
	{ name: "Backlog", color: "gray", category: "backlog" },
	{ name: "To do", color: "blue", category: "active" },
	{ name: "In progress", color: "amber", category: "active" },
	{ name: "Review", color: "violet", category: "active" },
	{ name: "Done", color: "green", category: "done" },
	{ name: "Cancelled", color: "red", category: "cancelled" },
] as const;

const SEED_VIEWS: {
	name: string;
	kind: "table" | "board" | "timeline" | "calendar";
	config: Partial<WorkViewConfig>;
}[] = [
	{ name: "List", kind: "table", config: { groupBy: "status" } },
	{ name: "Board", kind: "board", config: { groupBy: "status" } },
	{ name: "Timeline", kind: "timeline", config: {} },
	{ name: "Calendar", kind: "calendar", config: {} },
];

/**
 * Returns the project's `work_project` row, creating it (key, seeded statuses, a "Tasks" list,
 * the four shared views) on first use. Idempotent and safe under concurrency: the insert races
 * on the primary key and only the winner seeds.
 */
export async function ensureWorkProject(db: Db, projectId: string) {
	const [existing] = await db
		.select()
		.from(workProject)
		.where(eq(workProject.projectId, projectId));
	if (existing) return existing;
	return db.transaction(async (tx) => {
		const [p] = await tx
			.select({ name: project.name, organizationId: project.organizationId })
			.from(project)
			.where(eq(project.id, projectId));
		if (!p) throw new Error(`project ${projectId} not found`);
		const base = deriveKey(p.name);
		let key = base;
		for (let n = 2; ; n++) {
			const [taken] = await tx
				.select({ k: workProject.key })
				.from(workProject)
				.where(
					and(
						eq(workProject.organizationId, p.organizationId),
						eq(workProject.key, key),
					),
				);
			if (!taken) break;
			key = `${base.slice(0, 9 - String(n).length)}${n}`;
		}
		const [created] = await tx
			.insert(workProject)
			.values({ projectId, organizationId: p.organizationId, key })
			.onConflictDoNothing()
			.returning();
		if (!created) {
			const [row] = await tx
				.select()
				.from(workProject)
				.where(eq(workProject.projectId, projectId));
			if (!row) throw new Error("work_project vanished");
			return row;
		}
		const statusRanks = rankN(null, null, SEED_STATUSES.length);
		await tx.insert(workStatus).values(
			SEED_STATUSES.map((s, i) => ({
				projectId,
				name: s.name,
				color: s.color,
				category: s.category,
				position: statusRanks[i] as string,
			})),
		);
		const [list] = await tx
			.insert(workList)
			.values({
				projectId,
				name: "Tasks",
				position: rankN(null, null, 1)[0] as string,
			})
			.returning({ id: workList.id });
		const viewRanks = rankN(null, null, SEED_VIEWS.length);
		await tx.insert(workView).values(
			SEED_VIEWS.map((v, i) => ({
				projectId,
				name: v.name,
				kind: v.kind,
				config: v.config as WorkViewConfig,
				position: viewRanks[i] as string,
				isDefault: i === 0,
			})),
		);
		const [row] = await tx
			.update(workProject)
			.set({ defaultListId: list?.id ?? null })
			.where(eq(workProject.projectId, projectId))
			.returning();
		return row ?? created;
	});
}

/** Allocates the next task number inside the caller's transaction. */
export async function nextTaskNumber(tx: DbOrTx, projectId: string) {
	const [row] = await tx
		.update(workProject)
		.set({ nextNumber: sql`${workProject.nextNumber} + 1` })
		.where(eq(workProject.projectId, projectId))
		.returning({ n: sql<number>`${workProject.nextNumber} - 1` });
	if (!row) throw new Error(`work_project ${projectId} missing`);
	return Number(row.n);
}

type ActivityKind = typeof workActivity.$inferInsert.kind;

/**
 * Appends an activity entry. Edits of the same `field` (or kind) by the same actor on the
 * same task within 2 minutes update the previous entry instead, keeping the first `before`.
 */
export async function writeActivity(
	tx: DbOrTx,
	entry: {
		taskId: string;
		actorId: string | null;
		kind: ActivityKind;
		data?: Record<string, unknown>;
		/** Collapse key inside `data` (e.g. a field id); defaults to the kind alone. */
		collapse?: boolean;
	},
) {
	const data = entry.data ?? {};
	if (entry.collapse && entry.actorId) {
		const [prev] = await tx
			.select()
			.from(workActivity)
			.where(
				and(
					eq(workActivity.taskId, entry.taskId),
					eq(workActivity.actorId, entry.actorId),
					eq(workActivity.kind, entry.kind),
					gt(workActivity.updatedAt, sql`now() - interval '2 minutes'`),
				),
			)
			.orderBy(desc(workActivity.createdAt))
			.limit(1);
		if (prev && (prev.data as { field?: unknown }).field === data.field) {
			await tx
				.update(workActivity)
				.set({
					data: { ...data, before: (prev.data as { before?: unknown }).before },
					updatedAt: new Date(),
				})
				.where(eq(workActivity.id, prev.id));
			return;
		}
	}
	await tx.insert(workActivity).values({
		taskId: entry.taskId,
		actorId: entry.actorId,
		kind: entry.kind,
		data,
	});
}

/** Fire-and-forget after commit; a dropped message only delays a client refresh. */
export function publishWork(deps: Deps, message: Omit<WorkMessage, "type">) {
	void cluster(deps.config.REDIS_URL)
		.publish(WORK_CHANNEL, { type: "work", ...message })
		.catch(() => {});
}
