import { expect } from "bun:test";
import { workStatus, workTask, workTaskAssignee } from "@logistack/db";
import { asc, eq } from "drizzle-orm";
import { ensureWorkProject } from "../src/work/context.ts";
import { owner, setupBody, startHarness } from "./harness.ts";

/**
 * A harness with an organization, one project with Work on it, and people in each role:
 * manager, developer, viewer, and `ops` (a custom role with `read` only, no Work access).
 */
export async function collabFixture(area: string) {
	const h = await startHarness({ area, label: area });
	const setup = await h.call("POST", "/api/setup", { body: setupBody });
	const orgId = setup.json.organizationId as string;
	const ownerCookie = await h.signIn(owner.email, owner.password);
	const asOwner = { headers: { cookie: ownerCookie } };
	const ownerId = (await h.call("GET", "/api/me", asOwner)).json
		.userId as string;
	expect(
		(
			await h.call("POST", "/api/roles", {
				...asOwner,
				body: { name: "ops", actions: ["read"] },
			})
		).status,
	).toBe(201);

	async function person(name: string, role: string) {
		const email = `${name.toLowerCase()}@example.com`;
		const password = `${name} password 1234`;
		const invite = await h.call("POST", "/api/invitations", {
			...asOwner,
			body: { email, role },
		});
		expect(invite.status).toBe(201);
		await h.call("POST", "/api/auth/sign-up/email", {
			body: { name, email, password },
		});
		const cookie = await h.signIn(email, password);
		const accepted = await h.call(
			"POST",
			"/api/auth/organization/accept-invitation",
			{ headers: { cookie }, body: { invitationId: invite.json.id } },
		);
		expect(accepted.status).toBe(200);
		const userId = (await h.call("GET", "/api/me", { headers: { cookie } }))
			.json.userId as string;
		return { userId, email, as: { headers: { cookie } } };
	}

	const mia = await person("Mia", "manager");
	const dev = await person("Dev", "developer");
	const vic = await person("Vic", "viewer");
	const ops = await person("Ops", "ops");

	const projectId = (
		await h.call("POST", "/api/projects", {
			...asOwner,
			body: { name: "Shop" },
		})
	).json.id as string;
	const wp = await ensureWorkProject(h.deps.db, projectId);
	const [status] = await h.deps.db
		.select({ id: workStatus.id })
		.from(workStatus)
		.where(eq(workStatus.projectId, projectId))
		.orderBy(asc(workStatus.position));
	let n = 0;

	/** Inserts a task directly (the task routes belong to another module). */
	async function task(
		title = "Task",
		extra: Partial<typeof workTask.$inferInsert> & {
			assignees?: string[];
		} = {},
	) {
		const { assignees, ...rest } = extra;
		const [t] = await h.deps.db
			.insert(workTask)
			.values({
				projectId,
				listId: wp.defaultListId as string,
				statusId: status?.id as string,
				number: 1000 + ++n,
				title,
				position: `a${String(n).padStart(4, "0")}`,
				createdBy: ownerId,
				...rest,
			})
			.returning();
		if (!t) throw new Error("task not inserted");
		if (assignees?.length)
			await h.deps.db
				.insert(workTaskAssignee)
				.values(assignees.map((userId) => ({ taskId: t.id, userId })));
		return t;
	}

	return {
		h,
		orgId,
		ownerId,
		asOwner,
		mia,
		dev,
		vic,
		ops,
		projectId,
		key: wp.key,
		task,
	};
}

export const doc = (...parts: (string | { mention: string })[]) => ({
	type: "doc" as const,
	content: [
		{
			type: "paragraph",
			content: parts.map((p) =>
				typeof p === "string"
					? { type: "text", text: p }
					: { type: "mention", attrs: { id: p.mention, label: "x" } },
			),
		},
	],
});
