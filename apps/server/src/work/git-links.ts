import type {
	WorkGitLinkKind,
	WorkGitLinkState,
	WorkTaskGit,
} from "@logistack/contracts";
import { applyStatusChange, parseWorkRefs } from "@logistack/core";
import {
	type Db,
	deployment,
	environment,
	project,
	service,
	workGitLink,
	workKeyAlias,
	workProject,
	workStatus,
	workTask,
	workTaskAlias,
	workTaskWatcher,
} from "@logistack/db";
import type { GitEvent } from "@logistack/providers";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../env.ts";
import { log } from "../log.ts";
import { type DbOrTx, publishWork, writeActivity } from "./context.ts";
import { notify } from "./notify.ts";
import { applyRecurrenceOnComplete } from "./recurrence.ts";

/**
 * Git integration (plan 12.4): commits, branches and pull requests that mention `KEY-n` link to
 * the task, and "Fixes KEY-n" closes it once it lands on the default branch. Runs beside the
 * deploy handling of a webhook and never affects its response.
 */

type Candidate = {
	key: string;
	number: number;
	closes: boolean;
	kind: WorkGitLinkKind;
	ref: string;
	title: string | null;
	url: string | null;
	state: WorkGitLinkState;
	author: string | null;
};

const firstLine = (s: string) => s.split("\n")[0]?.trim().slice(0, 300) || null;

/** Projects (with Work) that build from or list `repo` on this provider, with their keys and deploy branches. */
async function projectsForRepo(
	db: Db,
	provider: { id: string; organizationId: string },
	repo: string,
) {
	const lower = repo.toLowerCase();
	const viaServices = await db
		.select({
			projectId: environment.projectId,
			branch: sql<string | null>`${service.spec}->'source'->>'branch'`,
		})
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(
			and(
				eq(project.organizationId, provider.organizationId),
				sql`${service.spec}->'source'->>'type' = 'git'`,
				sql`${service.spec}->'source'->>'gitProviderId' = ${provider.id}`,
				sql`lower(${service.spec}->'source'->>'repository') = ${lower}`,
			),
		);
	const viaSettings = await db
		.select({ projectId: workProject.projectId })
		.from(workProject)
		.where(
			and(
				eq(workProject.organizationId, provider.organizationId),
				sql`exists (select 1 from jsonb_array_elements(${workProject.repos}) r where r->>'providerId' = ${provider.id} and lower(r->>'repo') = ${lower})`,
			),
		);
	const ids = [
		...new Set([...viaServices, ...viaSettings].map((r) => r.projectId)),
	];
	if (!ids.length) return { keys: new Map<string, string>(), branches: [] };
	const [own, aliases] = await Promise.all([
		db
			.select({ key: workProject.key, projectId: workProject.projectId })
			.from(workProject)
			.where(inArray(workProject.projectId, ids)),
		db
			.select({ key: workKeyAlias.key, projectId: workKeyAlias.projectId })
			.from(workKeyAlias)
			.where(
				and(
					eq(workKeyAlias.organizationId, provider.organizationId),
					inArray(workKeyAlias.projectId, ids),
				),
			),
	]);
	// Own keys win over aliases of other projects.
	const keys = new Map<string, string>();
	for (const r of [...aliases, ...own]) keys.set(r.key, r.projectId);
	return {
		keys,
		branches: viaServices.flatMap((r) => (r.branch ? [r.branch] : [])),
	};
}

/** Refs an event mentions; `closes` only where it lands on the default branch. */
export function candidates(
	event: GitEvent,
	keys: Iterable<string>,
	isDefault: (branch: string) => boolean,
): Candidate[] {
	const keyList = [...keys];
	const out: Candidate[] = [];
	if (event.kind === "push") {
		if (event.ref.kind !== "branch") return out;
		const onDefault = isDefault(event.ref.name);
		const commits = event.commits?.length
			? event.commits
			: event.commitSha
				? [
						{
							sha: event.commitSha,
							message: event.commitMessage,
							author: event.author,
						},
					]
				: [];
		for (const c of commits)
			for (const r of parseWorkRefs(c.message, keyList))
				out.push({
					...r,
					closes: r.closes && onDefault,
					kind: "commit",
					ref: c.sha,
					title: firstLine(c.message),
					url: "url" in c && c.url ? c.url : null,
					state: "pushed",
					author: c.author || null,
				});
		if (!onDefault)
			for (const r of parseWorkRefs(event.ref.name, keyList, {
				caseInsensitive: true,
			}))
				out.push({
					...r,
					closes: false,
					kind: "branch",
					ref: event.ref.name,
					title: event.ref.name,
					url: null,
					state: "pushed",
					author: event.author || null,
				});
		return out;
	}
	const pr = event.pr;
	const state: WorkGitLinkState =
		pr.state ??
		(pr.merged ? "merged" : pr.action === "closed" ? "closed" : "open");
	const mergedToDefault = state === "merged" && isDefault(event.branch);
	const text = `${event.commitMessage}\n${pr.body ?? ""}`;
	const seen = new Map<string, Candidate>();
	const refs = [
		...parseWorkRefs(text, keyList),
		...parseWorkRefs(pr.headBranch, keyList, { caseInsensitive: true }).map(
			(r) => ({ ...r, closes: false }),
		),
	];
	for (const r of refs) {
		const id = `${r.key}-${r.number}`;
		const prev = seen.get(id);
		seen.set(id, {
			...r,
			closes: (prev?.closes ?? false) || (r.closes && mergedToDefault),
			kind: "pull_request",
			ref: String(pr.number),
			title: firstLine(event.commitMessage),
			url: pr.url ?? null,
			state,
			author: event.author || null,
		});
	}
	return [...seen.values()];
}

async function resolveTask(db: Db, projectId: string, number: number) {
	const [own] = await db
		.select({ id: workTask.id })
		.from(workTask)
		.where(and(eq(workTask.projectId, projectId), eq(workTask.number, number)));
	if (own) return own.id;
	const [alias] = await db
		.select({ id: workTaskAlias.taskId })
		.from(workTaskAlias)
		.where(
			and(
				eq(workTaskAlias.projectId, projectId),
				eq(workTaskAlias.number, number),
			),
		);
	return alias?.id;
}

/**
 * Sets the closing status unless the task is already done or cancelled. Returns null when nothing
 * changed, else the next occurrence a recurring task got (or null in `next`).
 */
async function closeTask(
	db: Db,
	taskId: string,
	c: Candidate,
	repo: string,
): Promise<{ next: string | null } | null> {
	return db.transaction(async (tx) => {
		const [t] = await tx
			.select({
				projectId: workTask.projectId,
				recurrence: workTask.recurrence,
				completedAt: workTask.completedAt,
				category: workStatus.category,
				closingStatusId: workProject.closingStatusId,
			})
			.from(workTask)
			.innerJoin(workStatus, eq(workStatus.id, workTask.statusId))
			.innerJoin(workProject, eq(workProject.projectId, workTask.projectId))
			.where(eq(workTask.id, taskId))
			.for("update", { of: workTask });
		if (!t || t.category === "done" || t.category === "cancelled") return null;
		const statuses = await tx
			.select({ id: workStatus.id, category: workStatus.category })
			.from(workStatus)
			.where(eq(workStatus.projectId, t.projectId))
			.orderBy(asc(workStatus.position));
		const target =
			statuses.find((s) => s.id === t.closingStatusId) ??
			statuses.find((s) => s.category === "done");
		if (!target) return null;
		const now = new Date();
		await tx
			.update(workTask)
			.set({
				statusId: target.id,
				...applyStatusChange(t, { category: t.category }, target, now),
				updatedAt: now,
			})
			.where(eq(workTask.id, taskId));
		await writeActivity(tx, {
			taskId,
			actorId: null,
			kind: "git_closed",
			data: { repo, ref: c.ref, author: c.author },
		});
		return {
			next: await applyRecurrenceOnComplete(
				tx,
				{ id: taskId, recurrence: t.recurrence },
				t,
				target,
			),
		};
	});
}

/** Unmuted watchers hear that git closed the task. */
async function notifyClosed(
	deps: Deps,
	organizationId: string,
	projectId: string,
	taskId: string,
	repo: string,
) {
	const watchers = await deps.db
		.select({ userId: workTaskWatcher.userId })
		.from(workTaskWatcher)
		.where(
			and(eq(workTaskWatcher.taskId, taskId), eq(workTaskWatcher.muted, false)),
		);
	await notify(
		deps,
		watchers.map((w) => ({
			userId: w.userId,
			kind: "status_changed" as const,
			taskId,
			projectId,
			organizationId,
			actorId: null,
			data: { via: "git", repo },
		})),
	);
}

/** Links (and maybe closes) the tasks an authentic webhook event mentions. Idempotent on redelivery. */
export async function linkGitEvent(
	deps: Deps,
	provider: { id: string; organizationId: string },
	event: GitEvent,
): Promise<{ linked: number; closed: number }> {
	const { db } = deps;
	const { keys, branches } = await projectsForRepo(db, provider, event.repo);
	if (!keys.size) return { linked: 0, closed: 0 };
	// shortcut: without a default branch in the payload (Bitbucket), the services' deploy branches or main/master stand in.
	const isDefault = (b: string) =>
		event.defaultBranch
			? b === event.defaultBranch
			: branches.includes(b) || b === "main" || b === "master";
	let linked = 0;
	let closed = 0;
	const touched = new Map<string, Set<string>>();
	for (const c of candidates(event, keys.keys(), isDefault)) {
		const projectId = keys.get(c.key);
		if (!projectId) continue;
		const taskId = await resolveTask(db, projectId, c.number);
		if (!taskId) continue;
		const [row] = await db
			.insert(workGitLink)
			.values({
				taskId,
				providerId: provider.id,
				repo: event.repo,
				kind: c.kind,
				ref: c.ref,
				title: c.title,
				url: c.url,
				state: c.state,
				author: c.author,
			})
			.onConflictDoUpdate({
				target: [
					workGitLink.taskId,
					workGitLink.providerId,
					workGitLink.repo,
					workGitLink.kind,
					workGitLink.ref,
				],
				set: {
					title: c.title,
					url: sql`coalesce(excluded.url, ${workGitLink.url})`,
					state: c.state,
					author: sql`coalesce(excluded.author, ${workGitLink.author})`,
					updatedAt: new Date(),
				},
			})
			.returning({ inserted: sql<boolean>`xmax = 0` });
		if (row?.inserted) {
			linked++;
			await writeActivity(db, {
				taskId,
				actorId: null,
				kind: "git_linked",
				data: { kind: c.kind, repo: event.repo },
			});
		}
		const set = touched.get(projectId) ?? new Set();
		set.add(taskId);
		const done = c.closes ? await closeTask(db, taskId, c, event.repo) : null;
		if (done) {
			closed++;
			if (done.next) set.add(done.next);
			await notifyClosed(
				deps,
				provider.organizationId,
				projectId,
				taskId,
				event.repo,
			);
		}
		touched.set(projectId, set);
	}
	for (const [projectId, ids] of touched)
		publishWork(deps, {
			organizationId: provider.organizationId,
			projectId,
			entity: "task",
			op: "upsert",
			taskIds: [...ids],
			actorId: null,
		});
	return { linked, closed };
}

const pending = new Set<Promise<unknown>>();

/** Fire-and-forget from the webhook route: never throws, never delays the response. */
export function linkGitEventInBackground(
	deps: Deps,
	provider: { id: string; organizationId: string },
	event: GitEvent,
) {
	const p = linkGitEvent(deps, provider, event)
		.catch((error: unknown) =>
			log("error", "work git links failed", {
				providerId: provider.id,
				error: String(error),
			}),
		)
		.finally(() => pending.delete(p));
	pending.add(p);
}

/** Tests: waits for background link jobs started so far. */
export const settleGitLinks = () => Promise.all([...pending]);

/**
 * `git` for `GET /tasks/:id`: full links (and the first release) for actors that also hold `read`
 * on the project, else counts only (commit text can carry deploy talk). Null when nothing is linked.
 */
export async function gitForTask(
	db: DbOrTx,
	taskId: string,
	canReadOps: boolean,
): Promise<WorkTaskGit | null> {
	const links = await db
		.select()
		.from(workGitLink)
		.where(eq(workGitLink.taskId, taskId))
		.orderBy(desc(workGitLink.updatedAt));
	if (!links.length) return null;
	if (!canReadOps) {
		const prs = links.filter((l) => l.kind === "pull_request");
		return {
			summary: {
				pullRequests: {
					open: prs.filter((l) => l.state === "open").length,
					merged: prs.filter((l) => l.state === "merged").length,
				},
				commits: links.filter((l) => l.kind === "commit").length,
			},
		};
	}
	const shas = links.filter((l) => l.kind === "commit").map((l) => l.ref);
	let released: {
		deploymentId: string;
		serviceId: string;
		at: string;
	} | null = null;
	if (shas.length) {
		const [d] = await db
			.select({
				id: deployment.id,
				serviceId: deployment.serviceId,
				finishedAt: deployment.finishedAt,
			})
			.from(deployment)
			.innerJoin(service, eq(service.id, deployment.serviceId))
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(workTask, eq(workTask.projectId, environment.projectId))
			.where(
				and(
					eq(workTask.id, taskId),
					eq(deployment.status, "healthy"),
					inArray(deployment.commitSha, shas),
				),
			)
			.orderBy(asc(deployment.finishedAt))
			.limit(1);
		if (d?.finishedAt)
			released = {
				deploymentId: d.id,
				serviceId: d.serviceId,
				at: d.finishedAt.toISOString(),
			};
	}
	return {
		links: links.map((l) => ({
			id: l.id,
			taskId: l.taskId,
			providerId: l.providerId,
			repo: l.repo,
			kind: l.kind,
			ref: l.ref,
			title: l.title,
			url: l.url,
			state: l.state,
			author: l.author,
			createdAt: l.createdAt.toISOString(),
			updatedAt: l.updatedAt.toISOString(),
		})),
		released,
	};
}
