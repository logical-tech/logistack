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
	previewHostname,
	previewSlug,
	previewUrls,
} from "@logistack/core";
import {
	deployment,
	domain,
	environment,
	instanceSettings,
	project,
	service,
	stack,
} from "@logistack/db";
import type { GitProvider, PullRequestEvent } from "@logistack/providers";
import { and, count, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { type Actor, systemActor } from "./actor.ts";
import type { Deps } from "./env.ts";
import { envelope } from "./events.ts";
import { log } from "./log.ts";
import { applyManifest, snapshot } from "./manifest.ts";
import { callAs } from "./migration/import.ts";
import { requestProxySync, requestReconcile } from "./redis.ts";

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

const chains = new Map<string, Promise<unknown>>();
// shortcut: serializes events of one pull request within this api process only; run several api replicas and two could race.
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
	chains.set(key, next);
	next
		.finally(() => chains.get(key) === next && chains.delete(key))
		.catch(() => {});
	return next;
}

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
		const followedStacks = settings.stacks.length
			? await db
					.select({ git: stack.git })
					.from(stack)
					.where(
						and(
							eq(stack.environmentId, settings.sourceEnvironmentId),
							inArray(stack.name, settings.stacks),
						),
					)
			: [];
		const sameRepo = (gitProviderId: string | undefined, repository: string) =>
			gitProviderId === provider.id &&
			repository.toLowerCase() === event.repo.toLowerCase();
		const fromRepo =
			followed.some(
				({ spec }) =>
					"source" in spec &&
					spec.source.type === "git" &&
					sameRepo(spec.source.gitProviderId, spec.source.repository),
			) ||
			followedStacks.some(
				({ git }) => git && sameRepo(git.gitProviderId, git.repository),
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
			await serialized(`${prj.id}:${event.pr.number}`, () =>
				closing
					? removePreview(deps, actor, prj.id, event.pr.number, provider, event)
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
		...(env.preview?.serviceUrls && { serviceUrls: env.preview.serviceUrls }),
		...(env.preview?.primaryUrl && { primaryUrl: env.preview.primaryUrl }),
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
	const whole = snap.manifest.environments.find((e) => e.slug === source.slug);
	if (!whole) return skipped("the source environment no longer exists");
	// Stacks own their services: the stack step below copies them, the manifest leaves them be.
	const [srcStacks, srcMembers, ownMembers] = await Promise.all([
		db
			.select()
			.from(stack)
			.where(eq(stack.environmentId, settings.sourceEnvironmentId)),
		stackMembers(deps, settings.sourceEnvironmentId),
		stackMembers(deps, envId),
	]);
	const from = {
		...whole,
		stacks: [],
		services: whole.services.filter(
			(s) => !srcMembers.some((m) => m.slug === s.slug),
		),
	};
	const have = snap.manifest.environments.find((e) => e.slug === slug);
	const [instance] = await db
		.select({ customWildcard: instanceSettings.customWildcard })
		.from(instanceSettings);
	const wildcard = instance?.customWildcard?.startsWith("*.")
		? instance.customWildcard.slice(2)
		: null;
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
		wildcard,
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
				environment: {
					...built.environment,
					stacks: have?.stacks ?? [],
					services: [
						...built.environment.services,
						...(have?.services ?? []).filter((s) =>
							ownMembers.some((m) => m.slug === s.slug),
						),
					],
				},
			}),
		},
		{ prune: true, dryRun: false },
	);

	const stacks = await previewStacks(deps, call, {
		envId,
		srcStacks,
		follow: settings.stacks,
		headBranch: event.pr.headBranch,
	});

	const svcs = await db
		.select()
		.from(service)
		.where(eq(service.environmentId, envId));
	const ids = svcs.map((s) => s.id);
	const hosts = ids.length
		? await db
				.select({
					serviceId: domain.serviceId,
					hostname: domain.hostname,
					pathPrefix: domain.pathPrefix,
					redirectTo: domain.redirectTo,
					isGenerated: domain.isGenerated,
				})
				.from(domain)
				.where(inArray(domain.serviceId, ids))
				.orderBy(domain.createdAt, domain.id)
		: [];
	const addDomain = async (
		serviceId: string,
		port: number,
		hostname: string | null,
	) =>
		hosts.push({
			pathPrefix: null,
			redirectTo: null,
			isGenerated: !hostname,
			...(await call<{ serviceId: string; hostname: string }>(
				"POST",
				hostname
					? `/services/${serviceId}/domains`
					: `/services/${serviceId}/domains/generated`,
				hostname ? { hostname, port, https: true, cert: "auto" } : { port },
			)),
		});
	for (const g of built.generated) {
		const s = svcs.find((x) => x.slug === g.service);
		if (s && !hosts.some((h) => h.serviceId === s.id))
			await addDomain(s.id, g.port, null);
	}
	// A stack service gets the domain its source counterpart has, on the preview's pattern.
	const exposed = await exposedPorts(deps, srcMembers);
	for (const s of svcs) {
		const port = s.stackId ? exposed.get(s.slug) : undefined;
		if (port === undefined || hosts.some((h) => h.serviceId === s.id)) continue;
		const host = settings.domainPattern
			? previewHostname(settings.domainPattern, {
					number: n,
					service: s.slug,
					wildcard,
				})
			: null;
		try {
			await addDomain(
				s.id,
				port,
				host && !hosts.some((h) => h.hostname === host) ? host : null,
			);
		} catch (e) {
			log("warn", "preview stack domain failed", {
				serviceId: s.id,
				error: String(e),
			});
		}
	}

	const urls = previewUrls(
		svcs.map((s) => ({
			slug: s.slug,
			domains: hosts.filter((h) => h.serviceId === s.id),
		})),
		[...settings.services, ...stacks.followedSlugs],
	);
	const urlsChanged =
		JSON.stringify(env.preview?.serviceUrls ?? {}) !==
		JSON.stringify(urls.serviceUrls);
	info.urls = urls.urls;
	info.serviceUrls = urls.serviceUrls;
	if (urls.primaryUrl) info.primaryUrl = urls.primaryUrl;
	else delete info.primaryUrl;
	if (Object.keys(stacks.errors).length) info.stackErrors = stacks.errors;
	else delete info.stackErrors;
	// Written before any deployment below is queued: the worker reads the URLs when it starts one.
	await db
		.update(environment)
		.set({ preview: info })
		.where(eq(environment.id, envId));

	// A stack deployment the worker already started read the URLs before they were final.
	const stale = new Set(
		stacks.queued.size && urlsChanged
			? (
					await db
						.select({ serviceId: deployment.serviceId })
						.from(deployment)
						.where(
							and(
								inArray(deployment.id, [...stacks.queued.values()]),
								ne(deployment.status, "queued"),
							),
						)
				).map((d) => d.serviceId)
			: [],
	);
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
	const deployments: string[] = [...stacks.queued.values()];
	for (const s of svcs) {
		if (s.spec.kind === "compose") continue;
		let follows: boolean;
		if (s.stackId) {
			if (stacks.queued.has(s.id) && !stale.has(s.id)) continue;
			// A sync redeploys what the compose file changed; the code of the others changed too.
			follows =
				stacks.followed.has(s.stackId) &&
				!stacks.queued.has(s.id) &&
				"source" in s.spec &&
				s.spec.source.type === "git";
			if (!follows && !(urlsChanged && deployed.has(s.id))) continue;
		} else {
			follows = settings.services.includes(s.slug);
			// The others start once, then only follow when the preview's URLs change.
			if (!follows && deployed.has(s.id) && !urlsChanged) continue;
		}
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

	const commentId = await comment(
		provider,
		event,
		previewComment(info, settings.ttlHours),
		info.commentId,
	);
	if (commentId && commentId !== info.commentId)
		await db
			.update(environment)
			.set({ preview: { ...info, commentId } })
			.where(eq(environment.id, envId));
	return {
		projectId,
		outcome: "updated",
		deployments,
		...(Object.keys(stacks.errors).length && {
			reason: Object.entries(stacks.errors)
				.map(([name, e]) => `stack ${name}: ${e}`)
				.join("; "),
		}),
	};
}

const stackMembers = (deps: Deps, environmentId: string) =>
	deps.db
		.select({ id: service.id, slug: service.slug, stackId: service.stackId })
		.from(service)
		.where(
			and(eq(service.environmentId, environmentId), isNotNull(service.stackId)),
		);

/** The port of each source stack service's first serving domain, by slug. */
async function exposedPorts(
	deps: Deps,
	members: { id: string; slug: string }[],
): Promise<Map<string, number>> {
	if (!members.length) return new Map();
	const rows = await deps.db
		.select({
			serviceId: domain.serviceId,
			port: domain.port,
			redirectTo: domain.redirectTo,
		})
		.from(domain)
		.where(
			inArray(
				domain.serviceId,
				members.map((m) => m.id),
			),
		)
		.orderBy(domain.createdAt, domain.id);
	const out = new Map<string, number>();
	for (const m of members) {
		const d = rows.find((r) => r.serviceId === m.id && !r.redirectTo);
		if (d) out.set(m.slug, d.port);
	}
	return out;
}

type StackRow = typeof stack.$inferSelect;
type StackOut = { services: { id: string; deploymentId: string | null }[] };

/**
 * Converges the preview's stacks to the source environment's: a missing one is created from the
 * source's compose file (a followed git stack from the pull request's branch), a followed one that
 * exists re-reads its compose file. One stack failing does not stop the others: its reason is
 * returned and, on a preview stack that exists, kept where the stack page shows it.
 */
async function previewStacks(
	deps: Deps,
	call: ReturnType<typeof callAs>,
	o: {
		envId: string;
		srcStacks: StackRow[];
		follow: readonly string[];
		headBranch: string;
	},
) {
	const own = await deps.db
		.select({ id: stack.id, name: stack.name })
		.from(stack)
		.where(eq(stack.environmentId, o.envId));
	/** Deployment the stack queued, by service id. */
	const queued = new Map<string, string>();
	const followed = new Set<string>();
	const followedSlugs: string[] = [];
	const errors: Record<string, string> = {};
	for (const src of o.srcStacks) {
		const follows =
			src.source === "git" && !!src.git && o.follow.includes(src.name);
		const existing = own.find((s) => s.name === src.name);
		try {
			let out: StackOut | null = null;
			if (!existing && src.source === "git" && src.git)
				out = await call<StackOut>(
					"POST",
					`/environments/${o.envId}/stacks/git`,
					{
						name: src.name,
						git: follows ? { ...src.git, branch: o.headBranch } : src.git,
					},
				);
			else if (!existing)
				out = await call<StackOut>("POST", `/environments/${o.envId}/stacks`, {
					name: src.name,
					composeYaml: src.composeYamlEncrypted
						? await decrypt(deps.masterKey, src.composeYamlEncrypted)
						: // A template stack keeps no file: its desired state written as compose is one.
							(
								await call<{ effectiveCompose: string }>(
									"GET",
									`/stacks/${src.id}`,
								)
							).effectiveCompose,
				});
			else if (follows)
				out = await call<StackOut>("POST", `/stacks/${existing.id}/sync`);
			for (const s of out?.services ?? [])
				if (s.deploymentId) queued.set(s.id, s.deploymentId);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			errors[src.name] = message;
			log("warn", "preview stack failed", { stack: src.name, error: message });
			if (existing)
				await deps.db
					.update(stack)
					.set({
						gitSyncError: {
							at: new Date().toISOString(),
							commitSha: null,
							message,
							details: [],
						},
					})
					.where(eq(stack.id, existing.id));
		}
	}
	if (o.follow.length) {
		const mine = await deps.db
			.select({ id: stack.id, name: stack.name })
			.from(stack)
			.where(
				and(
					eq(stack.environmentId, o.envId),
					inArray(stack.name, [...o.follow]),
				),
			);
		for (const s of mine) followed.add(s.id);
		if (mine.length)
			followedSlugs.push(
				...(
					await deps.db
						.select({ slug: service.slug })
						.from(service)
						.where(
							inArray(
								service.stackId,
								mine.map((s) => s.id),
							),
						)
						.orderBy(service.slug)
				).map((s) => s.slug),
			);
	}
	return { queued, followed, followedSlugs, errors };
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
