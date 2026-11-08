import { posix } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import {
	type ApplicationSource,
	type BuildConfig,
	defaultServiceIcon,
	type ServiceIcon,
	ServiceSpec,
	StackGitSource,
	StackSource,
} from "@logistack/contracts";
import {
	DEFAULT_GIT_TRIGGER,
	decrypt,
	diffStack,
	encrypt,
	evaluateTrigger,
	newId,
	patchSpec,
	planTemplate,
	type Resource,
	type StackDelta,
	StackUpdateError,
	secretExpressions,
	type TemplateEnvEntry,
	type TemplateMount,
	type TemplateServicePlan,
	type TriggerEvent,
} from "@logistack/core";
import {
	type Db,
	deployment,
	domain,
	environment,
	envVar,
	mount,
	project,
	service,
	stack,
} from "@logistack/db";
import { type ComposeBuild, fromCompose, Skip } from "@logistack/templates";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, one } from "../errors.ts";
import { envelope } from "../events.ts";
import { connect, loadProvider } from "../git/providers.ts";
import { guardHostSettings } from "../host-settings.ts";
import { log } from "../log.ts";
import {
	body,
	errors,
	IdParam,
	json,
	router,
	Slug,
	security,
} from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import {
	actorCan,
	byParam,
	check,
	refuseArchived,
	requirePermission,
} from "../scope.ts";
import { MASKED, stackCompose } from "../stack-compose.ts";
import { listServices, ServiceListItem } from "./services.ts";

const tags = ["stacks"];

const Stack = z
	.object({
		id: z.string(),
		environmentId: z.string(),
		name: z.string(),
		source: StackSource,
		templateId: z.string().nullable(),
		/** Where the compose file lives, for a git stack. */
		git: StackGitSource.nullable(),
		/** Why the last push to a git stack was not applied; null once one applies. */
		gitSyncError: z
			.object({
				at: z.string(),
				commitSha: z.string().nullable(),
				message: z.string(),
				details: z.array(z.string()),
			})
			.nullable(),
		createdBy: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi("Stack");

const StackDetail = Stack.extend({
	/** The compose file as pasted; null for a template stack or without `read:secrets`. */
	composeYaml: z.string().nullable(),
	/** True when the stack has a compose file the caller may not read. */
	composeHidden: z.boolean(),
	/** Desired state written as compose; secrets masked without `read:secrets`. */
	effectiveCompose: z.string(),
	services: z.array(ServiceListItem),
}).openapi("StackDetail");

export const DeployedService = z.object({
	id: z.string(),
	name: z.string(),
	kind: z.enum(["application", "database"]),
	/** null for a service deployed before; poll its deployments instead. */
	deploymentId: z.string().nullable(),
	hostname: z.string().nullable(),
});

const StackCreated = z
	.object({
		stackId: z.string(),
		name: z.string(),
		services: z.array(DeployedService),
	})
	.openapi("StackCreated");

const ComposeInput = z.object({
	/** The stack's name; its services take the compose service names. */
	name: Slug,
	composeYaml: z
		.string()
		.min(1)
		.max(256 * 1024),
});

/** A pasted compose has no secret inputs: credentials are told apart by name or URL userinfo. */
export const looksSecret = (key: string, value: string) =>
	/PASS|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|AUTH/i.test(key) ||
	/:\/\/[^/\s:@]+:[^@\s]+@/.test(value);

const stackColumns = {
	id: stack.id,
	environmentId: stack.environmentId,
	name: stack.name,
	source: stack.source,
	templateId: stack.templateId,
	git: stack.git,
	gitSyncError: stack.gitSyncError,
	createdBy: stack.createdBy,
	createdAt: stack.createdAt,
	updatedAt: stack.updatedAt,
};

type Planned = {
	plan: TemplateServicePlan;
	id: string;
	icon: ServiceIcon | null;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Writes one stack service with its env vars, mounts and domain, and queues its first deployment. */
async function insertMember(
	tx: Tx,
	masterKey: CryptoKey,
	s: Planned & {
		environmentId: string;
		stackId: string;
		nodeId: string | null;
		createdBy: string | null;
		importedFrom: string | null;
		isGenerated: (hostname: string) => boolean;
		trigger: "manual" | "api" | "git_push";
		commitSha?: string | null;
	},
): Promise<string> {
	const p = s.plan;
	await tx.insert(service).values({
		id: s.id,
		environmentId: s.environmentId,
		stackId: s.stackId,
		name: p.name,
		slug: p.name,
		kind: p.spec.kind,
		spec: p.spec,
		nodeId: s.nodeId,
		createdBy: s.createdBy,
		importedFrom: s.importedFrom,
		icon: defaultServiceIcon(p.spec) ?? s.icon,
	});
	await writeEnv(tx, masterKey, s.id, p.env);
	await writeMounts(tx, masterKey, s.id, p.mounts);
	if (p.domain)
		await tx.insert(domain).values({
			serviceId: s.id,
			hostname: p.domain.hostname,
			port: p.domain.port,
			isGenerated: s.isGenerated(p.domain.hostname),
		});
	return one(
		await tx
			.insert(deployment)
			.values({
				serviceId: s.id,
				trigger: s.trigger,
				commitSha: s.commitSha ?? null,
			})
			.returning({ id: deployment.id }),
	).id;
}

async function writeEnv(
	tx: Tx,
	masterKey: CryptoKey,
	serviceId: string,
	env: TemplateEnvEntry[],
) {
	if (env.length)
		await tx.insert(envVar).values(
			await Promise.all(
				env.map(async (e) => ({
					scope: "service" as const,
					scopeId: serviceId,
					key: e.key,
					valueEncrypted: await encrypt(masterKey, e.value),
					isSecret: e.isSecret,
				})),
			),
		);
}

async function writeMounts(
	tx: Tx,
	masterKey: CryptoKey,
	serviceId: string,
	mounts: TemplateMount[],
) {
	for (const m of mounts)
		await tx.insert(mount).values({
			serviceId,
			kind: m.kind,
			target: m.target,
			readOnly: m.readOnly,
			...(m.kind === "volume"
				? { volumeName: m.volumeName }
				: { contentEncrypted: await encrypt(masterKey, m.content) }),
		});
}

/**
 * Creates a stack and every service of `services` (dependencies first) with their env vars,
 * volumes, files and domain in one transaction, then queues a deployment per service.
 * A slug already taken in the environment is a 409.
 */
export async function createStack(
	c: Context<Env>,
	input: {
		environmentId: string;
		name: string;
		source: StackSource;
		templateId?: string;
		composeYaml?: string;
		git?: StackGitSource;
		services: Planned[];
		/** Hostnames LogiStack generated, as opposed to ones the user typed. */
		generated?: Set<string>;
		/** `imported_from` of each service. */
		provenance?: (name: string) => string;
	},
) {
	const actor = requireActor(c);
	await refuseArchived(c);
	const { db, masterKey, config } = c.var.deps;
	const taken = await db
		.select({ slug: service.slug })
		.from(service)
		.where(
			and(
				eq(service.environmentId, input.environmentId),
				inArray(
					service.slug,
					input.services.map((s) => s.plan.name),
				),
			),
		);
	if (taken.length)
		throw new Failure(
			"conflict",
			`this environment already has services named ${taken.map((s) => s.slug).join(", ")}; deploy into another environment`,
			{ conflicts: taken.map((s) => s.slug) },
		);
	const nodeIds = new Map<string, string | null | undefined>();
	for (const s of input.services)
		nodeIds.set(
			s.plan.name,
			await guardHostSettings(c, { spec: s.plan.spec, nodeId: null }),
		);

	const trigger = actor.kind === "user" ? "manual" : "api";
	const { stackId, created } = await db.transaction(async (tx) => {
		const row = one(
			await tx
				.insert(stack)
				.values({
					environmentId: input.environmentId,
					name: input.name,
					source: input.source,
					templateId: input.templateId ?? null,
					composeYamlEncrypted: input.composeYaml
						? await encrypt(masterKey, input.composeYaml)
						: null,
					git: input.git ?? null,
					createdBy: actor.userId,
				})
				.returning({ id: stack.id }),
		);
		const out: (Planned & { deploymentId: string })[] = [];
		for (const s of input.services)
			out.push({
				...s,
				deploymentId: await insertMember(tx, masterKey, {
					...s,
					environmentId: input.environmentId,
					stackId: row.id,
					nodeId: nodeIds.get(s.plan.name) ?? null,
					createdBy: actor.userId,
					importedFrom: input.provenance?.(s.plan.name) ?? null,
					isGenerated: (h) => input.generated?.has(h) ?? false,
					trigger,
				}),
			});
		return { stackId: row.id, created: out };
	});

	for (const s of created)
		await c.var.deps.bus.publishEvent(
			envelope(
				"deployment.queued",
				actor.organizationId,
				{ type: "deployment", id: s.deploymentId },
				{ serviceId: s.id, trigger },
			),
		);
	if (created.some((s) => s.plan.domain))
		await requestProxySync(config.REDIS_URL, "stack created").catch(
			(err: unknown) =>
				log("warn", "proxy sync request failed", { error: String(err) }),
		);
	return {
		stackId,
		services: created.map((s) => ({
			id: s.id,
			name: s.plan.name,
			kind: s.plan.spec.kind as "application" | "database",
			deploymentId: s.deploymentId,
			hostname: s.plan.domain?.hostname ?? null,
		})),
	};
}

const UNSUPPORTED = "the compose file uses features LogiStack cannot run";

/** Pure: a compose `build:` as a dockerfile build of the stack's repository, or why it cannot be. */
export function composeBuild(
	b: ComposeBuild,
	git: StackGitSource,
): { source: ApplicationSource; build: BuildConfig } | string {
	const dir = posix.dirname(git.composePath);
	const context = posix.normalize(posix.join(dir, b.context));
	const dockerfilePath = posix.normalize(posix.join(context, b.dockerfile));
	const outside = (p: string) => p === ".." || p.startsWith("../");
	if (
		b.dockerfile.startsWith("/") ||
		outside(context) ||
		outside(dockerfilePath)
	)
		return `build context ${b.context} and dockerfile ${b.dockerfile} must stay inside the repository`;
	const secret = Object.entries(b.args).find(([k, v]) => looksSecret(k, v));
	if (secret)
		return `build arg ${secret[0]} looks like a secret: build args are visible in the image history; drop it and add a build-time secret variable on the service`;
	return {
		source: {
			type: "git",
			gitProviderId: git.gitProviderId,
			repository: git.repository,
			branch: git.branch,
			path: ".",
		},
		build: {
			type: "dockerfile",
			context,
			dockerfilePath,
			...(b.target && { target: b.target }),
			...(Object.keys(b.args).length && { buildArgs: b.args }),
		},
	};
}

/**
 * A user's compose file as service plans; a 400 listing every part LogiStack cannot run.
 * Credentials are told apart by name or URL userinfo, since a pasted compose has no secret inputs.
 * With `git`, a `build:` service becomes an application built from that repository.
 */
function composePlan(
	yaml: string,
	git?: StackGitSource | null,
): TemplateServicePlan[] {
	const builds = git ? new Map<string, ComposeBuild>() : undefined;
	let plans: TemplateServicePlan[];
	try {
		plans = planTemplate(
			{ inputs: [], services: fromCompose(yaml, builds) },
			{},
		);
	} catch (e) {
		if (e instanceof Skip)
			throw new Failure(
				"validation_failed",
				UNSUPPORTED,
				e.reasons.map((r) =>
					r.code === "build" && !git
						? `${r.detail}: building needs a stack deployed from a git repository`
						: r.detail,
				),
			);
		throw new Failure("validation_failed", (e as Error).message);
	}
	const problems: string[] = [];
	const out = plans.map((p) => {
		const env = p.env.map((e) => ({
			...e,
			// A `${{ secrets.KEY }}` value is a reference, resolved at deploy: stored plain, never as a secret.
			isSecret:
				!secretExpressions(e.value).length &&
				(e.isSecret || looksSecret(e.key, e.value)),
		}));
		const b = builds?.get(p.name);
		if (!b || !git || p.spec.kind !== "application") return { ...p, env };
		const built = composeBuild(b, git);
		if (typeof built === "string") {
			problems.push(`services.${p.name}: ${built}`);
			return { ...p, env };
		}
		return { ...p, env, spec: { ...p.spec, ...built } };
	});
	if (problems.length)
		throw new Failure("validation_failed", UNSUPPORTED, problems);
	return out;
}

const StackChange = z
	.object({
		/** The compose service name, which is the LogiStack service slug. */
		service: z.string(),
		op: z.enum(["create", "update", "remove"]),
		/** One line each, such as "image nginx:1.28 → nginx:1.29"; never a secret value. */
		changes: z.array(z.string()),
	})
	.openapi("StackChange");

const StackUpdated = z
	.object({
		changes: z.array(StackChange),
		/** Services created or changed, each with the deployment queued for it. */
		services: z.array(DeployedService),
	})
	.openapi("StackUpdated");

const NewCompose = z.object({ composeYaml: ComposeInput.shape.composeYaml });

/** Who applies a compose change: a request's actor, or a push to a git stack's branch. */
type Applier = {
	organizationId: string;
	userId: string | null;
	trigger: "manual" | "api" | "git_push";
	commitSha?: string | null;
};

export function applierOf(c: Context<Env>): Applier {
	const actor = requireActor(c);
	return {
		organizationId: actor.organizationId,
		userId: actor.userId,
		trigger: actor.kind === "user" ? "manual" : "api",
	};
}

const MAX_COMPOSE = 256 * 1024;

/** The compose file of a git stack at `ref`; a 422 when the provider cannot serve it. */
export async function readGitCompose(
	db: Db,
	masterKey: CryptoKey,
	git: StackGitSource,
	organizationId: string,
	ref: string = git.branch,
): Promise<string> {
	const { row, config } = await loadProvider(
		db,
		masterKey,
		git.gitProviderId,
		organizationId,
	);
	let yaml: string;
	try {
		yaml = await (await connect(db, row.kind, config)).readFile(
			git.repository,
			ref,
			git.composePath,
		);
	} catch (e) {
		throw new Failure(
			"unprocessable",
			`couldn't read ${git.repository}@${ref}:${git.composePath}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (yaml.length > MAX_COMPOSE)
		throw new Failure(
			"unprocessable",
			`${git.composePath} is larger than 256 KB`,
		);
	return yaml;
}

/**
 * Re-syncs every git stack that follows the pushed branch through this provider, reading the
 * compose file at the pushed commit. One stack failing (unreadable file, unsupported compose)
 * does not stop the others; its reason is returned.
 */
export async function syncGitStacks(
	c: Context<Env>,
	providerId: string,
	organizationId: string,
	push: TriggerEvent & { repo: string; commitSha?: string | null },
) {
	const { db, masterKey } = c.var.deps;
	const rows = await db
		.select({ id: stack.id, name: stack.name, git: stack.git })
		.from(stack)
		.innerJoin(environment, eq(environment.id, stack.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(
			and(
				eq(project.organizationId, organizationId),
				eq(stack.source, "git"),
				sql`${stack.git}->>'gitProviderId' = ${providerId}`,
			),
		);
	const deployments: { id: string; serviceId: string }[] = [];
	const failures: string[] = [];
	for (const { id, name, git } of rows) {
		if (!git || git.repository.toLowerCase() !== push.repo.toLowerCase())
			continue;
		const decision = evaluateTrigger(push, {
			...DEFAULT_GIT_TRIGGER,
			branch: git.branch,
			watchPaths: [],
		});
		if (decision.action !== "deploy") continue;
		try {
			const yaml = await readGitCompose(
				db,
				masterKey,
				git,
				organizationId,
				push.commitSha ?? git.branch,
			);
			const out = await updateStack(c, id, yaml, {
				dryRun: false,
				source: "git",
				by: {
					organizationId,
					userId: null,
					trigger: "git_push",
					commitSha: push.commitSha ?? null,
				},
			});
			for (const s of out.services)
				if (s.deploymentId)
					deployments.push({ id: s.deploymentId, serviceId: s.id });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			const reason = `stack ${name}: ${message}`;
			log("warn", "git stack sync failed", { stackId: id, reason });
			failures.push(reason);
			const details =
				e instanceof Failure && Array.isArray(e.details)
					? e.details.map(String)
					: [];
			await db
				.update(stack)
				.set({
					gitSyncError: {
						at: new Date().toISOString(),
						commitSha: push.commitSha ?? null,
						message,
						details,
					},
				})
				.where(eq(stack.id, id));
		}
	}
	return { deployments, failures };
}

/** A stack's services and their desired state written as compose; secrets masked unless `secrets`. */
async function effectiveOf(
	db: Pick<Db, "select" | "selectDistinctOn">,
	masterKey: Parameters<typeof decrypt>[0],
	stackId: string,
	secrets: boolean,
) {
	const services = await listServices(db, eq(service.stackId, stackId));
	const ids = services.map((s) => s.id);
	const [vars, mounts] = ids.length
		? await Promise.all([
				db
					.select()
					.from(envVar)
					.where(and(eq(envVar.scope, "service"), inArray(envVar.scopeId, ids)))
					.orderBy(asc(envVar.key)),
				db
					.select()
					.from(mount)
					.where(and(eq(mount.kind, "volume"), inArray(mount.serviceId, ids))),
			])
		: [[], []];
	const effectiveCompose = stackCompose(
		await Promise.all(
			services.map(async (s) => ({
				slug: s.slug,
				spec: s.spec,
				env: await Promise.all(
					vars
						.filter((v) => v.scopeId === s.id)
						.map(async (v) => ({
							key: v.key,
							value:
								v.isSecret && !secrets
									? null
									: await decrypt(masterKey, v.valueEncrypted),
						})),
				),
				volumes: mounts
					.filter((m) => m.serviceId === s.id && m.volumeName)
					.map((m) => ({
						name: m.volumeName as string,
						target: m.target,
						readOnly: m.readOnly,
					})),
				domains: s.domains,
			})),
		),
	);
	return { services, effectiveCompose };
}

/**
 * Converges a stack's services to `yaml`, or with `dryRun` only reports what that would do.
 * `source` is where the file comes from and must match the stack's: a user edits a compose stack,
 * a push or sync updates a git stack. The stack row is locked, so concurrent updates apply one
 * after the other, each against the compose the previous one stored. Created and changed services
 * each get a deployment.
 */
export async function updateStack(
	c: Context<Env>,
	stackId: string,
	yaml: string,
	o: { dryRun: boolean; source: "compose" | "git"; by: Applier },
) {
	const { db, masterKey, config } = c.var.deps;
	const { trigger } = o.by;
	const result = await db.transaction(async (tx) => {
		const row = one(
			await tx.select().from(stack).where(eq(stack.id, stackId)).for("update"),
			"stack",
		);
		// A template stack takes its first compose file from the user; it is a compose stack after.
		const fromTemplate = row.source === "template" && o.source === "compose";
		if (row.source !== o.source && !fromTemplate)
			throw new Failure(
				"bad_request",
				row.source === "git"
					? "this stack follows its git repository: push the change, or sync it"
					: o.source === "git"
						? "this stack does not follow a git repository"
						: "only a stack deployed from a compose file takes a new one",
			);
		const after = composePlan(yaml, row.git);
		const masked = after.flatMap((p) =>
			p.env.filter((e) => e.value === MASKED).map((e) => `${p.name}: ${e.key}`),
		);
		if (masked.length)
			throw new Failure(
				"validation_failed",
				`replace ${MASKED} with the real value`,
				masked,
			);
		// Without a stored file the baseline is what runs now, so only the lines the user edited change.
		const before = row.composeYamlEncrypted
			? composePlan(await decrypt(masterKey, row.composeYamlEncrypted), row.git)
			: fromTemplate
				? composePlan(
						(await effectiveOf(tx, masterKey, stackId, true)).effectiveCompose,
						null,
					)
				: [];
		const members = await tx
			.select({
				id: service.id,
				slug: service.slug,
				kind: service.kind,
				spec: service.spec,
				nodeId: service.nodeId,
			})
			.from(service)
			.where(eq(service.stackId, stackId));
		const bySlug = new Map(members.map((m) => [m.slug, m]));
		let delta: StackDelta[];
		try {
			delta = diffStack(before, after, bySlug);
		} catch (e) {
			if (e instanceof StackUpdateError)
				throw new Failure("validation_failed", e.message);
			throw e;
		}
		if (o.dryRun) return { delta, deployed: [] };

		const creates = delta.filter((d) => d.op === "create");
		if (creates.length) {
			const taken = await tx
				.select({ slug: service.slug })
				.from(service)
				.where(
					and(
						eq(service.environmentId, row.environmentId),
						inArray(
							service.slug,
							creates.map((d) => d.name),
						),
					),
				);
			if (taken.length)
				throw new Failure(
					"conflict",
					`this environment already has services named ${taken.map((s) => s.slug).join(", ")} outside the stack`,
					{ conflicts: taken.map((s) => s.slug) },
				);
		}
		const deployed: {
			id: string;
			name: string;
			kind: ServiceSpec["kind"];
			deploymentId: string;
		}[] = [];
		for (const d of delta) {
			const m = bySlug.get(d.name);
			if (d.op === "remove") {
				if (m) await tx.delete(service).where(eq(service.id, m.id));
				continue;
			}
			if (d.op === "create") {
				const id = newId("svc");
				const nodeId = await guardHostSettings(c, {
					spec: d.plan.spec,
					nodeId: null,
				});
				const deploymentId = await insertMember(tx, masterKey, {
					plan: d.plan,
					id,
					icon: null,
					environmentId: row.environmentId,
					stackId,
					nodeId: nodeId ?? null,
					createdBy: o.by.userId,
					importedFrom: null,
					isGenerated: () => false,
					trigger,
					commitSha: o.by.commitSha ?? null,
				});
				deployed.push({
					id,
					name: d.name,
					kind: d.plan.spec.kind,
					deploymentId,
				});
				continue;
			}
			if (!m) continue;
			const parsed = ServiceSpec.safeParse(patchSpec(m.spec, d.spec));
			if (!parsed.success)
				throw new Failure(
					"validation_failed",
					`${d.name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
				);
			const nodeId = await guardHostSettings(c, {
				serviceId: m.id,
				spec: parsed.data,
				before: m.spec,
				nodeId: m.nodeId,
			});
			await tx
				.update(service)
				.set({ spec: parsed.data, ...(nodeId !== undefined && { nodeId }) })
				.where(eq(service.id, m.id));
			const keys = [...d.env.remove, ...d.env.set.map((e) => e.key)];
			if (keys.length)
				await tx
					.delete(envVar)
					.where(
						and(
							eq(envVar.scope, "service"),
							eq(envVar.scopeId, m.id),
							inArray(envVar.key, keys),
						),
					);
			await writeEnv(tx, masterKey, m.id, d.env.set);
			const targets = [
				...d.mounts.remove,
				...d.mounts.set.map((x) => x.target),
			];
			if (targets.length)
				await tx
					.delete(mount)
					.where(
						and(eq(mount.serviceId, m.id), inArray(mount.target, targets)),
					);
			await writeMounts(tx, masterKey, m.id, d.mounts.set);
			const dep = one(
				await tx
					.insert(deployment)
					.values({
						serviceId: m.id,
						trigger,
						commitSha: o.by.commitSha ?? null,
					})
					.returning({ id: deployment.id }),
			);
			deployed.push({
				id: m.id,
				name: d.name,
				kind: parsed.data.kind,
				deploymentId: dep.id,
			});
		}
		await tx
			.update(stack)
			.set({
				composeYamlEncrypted: await encrypt(masterKey, yaml),
				gitSyncError: null,
				...(fromTemplate && { source: "compose" as const }),
			})
			.where(eq(stack.id, stackId));
		return { delta, deployed };
	});

	for (const s of result.deployed)
		await c.var.deps.bus.publishEvent(
			envelope(
				"deployment.queued",
				o.by.organizationId,
				{ type: "deployment", id: s.deploymentId },
				{ serviceId: s.id, trigger },
			),
		);
	if (result.delta.some((d) => d.op === "remove"))
		await requestProxySync(config.REDIS_URL, "stack updated").catch(
			(err: unknown) =>
				log("warn", "proxy sync request failed", { error: String(err) }),
		);
	return {
		changes: result.delta.map((d) => ({
			service: d.name,
			op: d.op,
			changes: d.changes,
		})),
		services: result.deployed.map((s) => ({
			id: s.id,
			name: s.name,
			kind: s.kind as "application" | "database",
			deploymentId: s.deploymentId,
			hostname: null,
		})),
	};
}

export const stacks = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/environments/{id}/stacks",
			tags,
			security,
			middleware: [requirePermission("read", byParam("environment"))],
			request: { params: IdParam },
			responses: { 200: json(z.array(Stack), "Stacks"), ...errors },
		}),
		async (c) => {
			const rows = await c.var.deps.db
				.select(stackColumns)
				.from(stack)
				.where(eq(stack.environmentId, c.req.valid("param").id))
				.orderBy(asc(stack.name));
			return c.json(rows, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/stacks/{id}",
			tags,
			security,
			summary: "A stack with its services, compose file and effective compose",
			middleware: [requirePermission("read", byParam("stack"))],
			request: { params: IdParam },
			responses: { 200: json(StackDetail, "Stack"), ...errors },
		}),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const id = c.req.valid("param").id;
			const secrets = actorCan(
				requireActor(c),
				"read:secrets",
				c.get("resource") as Resource,
			);
			const row = one(
				await db
					.select({ ...stackColumns, encrypted: stack.composeYamlEncrypted })
					.from(stack)
					.where(eq(stack.id, id)),
				"stack",
			);
			const { services, effectiveCompose } = await effectiveOf(
				db,
				masterKey,
				id,
				secrets,
			);
			const { encrypted, ...rest } = row;
			return c.json(
				{
					...rest,
					composeYaml:
						encrypted && secrets ? await decrypt(masterKey, encrypted) : null,
					composeHidden: Boolean(encrypted) && !secrets,
					effectiveCompose,
					services,
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"stack.create",
			createRoute({
				method: "post",
				path: "/environments/{id}/stacks",
				tags,
				security,
				summary: "Deploy a compose file as a stack",
				description:
					// biome-ignore lint/suspicious/noTemplateCurlyInString: documents compose syntax
					"Each compose service becomes a LogiStack service named after it, so siblings reach each other by those names. Official database images become managed databases. Parts LogiStack cannot run (build, host paths, privileged, ...) are a 400 listing every one. `${VAR:-default}` takes its default; other variables are empty until set on the service.",
				middleware: [requirePermission("write", byParam("environment"))],
				request: { params: IdParam, ...body(ComposeInput) },
				responses: { 201: json(StackCreated, "Created and queued"), ...errors },
			}),
		),
		async (c) => {
			const { id: environmentId } = c.req.valid("param");
			const input = c.req.valid("json");
			check(c, "deploy", c.get("resource") as Resource);
			c.set("auditDiff", { name: input.name });
			const created = await createStack(c, {
				environmentId,
				name: input.name,
				source: "compose",
				composeYaml: input.composeYaml,
				services: composePlan(input.composeYaml).map((p) => ({
					plan: p,
					id: newId("svc"),
					icon: null,
				})),
			});
			c.set("auditResourceId", created.stackId);
			return c.json({ ...created, name: input.name }, 201);
		},
	)
	.openapi(
		mutation(
			"stack.create_git",
			createRoute({
				method: "post",
				path: "/environments/{id}/stacks/git",
				tags,
				security,
				summary: "Deploy a compose file from a git repository as a stack",
				description:
					"Reads `composePath` at the head of `branch` through the connected provider and deploys it like a pasted compose file. Pushes to the branch re-sync the stack once the push webhook is registered (POST /git-providers/{id}/webhooks). A provider without an API (generic SSH) cannot serve the file: 422.",
				middleware: [requirePermission("write", byParam("environment"))],
				request: {
					params: IdParam,
					...body(z.object({ name: Slug, git: StackGitSource })),
				},
				responses: { 201: json(StackCreated, "Created and queued"), ...errors },
			}),
		),
		async (c) => {
			const { id: environmentId } = c.req.valid("param");
			const input = c.req.valid("json");
			check(c, "deploy", c.get("resource") as Resource);
			c.set("auditDiff", { name: input.name, git: input.git });
			const { db, masterKey } = c.var.deps;
			const composeYaml = await readGitCompose(
				db,
				masterKey,
				input.git,
				requireActor(c).organizationId,
			);
			const created = await createStack(c, {
				environmentId,
				name: input.name,
				source: "git",
				composeYaml,
				git: input.git,
				services: composePlan(composeYaml, input.git).map((p) => ({
					plan: p,
					id: newId("svc"),
					icon: null,
				})),
			});
			c.set("auditResourceId", created.stackId);
			return c.json({ ...created, name: input.name }, 201);
		},
	)
	.openapi(
		mutation(
			"stack.sync",
			createRoute({
				method: "post",
				path: "/stacks/{id}/sync",
				tags,
				security,
				summary: "Re-read a git stack's compose file and apply it",
				description:
					"What a push to the branch does, on demand: reads the compose file at the head of the branch and converges the stack to it, redeploying what changed. With `dryRun=true` it only reports the changes.",
				middleware: [requirePermission("write", byParam("stack"))],
				request: {
					params: IdParam,
					query: z.object({
						dryRun: z
							.enum(["true", "false"])
							.default("false")
							.transform((v) => v === "true"),
					}),
				},
				responses: { 200: json(StackUpdated, "Synced"), ...errors },
			}),
		),
		async (c) => {
			const id = c.req.valid("param").id;
			const { dryRun } = c.req.valid("query");
			if (!dryRun) check(c, "deploy", c.get("resource") as Resource);
			c.set("auditResourceId", id);
			const { db, masterKey } = c.var.deps;
			const [row] = await db
				.select({ git: stack.git })
				.from(stack)
				.where(eq(stack.id, id));
			if (!row?.git)
				throw new Failure(
					"bad_request",
					"this stack does not follow a git repository",
				);
			const by = applierOf(c);
			const yaml = await readGitCompose(
				db,
				masterKey,
				row.git,
				by.organizationId,
			);
			const out = await updateStack(c, id, yaml, {
				dryRun,
				source: "git",
				by,
			});
			c.set("auditDiff", { changes: out.changes });
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"stack.preview",
			createRoute({
				method: "post",
				path: "/stacks/{id}/compose/preview",
				tags,
				security,
				summary: "Preview what a new compose file changes in a stack",
				description:
					"Dry run of PUT /stacks/{id}/compose: lists the services it would create, change or remove, matched by compose service name. Writes nothing.",
				middleware: [requirePermission("write", byParam("stack"))],
				request: { params: IdParam, ...body(NewCompose) },
				responses: {
					200: json(z.object({ changes: z.array(StackChange) }), "Changes"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { changes } = await updateStack(
				c,
				c.req.valid("param").id,
				c.req.valid("json").composeYaml,
				{ dryRun: true, source: "compose", by: applierOf(c) },
			);
			return c.json({ changes }, 200);
		},
	)
	.openapi(
		mutation(
			"stack.update",
			createRoute({
				method: "put",
				path: "/stacks/{id}/compose",
				tags,
				security,
				summary:
					"Apply a new compose file to a stack and redeploy what changed",
				description:
					"Services are matched by compose service name: new ones are created, dropped ones deleted (their volumes are kept), changed ones updated and redeployed. Only what the compose itself changed since the last apply is written, so settings changed on a service since then survive. Applying the same file again changes nothing. A template stack takes its first file against its effective compose (what runs now) and is a compose stack after; `<secret>` placeholders are a 400. Same 400 rules as creating a stack; a service that would switch between database and application is a 400.",
				middleware: [requirePermission("write", byParam("stack"))],
				request: { params: IdParam, ...body(NewCompose) },
				responses: { 200: json(StackUpdated, "Applied"), ...errors },
			}),
		),
		async (c) => {
			const id = c.req.valid("param").id;
			check(c, "deploy", c.get("resource") as Resource);
			c.set("auditResourceId", id);
			const out = await updateStack(c, id, c.req.valid("json").composeYaml, {
				dryRun: false,
				source: "compose",
				by: applierOf(c),
			});
			c.set("auditDiff", { changes: out.changes });
			return c.json(out, 200);
		},
	)
	.openapi(
		mutation(
			"stack.delete",
			createRoute({
				method: "delete",
				path: "/stacks/{id}",
				tags,
				security,
				summary: "Delete a stack and all its services",
				description:
					"Removes the desired state of the stack and every service in it. The reconciler garbage-collects their Docker objects.",
				middleware: [requirePermission("delete", byParam("stack"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const id = c.req.valid("param").id;
			c.set("auditResourceId", id);
			await c.var.deps.db.delete(stack).where(eq(stack.id, id));
			return c.body(null, 204);
		},
	);
