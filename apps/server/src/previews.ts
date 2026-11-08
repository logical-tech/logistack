/**
 * Pull request previews: a `preview` environment `pr-<n>` per pull request, cloned from the
 * project's source environment through the manifest apply path, as the system actor `previews`.
 * Every step converges, so a repeated or retried event lands in the same state.
 */
import {
	EnvironmentManifest,
	type PreviewInfo,
	PreviewSettings,
} from "@logistack/contracts";
import {
	decrypt,
	encrypt,
	previewEnvironment,
	previewSlug,
} from "@logistack/core";
import {
	deployment,
	domain,
	environment,
	instanceSettings,
	project,
	service,
} from "@logistack/db";
import type { GitProvider, PullRequestEvent } from "@logistack/providers";
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import { type Actor, systemActor } from "./actor.ts";
import { withLock } from "./cluster.ts";
import type { Deps } from "./env.ts";
import { envelope } from "./events.ts";
import { log } from "./log.ts";
import { applyManifest, snapshot } from "./manifest.ts";
import { callAs } from "./migration/import.ts";
import { redisFor, requestProxySync, requestReconcile } from "./redis.ts";

export const PREVIEW_ACTOR = "previews";

export const readSettings = async (deps: Deps, sealed: string) =>
	PreviewSettings.parse(JSON.parse(await decrypt(deps.masterKey, sealed)));

export const sealSettings = (deps: Deps, settings: PreviewSettings) =>
	encrypt(deps.masterKey, JSON.stringify(settings));

export type PreviewOutcome = {
	projectId: string;
	outcome: "updated" | "removed" | "skipped";
	reason?: string;
	deployments: string[];
};

type Provider = { id: string; organizationId: string; client?: GitProvider };

/** Creates, updates or removes the previews this pull request event addresses, project by project. */
export async function handlePullRequest(
	deps: Deps,
	provider: Provider,
	event: PullRequestEvent,
): Promise<PreviewOutcome[]> {
	const { db } = deps;
	const projects = await db
		.select()
		.from(project)
		.where(
			and(
				eq(project.organizationId, provider.organizationId),
				isNotNull(project.previewSettingsEncrypted),
			),
		);
	const out: PreviewOutcome[] = [];
	for (const prj of projects) {
		const settings = await readSettings(
			deps,
			prj.previewSettingsEncrypted as string,
		);
		const followed = await db
			.select({ spec: service.spec })
			.from(service)
			.where(
				and(
					eq(service.environmentId, settings.sourceEnvironmentId),
					inArray(service.slug, settings.services),
				),
			);
		const fromRepo = followed.some(
			({ spec }) =>
				"source" in spec &&
				spec.source.type === "git" &&
				spec.source.gitProviderId === provider.id &&
				spec.source.repository.toLowerCase() === event.repo.toLowerCase(),
		);
		if (!fromRepo) continue;
		const closing = event.pr.action === "closed";
		const skip = (reason: string) =>
			out.push({
				projectId: prj.id,
				outcome: "skipped",
				reason,
				deployments: [],
			});
		if (!closing && !settings.enabled) {
			skip("previews are turned off for this project");
			continue;
		}
		if (!closing && prj.archivedAt) {
			skip("the project is archived");
			continue;
		}
		if (!closing && event.pr.fromFork && !settings.allowForks) {
			skip(
				"pull requests from forks are not previewed: their code would run with the preview's secrets. Allow forks in the project's preview settings to change this",
			);
			continue;
		}
		const actor = await systemActor(db, prj.organizationId, PREVIEW_ACTOR);
		if (!actor) {
			skip("the organization has no owner to act for");
			continue;
		}
		out.push(
			await withLock(
				redisFor(deps.config.REDIS_URL),
				`ls:lock:preview:${prj.id}:${event.pr.number}`,
				() =>
					closing
						? removePreview(
								deps,
								actor,
								prj.id,
								event.pr.number,
								provider,
								event,
							)
						: upsertPreview(deps, actor, prj.id, settings, provider, event),
			),
		);
	}
	return out;
}

const managed = (projectId: string, number: number) =>
	and(
		eq(environment.projectId, projectId),
		eq(environment.slug, previewSlug(number)),
	);

async function comment(
	provider: Provider,
	event: PullRequestEvent,
	body: string,
	commentId: string | undefined,
): Promise<string | undefined> {
	if (!provider.client?.commentOnPullRequest) return commentId;
	try {
		return await provider.client.commentOnPullRequest(
			event.repo,
			event.pr.number,
			body,
			commentId,
		);
	} catch (e) {
		log("warn", "preview comment failed", {
			repo: event.repo,
			pr: event.pr.number,
			error: String(e),
		});
		return commentId;
	}
}

export function previewComment(info: PreviewInfo, ttlHours: number): string {
	const urls = info.urls.length
		? info.urls.map((u) => `- ${u}`).join("\n")
		: "- No service of this preview has a domain.";
	return [
		`**LogiStack preview** of \`${info.headSha.slice(0, 7)}\``,
		"",
		urls,
		"",
		`Removed when this pull request closes, or after ${ttlHours} hours without a new commit.`,
	].join("\n");
}

async function upsertPreview(
	deps: Deps,
	actor: Actor,
	projectId: string,
	settings: PreviewSettings,
	provider: Provider,
	event: PullRequestEvent,
): Promise<PreviewOutcome> {
	const { db } = deps;
	const n = event.pr.number;
	const slug = previewSlug(n);
	const skipped = (reason: string): PreviewOutcome => ({
		projectId,
		outcome: "skipped",
		reason,
		deployments: [],
	});
	const [source] = await db
		.select({ slug: environment.slug })
		.from(environment)
		.where(
			and(
				eq(environment.id, settings.sourceEnvironmentId),
				eq(environment.projectId, projectId),
			),
		);
	if (!source) return skipped("the source environment no longer exists");
	const call = callAs(deps, actor);
	let [env] = await db.select().from(environment).where(managed(projectId, n));
	if (env && !env.preview)
		return skipped(
			`environment ${slug} exists and is not a preview LogiStack manages`,
		);
	if (!env) {
		const [running] = await db
			.select({ n: count() })
			.from(environment)
			.where(
				and(
					eq(environment.projectId, projectId),
					isNotNull(environment.preview),
				),
			);
		if ((running?.n ?? 0) >= settings.maxPreviews)
			return skipped(
				`the project already runs ${settings.maxPreviews} previews, its limit`,
			);
		env = await call<typeof environment.$inferSelect>(
			"POST",
			`/projects/${projectId}/environments`,
			{ name: `PR #${n}`, slug, kind: "preview" },
		);
	}
	const envId = env.id;
	const info: PreviewInfo = {
		number: n,
		title: event.commitMessage.slice(0, 300),
		...(event.pr.url && { url: event.pr.url }),
		headBranch: event.pr.headBranch,
		headSha: event.commitSha,
		author: event.author,
		urls: env.preview?.urls ?? [],
		...(env.preview?.commentId && { commentId: env.preview.commentId }),
		expiresAt: new Date(
			Date.now() + settings.ttlHours * 3_600_000,
		).toISOString(),
	};
	// Marked managed before anything is applied, so a preview a crash leaves halfway still expires.
	await db
		.update(environment)
		.set({ preview: info })
		.where(eq(environment.id, envId));

	const snap = await snapshot(deps, actor.organizationId, projectId, true);
	const from = snap.manifest.environments.find((e) => e.slug === source.slug);
	if (!from) return skipped("the source environment no longer exists");
	const [instance] = await db
		.select({ customWildcard: instanceSettings.customWildcard })
		.from(instanceSettings);
	const built = previewEnvironment(from, {
		number: n,
		headBranch: event.pr.headBranch,
		follow: settings.services,
		variables: settings.variables.map((v) => ({
			key: v.key,
			value: v.value ?? "",
			secret: v.secret,
		})),
		domainPattern: settings.domainPattern,
		wildcard: instance?.customWildcard?.startsWith("*.")
			? instance.customWildcard.slice(2)
			: null,
	});
	await applyManifest(
		deps,
		actor,
		{
			type: "environment",
			projectId,
			slug,
			manifest: EnvironmentManifest.parse({
				version: 1,
				kind: "environment",
				environment: built.environment,
			}),
		},
		{ prune: true, dryRun: false },
	);

	const svcs = await db
		.select()
		.from(service)
		.where(eq(service.environmentId, envId));
	const ids = svcs.map((s) => s.id);
	const hosts = ids.length
		? await db
				.select({ serviceId: domain.serviceId, hostname: domain.hostname })
				.from(domain)
				.where(inArray(domain.serviceId, ids))
		: [];
	for (const g of built.generated) {
		const s = svcs.find((x) => x.slug === g.service);
		if (s && !hosts.some((h) => h.serviceId === s.id))
			hosts.push(
				await call<{ serviceId: string; hostname: string }>(
					"POST",
					`/services/${s.id}/domains/generated`,
					{ port: g.port },
				),
			);
	}

	const deployed = new Set(
		ids.length
			? (
					await db
						.selectDistinct({ id: deployment.serviceId })
						.from(deployment)
						.where(inArray(deployment.serviceId, ids))
				).map((d) => d.id)
			: [],
	);
	const deployments: string[] = [];
	for (const s of svcs) {
		const follows = settings.services.includes(s.slug);
		// Stacks deploy their own services; the others start once, then only followed ones follow the pull request.
		if (s.stackId || s.spec.kind === "compose") continue;
		if (!follows && deployed.has(s.id)) continue;
		const [d] = await db
			.insert(deployment)
			.values({
				serviceId: s.id,
				trigger: follows ? "git_push" : "api",
				...(follows && {
					commitSha: event.commitSha,
					commitMessage: event.commitMessage.slice(0, 500),
				}),
			})
			.returning({ id: deployment.id });
		if (!d) continue;
		deployments.push(d.id);
		await deps.bus.publishEvent(
			envelope(
				"deployment.queued",
				actor.organizationId,
				{ type: "deployment", id: d.id },
				{
					serviceId: s.id,
					trigger: follows ? "git_push" : "api",
					...(follows && { commitSha: event.commitSha, author: event.author }),
				},
			),
		);
	}

	info.urls = [...new Set(hosts.map((h) => `https://${h.hostname}`))].sort();
	const commentId = await comment(
		provider,
		event,
		previewComment(info, settings.ttlHours),
		info.commentId,
	);
	await db
		.update(environment)
		.set({ preview: { ...info, ...(commentId && { commentId }) } })
		.where(eq(environment.id, envId));
	return { projectId, outcome: "updated", deployments };
}

/** Deletes a preview and, through the reconciler's label sweep, everything it ran. Idempotent. */
export async function removePreview(
	deps: Deps,
	actor: Actor,
	projectId: string,
	number: number,
	provider?: Provider,
	event?: PullRequestEvent,
): Promise<PreviewOutcome> {
	const [env] = await deps.db
		.select()
		.from(environment)
		.where(and(managed(projectId, number), isNotNull(environment.preview)));
	if (!env?.preview)
		return {
			projectId,
			outcome: "skipped",
			reason: "no preview to remove",
			deployments: [],
		};
	await callAs(deps, actor)("DELETE", `/environments/${env.id}`);
	await Promise.all([
		requestReconcile(deps.config.REDIS_URL, "preview removed"),
		requestProxySync(deps.config.REDIS_URL, "preview removed"),
	]).catch(() => {});
	if (provider && event && env.preview.commentId)
		await comment(
			provider,
			event,
			"**LogiStack preview** removed: the pull request was closed.",
			env.preview.commentId,
		);
	return { projectId, outcome: "removed", deployments: [] };
}
