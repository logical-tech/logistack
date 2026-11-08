/**
 * GitOps: a project follows a manifest in a git repository. A push that touches the file reads it
 * at the pushed commit, plans it against the project and applies it (or only records the plan),
 * then deploys the services the apply changed. It reuses the git providers, the webhook, manifest
 * apply and its permission checks: the apply runs as a system actor holding `admin` on that
 * project only, so a manifest cannot reach anything outside it.
 */
import {
	DEFAULT_GIT_TRIGGER,
	evaluateTrigger,
	type Grant,
	type TriggerEvent,
} from "@logistack/core";
import {
	environment,
	type GitopsError,
	projectGitops,
	service,
} from "@logistack/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { type Actor, systemActor } from "./actor.ts";
import type { Deps } from "./env.ts";
import { Failure } from "./errors.ts";
import { connect, loadProvider } from "./git/providers.ts";
import { log } from "./log.ts";
import { applyManifest } from "./manifest.ts";
import { callAs } from "./migration/import.ts";
import { parseManifest } from "./routes/manifest.ts";

export type GitopsLink = typeof projectGitops.$inferSelect;

const MAX_MANIFEST = 1024 * 1024;

/** The audited actor of a GitOps apply; `refuseGitManaged` lets only it through. */
export const gitopsActorId = (projectId: string) => `gitops-${projectId}`;

/** A system actor with `admin` on the project and nothing else, on behalf of the org owner. */
export async function gitopsActor(
	deps: Deps,
	organizationId: string,
	projectId: string,
): Promise<Actor> {
	const id = gitopsActorId(projectId);
	const owner = await systemActor(deps.db, organizationId, id);
	if (!owner) throw new Failure("conflict", "the organization has no owner");
	const grants: Grant[] = [
		{ subjectId: id, scope: { kind: "project", id: projectId }, role: "admin" },
	];
	return { ...owner, grants };
}

type Source = Pick<
	GitopsLink,
	"gitProviderId" | "repository" | "branch" | "path"
>;

/** The manifest at `ref` of the linked repository, parsed; a 422 names what is wrong. */
export async function readGitManifest(
	deps: Deps,
	organizationId: string,
	src: Source,
	ref: string = src.branch,
) {
	const { row, config } = await loadProvider(
		deps.db,
		deps.masterKey,
		src.gitProviderId,
		organizationId,
	);
	let text: string;
	try {
		text = await (await connect(deps.db, row.kind, config)).readFile(
			src.repository,
			ref,
			src.path,
		);
	} catch (e) {
		throw new Failure(
			"unprocessable",
			`couldn't read ${src.repository}@${ref}:${src.path}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (text.length > MAX_MANIFEST)
		throw new Failure("unprocessable", `${src.path} is larger than 1 MB`);
	let manifest: ReturnType<typeof parseManifest>;
	try {
		manifest = parseManifest(text);
	} catch (e) {
		throw new Failure(
			"unprocessable",
			`${src.path}: ${(e as Error).message}`,
			e instanceof Failure ? e.details : undefined,
		);
	}
	if (manifest.kind !== "project")
		throw new Failure(
			"unprocessable",
			`${src.path} is an environment manifest; a project follows a project manifest (kind: project)`,
		);
	return manifest;
}

export type SyncResult = {
	projectId: string;
	status: NonNullable<GitopsLink["lastStatus"]>;
	commitSha: string | null;
	changes: number;
	deployments: string[];
	error?: GitopsError;
};

/**
 * Reads, plans and (with auto apply) applies the linked manifest, then deploys every running
 * service the apply touched. The outcome, failures included, is recorded on the link for the UI.
 */
export async function syncGitops(
	deps: Deps,
	link: GitopsLink,
	commitSha: string | null = null,
): Promise<SyncResult> {
	const base = { projectId: link.projectId, commitSha, deployments: [] };
	let result: SyncResult;
	try {
		const manifest = await readGitManifest(
			deps,
			link.organizationId,
			link,
			commitSha ?? link.branch,
		);
		const actor = await gitopsActor(deps, link.organizationId, link.projectId);
		const out = await applyManifest(
			deps,
			actor,
			{ type: "project", projectId: link.projectId, manifest },
			{ prune: link.prune, dryRun: !link.autoApply },
		);
		const deployments =
			out.applied && out.changes.length
				? await deployTouched(deps, actor, link.projectId, out.changes)
				: [];
		result = {
			...base,
			status: !out.changes.length
				? "unchanged"
				: out.applied
					? "applied"
					: "planned",
			changes: out.changes.length,
			deployments,
		};
	} catch (e) {
		const details =
			e instanceof Failure && e.details !== undefined
				? (Array.isArray(e.details) ? e.details : [e.details]).map((d) =>
						typeof d === "string" ? d : JSON.stringify(d),
					)
				: [];
		result = {
			...base,
			status: "failed",
			changes: 0,
			error: {
				at: new Date().toISOString(),
				commitSha,
				message: e instanceof Error ? e.message : String(e),
				details,
			},
		};
		log("warn", "gitops sync failed", {
			projectId: link.projectId,
			reason: result.error?.message,
		});
	}
	await deps.db
		.update(projectGitops)
		.set({
			lastCommitSha: commitSha ?? link.lastCommitSha,
			lastSyncedAt: new Date(),
			lastStatus: result.status,
			lastChanges: result.changes,
			lastError: result.error ?? null,
		})
		.where(eq(projectGitops.projectId, link.projectId));
	return result;
}

/**
 * Queues a deployment of each running service a change touched: the service itself, or every
 * service under a changed environment or project variable. Stack services are left to their
 * stack, which deploys what its own sync changed.
 */
async function deployTouched(
	deps: Deps,
	actor: Actor,
	projectId: string,
	changes: {
		resource: string;
		op: string;
		environment?: string;
		service?: string;
		name: string;
	}[],
) {
	const rows = await deps.db
		.select({ id: service.id, slug: service.slug, env: environment.slug })
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.where(
			and(
				eq(environment.projectId, projectId),
				eq(service.desiredState, "running"),
				isNull(service.stackId),
				isNull(environment.preview),
			),
		);
	const touched = new Set<string>();
	for (const c of changes) {
		if (c.op === "delete" && c.resource === "service") continue;
		const svc = c.service ?? (c.resource === "service" ? c.name : undefined);
		for (const r of rows) {
			const inEnv = !c.environment || r.env === c.environment;
			if (svc ? inEnv && r.slug === svc : c.resource === "variable" && inEnv)
				touched.add(r.id);
		}
	}
	const call = callAs(deps, actor);
	const ids: string[] = [];
	for (const id of touched)
		try {
			ids.push((await call("POST", `/services/${id}/deploy`)).id);
		} catch (e) {
			log("warn", "gitops deploy failed", { serviceId: id, error: String(e) });
		}
	return ids;
}

/** Every link that follows the pushed branch of this repository through this provider and whose file the push touched. */
export async function syncGitopsForPush(
	deps: Deps,
	providerId: string,
	organizationId: string,
	push: TriggerEvent & { repo: string; commitSha?: string | null },
) {
	const links = await deps.db
		.select()
		.from(projectGitops)
		.where(
			and(
				eq(projectGitops.organizationId, organizationId),
				eq(projectGitops.gitProviderId, providerId),
				sql`lower(${projectGitops.repository}) = ${push.repo.toLowerCase()}`,
			),
		);
	const results: SyncResult[] = [];
	for (const link of links) {
		const decision = evaluateTrigger(push, {
			...DEFAULT_GIT_TRIGGER,
			branch: link.branch,
			watchPaths: [link.path],
		});
		if (decision.action !== "deploy") continue;
		results.push(await syncGitops(deps, link, push.commitSha ?? null));
	}
	return results;
}
