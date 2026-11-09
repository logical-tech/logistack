import { can, type Resource, roleAllows } from "@logistack/core";
import { type Db, member, workStatus, workTag } from "@logistack/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { type Actor, grantsFor } from "../actor.ts";
import { Failure } from "../errors.ts";
import { actorCan, locate } from "../scope.ts";
import { ensureWorkProject } from "./context.ts";

/** Guests (plan 12.8): invited to one project, read and comment, see only people on their projects. */

export const FROM_GUEST_TAG = "From guest";

/**
 * Projects the actor reaches only through project-scoped grants (a guest), or null when some
 * wider grant gives `read:work` (no limit applies).
 */
export function guestProjectIds(actor: Actor): string[] | null {
	const reading = actor.grants.filter((g) => roleAllows(g.role, "read:work"));
	if (reading.some((g) => g.scope.kind !== "project")) return null;
	return [...new Set(reading.map((g) => g.scope.id))];
}

/**
 * For `POST /tasks`: null when the actor holds `work` on the project (normal rules apply).
 * Otherwise a guest may create only when the project turns on `guestsCanCreate`, and the task
 * lands in the default list's first backlog status with the "From guest" tag (created on demand).
 * Throws 403 when neither applies.
 */
export async function guestCreateDefaults(
	db: Db,
	actor: Actor,
	resource: Resource,
): Promise<{ listId: string; statusId: string; tagId: string } | null> {
	const projectId = resource.projectId;
	if (!projectId)
		throw new Error("guestCreateDefaults needs a project resource");
	if (actorCan(actor, "work", resource)) return null;
	const wp = await ensureWorkProject(db, projectId);
	if (!wp.guestsCanCreate || !actorCan(actor, "comment:work", resource))
		throw new Failure("forbidden", "guests can't create tasks in this project");
	const [backlog] = await db
		.select({ id: workStatus.id })
		.from(workStatus)
		.where(
			and(
				eq(workStatus.projectId, projectId),
				eq(workStatus.category, "backlog"),
			),
		)
		.orderBy(asc(workStatus.position))
		.limit(1);
	if (!backlog || !wp.defaultListId)
		throw new Failure(
			"conflict",
			"the project has no backlog status or default list",
		);
	await db
		.insert(workTag)
		.values({ projectId, name: FROM_GUEST_TAG, color: "teal" })
		.onConflictDoNothing();
	const [tag] = await db
		.select({ id: workTag.id })
		.from(workTag)
		.where(
			and(
				eq(workTag.projectId, projectId),
				sql`lower(${workTag.name}) = lower(${FROM_GUEST_TAG})`,
			),
		);
	if (!tag) throw new Error("From guest tag vanished");
	return { listId: wp.defaultListId, statusId: backlog.id, tagId: tag.id };
}

/**
 * People an actor may see in pickers and filters: null means everyone in the organization;
 * a guest gets the members holding `read:work` on at least one of the guest's projects.
 */
export async function visiblePeople(
	db: Db,
	actor: Actor,
): Promise<Set<string> | null> {
	const projectIds = guestProjectIds(actor);
	if (projectIds === null) return null;
	const resources = await Promise.all(
		projectIds.map((id) =>
			locate(db, actor.organizationId, "project", id).catch(() => null),
		),
	);
	const members = await db
		.select({ userId: member.userId })
		.from(member)
		.where(eq(member.organizationId, actor.organizationId));
	const out = new Set<string>([actor.userId]);
	// shortcut: one grants lookup per member; fine for team-sized orgs, batch it if orgs grow to thousands.
	for (const m of members) {
		const grants = await grantsFor(
			db,
			m.userId,
			m.userId,
			actor.organizationId,
		);
		if (
			grants &&
			resources.some((r) => r && can({ id: m.userId }, "read:work", r, grants))
		)
			out.add(m.userId);
	}
	return out;
}
