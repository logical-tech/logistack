import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decrypt } from "@logistack/core";
import {
	gitProvider,
	workActivity,
	workGitLink,
	workNotification,
	workProject,
	workStatus,
	workTask,
	workTaskWatcher,
} from "@logistack/db";
import { hmacSha256 } from "@logistack/providers";
import { and, eq } from "drizzle-orm";
import { gitForTask, settleGitLinks } from "../src/work/git-links.ts";
import { hasDocker } from "./harness.ts";
import {
	acceptAs,
	seedTask,
	type WorkHarness,
	workHarness,
} from "./work-extras-b-fixtures.ts";

const REPO = "acme/shop";

const push = (branch: string, commits: { id: string; message: string }[]) => ({
	ref: `refs/heads/${branch}`,
	after: commits.at(-1)?.id ?? "f".repeat(40),
	repository: { full_name: REPO, default_branch: "main" },
	head_commit: { ...commits.at(-1), author: { name: "Ada" } },
	pusher: { login: "ada" },
	commits: commits.map((c) => ({
		...c,
		url: `https://git.example.com/${REPO}/commit/${c.id}`,
		author: { name: "Ada" },
		added: [],
		modified: ["README.md"],
		removed: [],
	})),
});

const pr = (o: {
	number: number;
	title: string;
	body: string;
	head: string;
	merged: boolean;
	state: string;
	action: string;
}) => ({
	action: o.action,
	number: o.number,
	repository: { full_name: REPO, default_branch: "main" },
	pull_request: {
		title: o.title,
		body: o.body,
		html_url: `https://git.example.com/${REPO}/pulls/${o.number}`,
		state: o.state,
		merged: o.merged,
		user: { login: "ada" },
		head: { ref: o.head, sha: "a".repeat(40), repo: { full_name: REPO } },
		base: { ref: "main" },
	},
});

describe.skipIf(!hasDocker)("work git links", () => {
	let w: WorkHarness;
	let providerId: string;
	let secret: string;
	let p: { id: string; key: string; listId: string };

	const deliver = async (payload: unknown, event = "push") => {
		const raw = JSON.stringify(payload);
		const res = await w.h.call("POST", `/api/webhooks/git/${providerId}`, {
			body: payload,
			headers: {
				"x-gitea-event": event,
				"x-gitea-signature": (await hmacSha256(secret, raw)).toHex(),
			},
		});
		await settleGitLinks();
		return res;
	};
	const statusOf = async (taskId: string) => {
		const [r] = await w.h.deps.db
			.select({ category: workStatus.category })
			.from(workTask)
			.innerJoin(workStatus, eq(workStatus.id, workTask.statusId))
			.where(eq(workTask.id, taskId));
		return r?.category;
	};
	const links = (taskId: string) =>
		w.h.deps.db
			.select()
			.from(workGitLink)
			.where(eq(workGitLink.taskId, taskId));

	beforeAll(async () => {
		w = await workHarness("git");
		const created = await w.h.call("POST", "/api/git-providers", {
			...w.as(),
			body: {
				name: "Forgejo",
				provider: {
					kind: "gitea",
					baseUrl: "https://git.example.com",
					token: "tok",
				},
			},
		});
		expect(created.status).toBe(201);
		providerId = created.json.id;
		const [row] = await w.h.deps.db
			.select()
			.from(gitProvider)
			.where(eq(gitProvider.id, providerId));
		secret = JSON.parse(
			await decrypt(w.h.deps.masterKey, row?.configEncrypted ?? ""),
		).webhookSecret;
		p = await w.newProject("Shop");
		await w.h.deps.db
			.update(workProject)
			.set({ repos: [{ providerId, repo: REPO }] })
			.where(eq(workProject.projectId, p.id));
	}, 90_000);
	afterAll(() => w?.h.close());

	test("a feature-branch push links commits and the branch, closes nothing, and keeps the deploy answer", async () => {
		const t = await seedTask(w.h.deps.db, p, "Login");
		const ref = `${p.key}-${t.number}`;
		const payload = push(`feature/${ref.toLowerCase()}-login`, [
			{ id: "1".repeat(40), message: `Fixes ${ref}: login form\n\nbody` },
		]);
		const res = await deliver(payload);
		expect(res.status).toBe(202);
		expect(res.json.outcome).toBe("ignored");
		const rows = await links(t.id);
		expect(rows.map((l) => [l.kind, l.state]).sort()).toEqual([
			["branch", "pushed"],
			["commit", "pushed"],
		]);
		expect(rows.find((l) => l.kind === "commit")).toMatchObject({
			title: `Fixes ${ref}: login form`,
			url: `https://git.example.com/${REPO}/commit/${"1".repeat(40)}`,
			author: "Ada",
		});
		expect(await statusOf(t.id)).toBe("backlog");

		// Redelivery: same rows, no second activity entry.
		await deliver(payload);
		expect((await links(t.id)).length).toBe(2);
		const activity = await w.h.deps.db
			.select()
			.from(workActivity)
			.where(
				and(eq(workActivity.taskId, t.id), eq(workActivity.kind, "git_linked")),
			);
		expect(activity.length).toBe(2);
	});

	test("a closing commit on the default branch closes the task once", async () => {
		const t = await seedTask(w.h.deps.db, p, "Checkout", "active");
		const ref = `${p.key}-${t.number}`;
		await deliver(
			push("main", [{ id: "2".repeat(40), message: `fixes ${ref}` }]),
		);
		expect(await statusOf(t.id)).toBe("done");
		const closed = await w.h.deps.db
			.select()
			.from(workActivity)
			.where(
				and(eq(workActivity.taskId, t.id), eq(workActivity.kind, "git_closed")),
			);
		expect(closed.length).toBe(1);
		expect(closed[0]?.data).toMatchObject({
			repo: REPO,
			ref: "2".repeat(40),
			author: "Ada",
		});
		await deliver(
			push("main", [{ id: "2".repeat(40), message: `fixes ${ref}` }]),
		);
		expect(
			(
				await w.h.deps.db
					.select()
					.from(workActivity)
					.where(
						and(
							eq(workActivity.taskId, t.id),
							eq(workActivity.kind, "git_closed"),
						),
					)
			).length,
		).toBe(1);
	});

	test("lowercase keys in commit messages and unknown keys link nothing", async () => {
		const t = await seedTask(w.h.deps.db, p, "Case");
		await deliver(
			push("dev", [
				{
					id: "3".repeat(40),
					message: `fixes ${p.key.toLowerCase()}-${t.number} and NOPE-${t.number}`,
				},
			]),
		);
		expect(await links(t.id)).toEqual([]);
	});

	test("pull requests: open links, merged into the default branch closes", async () => {
		const t = await seedTask(w.h.deps.db, p, "Search", "active");
		const ref = `${p.key}-${t.number}`;
		const base = {
			number: 7,
			title: "Search page",
			body: `Closes ${ref}`,
			head: "search",
		};
		await deliver(
			pr({ ...base, merged: false, state: "open", action: "opened" }),
			"pull_request",
		);
		expect((await links(t.id)).map((l) => [l.kind, l.ref, l.state])).toEqual([
			["pull_request", "7", "open"],
		]);
		expect(await statusOf(t.id)).toBe("active");
		await deliver(
			pr({ ...base, merged: true, state: "closed", action: "closed" }),
			"pull_request",
		);
		expect((await links(t.id)).map((l) => l.state)).toEqual(["merged"]);
		expect(await statusOf(t.id)).toBe("done");
	});

	test("a pull request merged into another branch does not close", async () => {
		const t = await seedTask(w.h.deps.db, p, "Other base", "active");
		const body = pr({
			number: 8,
			title: "x",
			body: `Fixes ${p.key}-${t.number}`,
			head: "y",
			merged: true,
			state: "closed",
			action: "closed",
		});
		body.pull_request.base.ref = "release";
		await deliver(body, "pull_request");
		expect(await statusOf(t.id)).toBe("active");
		expect((await links(t.id)).length).toBe(1);
	});

	test("visibility: ops readers get links, others counts only", async () => {
		const t = await seedTask(w.h.deps.db, p, "Visible");
		const ref = `${p.key}-${t.number}`;
		await deliver(
			push("feat", [
				{ id: "4".repeat(40), message: `${ref} secret deploy talk` },
			]),
		);
		await deliver(
			pr({
				number: 9,
				title: `${ref} wip`,
				body: "",
				head: "feat",
				merged: false,
				state: "open",
				action: "opened",
			}),
			"pull_request",
		);
		const full = await gitForTask(w.h.deps.db, t.id, true);
		expect(
			full && "links" in full && full.links.map((l) => l.title).sort(),
		).toEqual([`${ref} secret deploy talk`, `${ref} wip`]);
		const summary = await gitForTask(w.h.deps.db, t.id, false);
		expect(summary).toEqual({
			summary: { pullRequests: { open: 1, merged: 0 }, commits: 1 },
		});
		expect(JSON.stringify(summary)).not.toContain("secret");
		expect(
			await gitForTask(
				w.h.deps.db,
				(await seedTask(w.h.deps.db, p, "None")).id,
				true,
			),
		).toBeNull();
	});

	test("GET /tasks/:id: links for ops readers, counts for a work-only guest", async () => {
		const t = await seedTask(w.h.deps.db, p, "Sheet visibility");
		const ref = `${p.key}-${t.number}`;
		await deliver(
			push("feat", [{ id: "5".repeat(40), message: `${ref} deploy talk` }]),
		);
		const owner = await w.h.call("GET", `/api/work/tasks/${t.id}`, w.as());
		expect(owner.status).toBe(200);
		expect(owner.json.git.links.map((l: { title: string }) => l.title)).toEqual(
			[`${ref} deploy talk`],
		);
		const inv = await w.h.call("POST", `/api/work/projects/${p.id}/guests`, {
			...w.as(),
			body: { email: "gil@client.example" },
		});
		expect(inv.status).toBe(201);
		const guest = await acceptAs(
			w.h,
			{
				name: "Gil Guest",
				email: "gil@client.example",
				password: "gil password 123",
			},
			inv.json.invitationId,
		);
		const seen = await w.h.call("GET", `/api/work/tasks/${t.id}`, w.as(guest));
		expect(seen.status).toBe(200);
		expect(seen.json.git).toEqual({
			summary: { pullRequests: { open: 0, merged: 0 }, commits: 1 },
		});
	});

	test("a git close notifies the task's unmuted watchers", async () => {
		const t = await seedTask(w.h.deps.db, p, "Watched", "active");
		const ownerId = (await w.h.call("GET", "/api/me", w.as())).json.userId;
		await w.h.deps.db
			.insert(workTaskWatcher)
			.values({ taskId: t.id, userId: ownerId, reason: "manual" });
		await deliver(
			push("main", [
				{ id: "6".repeat(40), message: `Fixes ${p.key}-${t.number}` },
			]),
		);
		expect(await statusOf(t.id)).toBe("done");
		const notes = await w.h.deps.db
			.select()
			.from(workNotification)
			.where(eq(workNotification.taskId, t.id));
		expect(notes).toMatchObject([
			{ userId: ownerId, kind: "status_changed", actorId: null },
		]);
	});
});
