import { rankBetween } from "@logistack/core";
import { type Db, workStatus, workTask } from "@logistack/db";
import { and, eq } from "drizzle-orm";
import { ensureWorkProject, nextTaskNumber } from "../src/work/context.ts";
import { type Harness, owner, setupBody, startHarness } from "./harness.ts";

/** A harness with its own containers (`ls-test-work-extras-b-<area>-*`), set up and signed in as the owner. */
export async function workHarness(area: string) {
	const h = await startHarness({
		area: `work-extras-b-${area}`,
		label: `work-extras-b-${area}`,
	});
	const setup = await h.call("POST", "/api/setup", { body: setupBody });
	const cookie = await h.signIn(owner.email, owner.password);
	const as = (c = cookie) => ({ headers: { cookie: c } });
	const newProject = async (name: string) => {
		const p = await h.call("POST", "/api/projects", {
			...as(),
			body: { name },
		});
		if (p.status !== 201) throw new Error(`project: ${p.status}`);
		const wp = await ensureWorkProject(h.deps.db, p.json.id);
		return {
			id: p.json.id as string,
			key: wp.key,
			listId: wp.defaultListId as string,
		};
	};
	return {
		h,
		orgId: setup.json.organizationId as string,
		cookie,
		as,
		newProject,
	};
}
export type WorkHarness = Awaited<ReturnType<typeof workHarness>> & {
	h: Harness;
};

/** Inserts a task in the project's first status of `category` (default backlog). */
export async function seedTask(
	db: Db,
	p: { id: string; listId: string },
	title: string,
	category: "backlog" | "active" | "done" = "backlog",
) {
	const [status] = await db
		.select({ id: workStatus.id })
		.from(workStatus)
		.where(
			and(eq(workStatus.projectId, p.id), eq(workStatus.category, category)),
		);
	return db.transaction(async (tx) => {
		const number = await nextTaskNumber(tx, p.id);
		const [t] = await tx
			.insert(workTask)
			.values({
				projectId: p.id,
				listId: p.listId,
				number,
				title,
				statusId: status?.id as string,
				position: rankBetween(String(number).padStart(4, "0"), null),
			})
			.returning();
		if (!t) throw new Error("task insert");
		return t;
	});
}

/** Signs up `email`, accepts `invitationId` and returns the session cookie. */
export async function acceptAs(
	h: Harness,
	who: { name: string; email: string; password: string },
	invitationId: string,
) {
	const up = await h.call("POST", "/api/auth/sign-up/email", { body: who });
	if (up.status !== 200) throw new Error(`sign-up: ${up.status}`);
	const cookie = await h.signIn(who.email, who.password);
	const accepted = await h.call(
		"POST",
		"/api/auth/organization/accept-invitation",
		{
			headers: { cookie },
			body: { invitationId },
		},
	);
	if (accepted.status !== 200)
		throw new Error(
			`accept: ${accepted.status} ${JSON.stringify(accepted.json)}`,
		);
	return cookie;
}
