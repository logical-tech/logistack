import { DEFAULT_GIT_TRIGGER, decrypt, transition } from "@logistack/core";
import {
	deployment,
	environment,
	gitProvider,
	project,
	service,
	serviceGitTrigger,
} from "@logistack/db";
import {
	type ChecksSummary,
	type GitProvider,
	gitProviders,
	instantiate,
} from "@logistack/providers";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";
import type { DeploymentRow } from "./deploy.ts";
import { enqueueDeploy } from "./queues.ts";
import { publicAddress } from "./ssrf.ts";

export const CHECKS_POLL_MS = 20_000;
/** CI takes a moment to register its checks after a push; until then "no checks" means "not yet". */
export const NO_CHECKS_GRACE_MS = 2 * 60_000;

export type ChecksVerdict =
	| { event: "checks_passed" }
	| { event: "skip"; reason: string }
	| { wait: string };

/** Pure: what one poll of a commit's checks means for a deployment `ageMs` old. */
export function checksVerdict(
	read: ChecksSummary | { error: string },
	ageMs: number,
	timeoutMs: number,
): ChecksVerdict {
	const timedOut = ageMs >= timeoutMs;
	const minutes = Math.round(timeoutMs / 60_000);
	if ("error" in read)
		return timedOut
			? { event: "skip", reason: `Could not read checks: ${read.error}` }
			: { wait: `Could not read checks yet: ${read.error}` };
	switch (read.state) {
		case "failure":
			return {
				event: "skip",
				reason: `Checks failed: ${read.failed.join(", ")}`,
			};
		case "success":
			return { event: "checks_passed" };
		case "none":
			return ageMs >= Math.min(NO_CHECKS_GRACE_MS, timeoutMs)
				? { event: "checks_passed" }
				: { wait: "Waiting for checks to start" };
		case "pending":
			return timedOut
				? {
						event: "skip",
						reason: `Checks still running after ${minutes} min: ${read.pending.join(", ")}`,
					}
				: { wait: `Waiting on ${read.pending.join(", ")}` };
	}
}

type Waiting = {
	d: DeploymentRow;
	spec: typeof service.$inferSelect.spec;
	organizationId: string;
	timeoutMinutes: number | null;
};

/** Moves an awaiting deployment on, only if nobody else did first (cancel, another worker's poll). */
async function settle(
	ctx: Ctx,
	d: DeploymentRow,
	event: "checks_passed" | "skip" | "supersede",
	patch: Partial<Pick<DeploymentRow, "reason" | "finishedAt" | "supersededBy">>,
): Promise<boolean> {
	const r = transition("awaiting_checks", { type: event });
	if (!r.ok) return false;
	const rows = await ctx.db
		.update(deployment)
		.set({ status: r.state, ...patch })
		.where(
			and(eq(deployment.id, d.id), eq(deployment.status, "awaiting_checks")),
		)
		.returning({ id: deployment.id });
	return rows.length > 0;
}

async function readChecks(
	ctx: Ctx,
	w: Waiting,
	ref: string,
): Promise<ChecksSummary> {
	if (w.spec.kind !== "application" || w.spec.source.type !== "git")
		throw new Error("the service no longer builds from git");
	const { gitProviderId, repository } = w.spec.source;
	const [gp] = gitProviderId
		? await ctx.db
				.select()
				.from(gitProvider)
				.where(eq(gitProvider.id, gitProviderId))
		: [];
	if (!gp) throw new Error("the service has no git provider to ask");
	const provider = instantiate(
		gitProviders[gp.kind],
		JSON.parse(await decrypt(ctx.masterKey, gp.configEncrypted)),
		{
			// GitLab and Gitea live wherever the user said: refuse private addresses like a clone does.
			fetch: async (url, init) => {
				await publicAddress(ctx, new URL(url).hostname);
				return fetch(url, init);
			},
		},
	) as GitProvider;
	return provider.commitChecks(repository, ref);
}

async function pollOne(ctx: Ctx, w: Waiting, now: number) {
	const { d } = w;
	// A newer deployment builds the branch head anyway; this commit no longer matters.
	const [newer] = await ctx.db
		.select({ id: deployment.id })
		.from(deployment)
		.where(
			and(
				eq(deployment.serviceId, d.serviceId),
				gt(deployment.createdAt, d.createdAt),
				ne(deployment.status, "skipped"),
			),
		)
		.orderBy(desc(deployment.createdAt))
		.limit(1);
	if (newer) {
		await settle(ctx, d, "supersede", {
			supersededBy: newer.id,
			reason: null,
			finishedAt: new Date(),
		});
		return;
	}
	const ref = d.commitSha ?? d.gitRef;
	const read = ref
		? await readChecks(ctx, w, ref).catch((e: unknown) => ({
				error: e instanceof Error ? e.message : String(e),
			}))
		: { error: "the deployment names no commit or tag" };
	const verdict = checksVerdict(
		read,
		now - d.createdAt.getTime(),
		(w.timeoutMinutes ?? DEFAULT_GIT_TRIGGER.checksTimeoutMinutes) * 60_000,
	);
	if ("wait" in verdict) {
		if (verdict.wait !== d.reason)
			await ctx.db
				.update(deployment)
				.set({ reason: verdict.wait })
				.where(
					and(
						eq(deployment.id, d.id),
						eq(deployment.status, "awaiting_checks"),
					),
				);
		return;
	}
	if (verdict.event === "skip") {
		await settle(ctx, d, "skip", {
			reason: verdict.reason,
			finishedAt: new Date(),
		});
		return;
	}
	if (!(await settle(ctx, d, "checks_passed", { reason: null }))) return;
	await ctx.bus.publish(
		"deployment.queued",
		w.organizationId,
		{ type: "deployment", id: d.id },
		{ serviceId: d.serviceId, trigger: d.trigger, commitSha: d.commitSha },
	);
	await enqueueDeploy(ctx.queues, d.serviceId);
}

/**
 * The `checks` maintenance job: polls the provider for every deployment awaiting checks. Postgres
 * holds the state and every write is conditional on it, so a restart or a second worker only
 * repeats a read.
 */
export async function pollChecks(ctx: Ctx, now = Date.now()): Promise<void> {
	const waiting = await ctx.db
		.select({
			d: deployment,
			spec: service.spec,
			organizationId: project.organizationId,
			timeoutMinutes: serviceGitTrigger.checksTimeoutMinutes,
		})
		.from(deployment)
		.innerJoin(service, eq(service.id, deployment.serviceId))
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.leftJoin(
			serviceGitTrigger,
			eq(serviceGitTrigger.serviceId, deployment.serviceId),
		)
		.where(eq(deployment.status, "awaiting_checks"));
	for (const w of waiting)
		await pollOne(ctx, w, now).catch((e: unknown) =>
			log("warn", "checks poll failed", {
				deploymentId: w.d.id,
				error: e instanceof Error ? e.message : String(e),
			}),
		);
}
