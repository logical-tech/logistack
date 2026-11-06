/**
 * Project and environment manifests: export reads the desired state into one, apply converges
 * the desired state to one. Apply goes through the API's own routes as the caller, so it gets
 * their validation, permission checks and audit; the diff itself is the pure planner in core.
 */
import {
	backupKey,
	domainKey,
	type EnvironmentManifest,
	type ManifestBackup,
	type ManifestChange,
	type ManifestDomain,
	type ManifestEnvironment,
	type ManifestService,
	type ManifestVariable,
	ProjectManifest,
	type ServiceSpec,
} from "@logistack/contracts";
import {
	changedConfigs,
	changedServiceFields,
	decrypt,
	type ManifestPlan,
	type ManifestStep,
	manifestPhases,
	planEnvironment,
	planProject,
	serviceVariables,
} from "@logistack/core";
import {
	backupPolicy,
	certificate,
	dnsProvider,
	domain,
	environment,
	envVar,
	gitProvider,
	mount,
	project,
	s3Destination,
	service,
	stack,
} from "@logistack/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Actor } from "./actor.ts";
import type { Deps } from "./env.ts";
import { Failure } from "./errors.ts";
import { type Call, callAs } from "./migration/import.ts";

/** Ids of what a snapshot read, by resource, environment slug, service slug and name. */
type Ids = Map<string, string>;
const at = (resource: string, env = "", svc = "", name = "") =>
	[resource, env, svc, name].join("\u0000");

const refKinds = {
	gitProvider: gitProvider,
	s3Destination: s3Destination,
	dnsProvider: dnsProvider,
	certificate: certificate,
} as const;
type RefKind = keyof typeof refKinds;
const refLabel: Record<RefKind, string> = {
	gitProvider: "git provider",
	s3Destination: "S3 destination",
	dnsProvider: "DNS provider",
	certificate: "certificate",
};

/** The organization's git providers, S3 destinations, DNS providers and certificates, by id and name. */
async function orgRefs(deps: Deps, organizationId: string) {
	const entries = await Promise.all(
		(Object.keys(refKinds) as RefKind[]).map(async (kind) => {
			const t = refKinds[kind];
			const rows = await deps.db
				.select({ id: t.id, name: t.name })
				.from(t)
				.where(eq(t.organizationId, organizationId));
			return [kind, rows] as const;
		}),
	);
	const rows = Object.fromEntries(entries) as Record<
		RefKind,
		{ id: string; name: string }[]
	>;
	return {
		name: (kind: RefKind, id: string | null | undefined) =>
			id ? rows[kind].find((r) => r.id === id)?.name : undefined,
		/** Throws a 400 for a name that matches no resource, or more than one. */
		id(kind: RefKind, name: string): string {
			const found = rows[kind].filter((r) => r.name === name);
			if (found.length !== 1)
				throw new Failure(
					"bad_request",
					`${refLabel[kind]} "${name}" ${found.length ? "is ambiguous: rename one" : "does not exist in this organization"}`,
				);
			return (found[0] as { id: string }).id;
		},
	};
}
type Refs = Awaited<ReturnType<typeof orgRefs>>;

const withSource = (spec: ServiceSpec) =>
	spec.kind === "application" || spec.kind === "compose" ? spec : undefined;

/**
 * The project's desired state as a manifest, and the ids behind it. Secret values are only read
 * with `reveal` (to compare, never to return); generated domains, basic auth, domain access rules
 * and node pins stay out, since they belong to the instance, not to the project.
 */
export async function snapshot(
	deps: Deps,
	organizationId: string,
	projectId: string,
	reveal: boolean,
) {
	const { db, masterKey } = deps;
	const refs = await orgRefs(deps, organizationId);
	const [prj] = await db
		.select()
		.from(project)
		.where(
			and(
				eq(project.id, projectId),
				eq(project.organizationId, organizationId),
			),
		);
	if (!prj) throw new Failure("not_found", "project not found");
	const envs = await db
		.select()
		.from(environment)
		.where(eq(environment.projectId, projectId))
		.orderBy(asc(environment.createdAt));
	const envIds = envs.map((e) => e.id);
	const [svcs, stacks] = envIds.length
		? await Promise.all([
				db
					.select()
					.from(service)
					.where(inArray(service.environmentId, envIds))
					.orderBy(asc(service.slug)),
				db.select().from(stack).where(inArray(stack.environmentId, envIds)),
			])
		: [[], []];
	const svcIds = svcs.map((s) => s.id);
	// No id is a dash: matches nothing when the list is empty.
	const none = ["-"];
	const [vars, mounts, domains, policies] = await Promise.all([
		db
			.select()
			.from(envVar)
			.where(
				or(
					and(eq(envVar.scope, "project"), eq(envVar.scopeId, projectId)),
					and(
						eq(envVar.scope, "environment"),
						inArray(envVar.scopeId, envIds.length ? envIds : none),
					),
					and(
						eq(envVar.scope, "service"),
						inArray(envVar.scopeId, svcIds.length ? svcIds : none),
					),
				),
			)
			.orderBy(asc(envVar.key)),
		db
			.select()
			.from(mount)
			.where(inArray(mount.serviceId, svcIds.length ? svcIds : none))
			.orderBy(asc(mount.target)),
		db
			.select()
			.from(domain)
			.where(
				and(
					inArray(domain.serviceId, svcIds.length ? svcIds : none),
					eq(domain.isGenerated, false),
				),
			)
			.orderBy(asc(domain.hostname), asc(domain.pathPrefix)),
		db
			.select()
			.from(backupPolicy)
			.where(inArray(backupPolicy.serviceId, svcIds.length ? svcIds : none))
			.orderBy(asc(backupPolicy.createdAt)),
	]);
	const ids: Ids = new Map();
	const variablesOf = async (
		scope: string,
		scopeId: string,
		env = "",
		svc = "",
	) =>
		Promise.all(
			vars
				.filter((v) => v.scope === scope && v.scopeId === scopeId)
				.map(async (v): Promise<ManifestVariable> => {
					ids.set(at("variable", env, svc, v.key), v.id);
					return {
						key: v.key,
						...((!v.isSecret || reveal) && {
							value: await decrypt(masterKey, v.valueEncrypted),
						}),
						secret: v.isSecret,
						buildTime: v.isBuildTime,
					};
				}),
		);
	const gitStacks = new Map(
		stacks.filter((s) => s.source === "git" && s.git).map((s) => [s.id, s]),
	);
	const environments: ManifestEnvironment[] = [];
	for (const e of envs) {
		ids.set(at("environment", e.slug), e.id);
		const services: ManifestService[] = [];
		for (const s of svcs.filter((x) => x.environmentId === e.id)) {
			ids.set(at("service", e.slug, s.slug), s.id);
			const spec = structuredClone(s.spec);
			const src = withSource(spec)?.source;
			let gitProviderName: string | undefined;
			if (src?.type === "git") {
				gitProviderName = refs.name("gitProvider", src.gitProviderId);
				delete src.gitProviderId;
			}
			const own = mounts.filter((m) => m.serviceId === s.id);
			for (const m of own) ids.set(at("mount", e.slug, s.slug, m.target), m.id);
			const svcDomains = domains
				.filter((d) => d.serviceId === s.id)
				.map((d): ManifestDomain => {
					const out: ManifestDomain = {
						hostname: d.hostname,
						port: d.port,
						...(d.pathPrefix && { pathPrefix: d.pathPrefix }),
						https: d.https,
						cert: d.cert,
						certificate: refs.name("certificate", d.customCertificateId),
						redirectTo: d.redirectTo ?? undefined,
						dnsProvider: refs.name("dnsProvider", d.dnsProviderId),
						tunnel: d.tunnel,
					};
					ids.set(at("domain", e.slug, s.slug, domainKey(out)), d.id);
					return out;
				});
			const backups = policies
				.filter((p) => p.serviceId === s.id)
				.map((p): ManifestBackup => {
					const out: ManifestBackup = {
						target: p.target,
						volume:
							p.target !== "volume"
								? undefined
								: p.volumeName === s.id
									? "data"
									: own.find((m) => m.id === p.volumeName)?.target,
						destination:
							refs.name("s3Destination", p.s3DestinationId) ??
							p.s3DestinationId,
						cron: p.cron,
						timezone: p.timezone,
						retention: p.retention,
						verifyCron: p.verifyCron ?? undefined,
						pauseService: p.pauseService,
						enabled: p.enabled,
						encrypt: p.encryptionKeyEncrypted !== null,
					};
					ids.set(at("backup", e.slug, s.slug, backupKey(out)), p.id);
					return out;
				});
			services.push({
				name: s.name,
				slug: s.slug,
				icon: s.icon ?? undefined,
				desiredState: s.desiredState,
				spec,
				gitProvider: gitProviderName,
				stack: s.stackId ? gitStacks.get(s.stackId)?.name : undefined,
				variables: await variablesOf("service", s.id, e.slug, s.slug),
				mounts: await Promise.all(
					own.map(async (m) =>
						m.kind === "volume"
							? {
									kind: "volume" as const,
									target: m.target,
									name: m.volumeName as string,
								}
							: {
									kind: "config" as const,
									target: m.target,
									content: await decrypt(masterKey, m.contentEncrypted ?? ""),
								},
					),
				),
				domains: svcDomains,
				backups,
			});
		}
		const envStacks = stacks
			.filter((s) => s.environmentId === e.id && gitStacks.has(s.id))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((s) => {
				ids.set(at("stack", e.slug, "", s.name), s.id);
				const { gitProviderId, ...git } = s.git as NonNullable<typeof s.git>;
				return {
					name: s.name,
					git: {
						...git,
						gitProvider: refs.name("gitProvider", gitProviderId) ?? "",
					},
				};
			});
		environments.push({
			name: e.name,
			slug: e.slug,
			kind: e.kind,
			color: e.color ?? undefined,
			variables: await variablesOf("environment", e.id, e.slug),
			stacks: envStacks,
			services,
		});
	}
	const raw = {
		version: 1,
		kind: "project",
		project: {
			name: prj.name,
			...(prj.description && { description: prj.description }),
		},
		variables: await variablesOf("project", projectId),
		environments,
	};
	// Parsing normalizes defaults, so a snapshot compares equal to its own export.
	const parsed = ProjectManifest.safeParse(raw);
	if (!parsed.success)
		throw new Failure(
			"unprocessable",
			"this project holds state a manifest cannot describe",
			parsed.error.issues,
		);
	return { manifest: parsed.data, ids, refs };
}

/** The manifest of one environment of a project snapshot. */
export function environmentManifest(
	manifest: ProjectManifest,
	slug: string,
): EnvironmentManifest {
	const env = manifest.environments.find((e) => e.slug === slug);
	if (!env) throw new Failure("not_found", "environment not found");
	return { version: 1, kind: "environment", environment: env };
}

/**
 * What duplicating an environment creates from it: the same stacks, services, settings and
 * config files. Domains stay out (hostnames are unique across the instance) and so do backup
 * policies; variables only when asked. Volumes are created empty, since mounts carry no data.
 */
export function duplicateOf(
	from: ManifestEnvironment,
	to: Pick<ManifestEnvironment, "name" | "slug" | "kind" | "color">,
	includeVariables: boolean,
): ManifestEnvironment {
	return {
		...from,
		...to,
		variables: includeVariables ? from.variables : [],
		services: from.services.map((s) => ({
			...s,
			variables: includeVariables ? s.variables : [],
			domains: [],
			backups: [],
		})),
	};
}

/** Every org resource a manifest names exists, or a 400 lists those that do not. */
function checkRefs(refs: Refs, envs: readonly ManifestEnvironment[]) {
	const problems = new Set<string>();
	const tryId = (kind: RefKind, name: string | undefined) => {
		if (!name) return;
		try {
			refs.id(kind, name);
		} catch (e) {
			problems.add((e as Error).message);
		}
	};
	for (const e of envs) {
		for (const s of e.stacks) tryId("gitProvider", s.git.gitProvider);
		for (const s of e.services) {
			tryId("gitProvider", s.gitProvider);
			for (const d of s.domains) {
				tryId("dnsProvider", d.dnsProvider);
				tryId("certificate", d.certificate);
			}
			for (const b of s.backups) tryId("s3Destination", b.destination);
		}
	}
	if (problems.size)
		throw new Failure(
			"bad_request",
			"the manifest names organization resources that are not here",
			[...problems],
		);
}

export type ApplyTarget =
	| { type: "project"; projectId: string; manifest: ProjectManifest }
	| {
			type: "environment";
			projectId: string;
			/** The target environment's slug. */
			slug: string;
			manifest: EnvironmentManifest;
	  };

async function planFor(
	deps: Deps,
	actor: Actor,
	target: ApplyTarget,
	prune: boolean,
) {
	const snap = await snapshot(
		deps,
		actor.organizationId,
		target.projectId,
		true,
	);
	let plan: ManifestPlan;
	if (target.type === "project") {
		checkRefs(snap.refs, target.manifest.environments);
		plan = planProject(snap.manifest, target.manifest, prune);
	} else {
		const have = snap.manifest.environments.find((e) => e.slug === target.slug);
		if (!have) throw new Failure("not_found", "environment not found");
		checkRefs(snap.refs, [target.manifest.environment]);
		plan = planEnvironment(have, target.manifest.environment, prune);
	}
	return { plan, snap };
}

/** A plan step as the API shows it: what changes, never the values. */
const publicChange = ({
	want: _w,
	have: _h,
	...change
}: ManifestStep): ManifestChange => change;

export type BackupKey = {
	environment: string;
	service: string;
	backup: string;
	key: string;
};

const opOrder = { delete: 0, update: 1, create: 2 };

/**
 * Converges the target to the manifest, phase by phase (project, environments, variables, stacks,
 * services, domains, backups), re-reading the state before each phase so later ones see what
 * earlier ones created. Applying the same manifest again plans nothing.
 */
export async function applyManifest(
	deps: Deps,
	actor: Actor,
	target: ApplyTarget,
	opts: { prune: boolean; dryRun: boolean },
) {
	const first = await planFor(deps, actor, target, opts.prune);
	if (opts.dryRun)
		return {
			applied: false,
			changes: first.plan.steps.map(publicChange),
			warnings: first.plan.warnings,
			backupKeys: [] as BackupKey[],
		};
	const call = callAs(deps, actor);
	const changes: ManifestChange[] = [];
	const warnings = new Set(first.plan.warnings);
	const backupKeys: BackupKey[] = [];
	let current = first;
	for (const phase of manifestPhases) {
		const steps = current.plan.steps
			.filter((s) => s.resource === phase)
			.sort((a, b) => opOrder[a.op] - opOrder[b.op]);
		if (!steps.length) continue;
		for (const step of steps) {
			try {
				await run(call, current.snap, target, step, opts.prune, backupKeys);
			} catch (e) {
				throw new Failure(
					e instanceof Failure ? e.code : "bad_request",
					`apply stopped at ${step.op} ${step.resource} ${[step.environment, step.service, step.name].filter(Boolean).join("/")}: ${(e as Error).message}`,
					{ applied: changes, backupKeys },
				);
			}
			changes.push(publicChange(step));
		}
		current = await planFor(deps, actor, target, opts.prune);
		for (const w of current.plan.warnings) warnings.add(w);
	}
	return { applied: true, changes, warnings: [...warnings], backupKeys };
}

type Snap = Awaited<ReturnType<typeof snapshot>>;

function idOf(snap: Snap, ...key: Parameters<typeof at>) {
	const id = snap.ids.get(at(...key));
	if (!id)
		throw new Error(
			`${key[0]} ${key.slice(1).filter(Boolean).join("/")} not found`,
		);
	return id;
}

function specIn(refs: Refs, s: ManifestService): ServiceSpec {
	const spec = structuredClone(s.spec);
	const src = withSource(spec)?.source;
	if (src?.type === "git" && s.gitProvider)
		src.gitProviderId = refs.id("gitProvider", s.gitProvider);
	return spec;
}

const domainIn = (refs: Refs, d: ManifestDomain) => ({
	hostname: d.hostname,
	port: d.port,
	pathPrefix: d.pathPrefix ?? null,
	https: d.https,
	cert: d.cert,
	customCertificateId: d.certificate
		? refs.id("certificate", d.certificate)
		: null,
	redirectTo: d.redirectTo ?? null,
	dnsProviderId: d.dnsProvider ? refs.id("dnsProvider", d.dnsProvider) : null,
	tunnel: d.tunnel,
});

const backupFields = (b: ManifestBackup) => ({
	cron: b.cron,
	timezone: b.timezone,
	retention: b.retention,
	verifyCron: b.verifyCron ?? null,
	pauseService: b.pauseService,
	enabled: b.enabled,
});

async function run(
	call: Call,
	snap: Snap,
	target: ApplyTarget,
	step: ManifestStep,
	prune: boolean,
	backupKeys: BackupKey[],
) {
	const env = step.environment ?? "";
	const envId = () => idOf(snap, "environment", env);
	const svcId = () => idOf(snap, "service", env, step.service ?? step.name);
	switch (step.resource) {
		case "project": {
			const p = step.want as NonNullable<typeof step.want>;
			await call("PATCH", `/projects/${target.projectId}`, {
				name: p.name,
				description: p.description ?? null,
			});
			return;
		}
		case "environment": {
			if (step.op === "delete")
				return void (await call(
					"DELETE",
					`/environments/${idOf(snap, "environment", step.name)}`,
				));
			const e = step.want as ManifestEnvironment;
			const body = { name: e.name, kind: e.kind, color: e.color ?? null };
			if (step.op === "create")
				await call("POST", `/projects/${target.projectId}/environments`, {
					...body,
					slug: e.slug,
				});
			else
				await call(
					"PATCH",
					`/environments/${idOf(snap, "environment", e.slug)}`,
					body,
				);
			return;
		}
		case "variable": {
			if (step.op === "delete")
				return void (await call(
					"DELETE",
					`/env-vars/${idOf(snap, "variable", env, "", step.name)}`,
				));
			const v = step.want as ManifestVariable;
			const flags = { isSecret: v.secret, isBuildTime: v.buildTime };
			if (step.op === "update")
				await call(
					"PATCH",
					`/env-vars/${idOf(snap, "variable", env, "", v.key)}`,
					{
						...flags,
						...(v.value !== undefined && { value: v.value }),
					},
				);
			else
				await call("POST", "/env-vars", {
					...(step.environment
						? { scope: "environment", scopeId: envId() }
						: { scope: "project", scopeId: target.projectId }),
					key: v.key,
					value: v.value,
					...flags,
				});
			return;
		}
		case "stack": {
			if (step.op === "delete")
				return void (await call(
					"DELETE",
					`/stacks/${idOf(snap, "stack", env, "", step.name)}`,
				));
			if (step.op === "create" && step.want) {
				const { gitProvider: name, ...git } = step.want.git;
				await call("POST", `/environments/${envId()}/stacks/git`, {
					name: step.want.name,
					git: { ...git, gitProviderId: snap.refs.id("gitProvider", name) },
				});
			}
			return;
		}
		case "service": {
			if (step.op === "delete")
				return void (await call("DELETE", `/services/${svcId()}`));
			const want = step.want as ManifestService;
			if (step.op === "create") {
				if (want.stack)
					throw new Error(
						`stack ${want.stack} did not create service ${want.slug}`,
					);
				const { id } = await call("POST", `/environments/${envId()}/services`, {
					name: want.name,
					slug: want.slug,
					spec: specIn(snap.refs, want),
					resourceProfile: null,
					...(want.icon && { icon: want.icon }),
					...(want.mounts.length && { mounts: want.mounts }),
				});
				if (want.desiredState !== "running")
					await call("PATCH", `/services/${id}`, {
						desiredState: want.desiredState,
					});
				const minted = await call<
					{ key: string; isSecret: boolean; isBuildTime: boolean }[]
				>("GET", `/env-vars?scope=service&scopeId=${id}`);
				const { body } = serviceVariables(
					minted.map((m) => ({
						key: m.key,
						secret: m.isSecret,
						buildTime: m.isBuildTime,
					})),
					want.variables,
					prune,
				);
				if (body.length || minted.length)
					await call("PUT", `/services/${id}/env-vars`, { variables: body });
				return;
			}
			const have = step.have as ManifestService;
			const id = svcId();
			const fields = changedServiceFields(have, want);
			if (fields.length)
				await call("PATCH", `/services/${id}`, {
					name: want.name,
					spec: specIn(snap.refs, want),
					desiredState: want.desiredState,
					...(want.icon && { icon: want.icon }),
				});
			const vars = serviceVariables(have.variables, want.variables, prune);
			if (vars.lines.length)
				await call("PUT", `/services/${id}/env-vars`, { variables: vars.body });
			for (const m of changedConfigs(have, want))
				if (m.kind === "config")
					await call(
						"PUT",
						`/services/${id}/files/${idOf(snap, "mount", env, want.slug, m.target)}`,
						{ content: m.content },
					);
			return;
		}
		case "domain": {
			if (step.op === "delete")
				return void (await call(
					"DELETE",
					`/domains/${idOf(snap, "domain", env, step.service, step.name)}`,
				));
			const body = domainIn(snap.refs, step.want as ManifestDomain);
			if (step.op === "create")
				await call("POST", `/services/${svcId()}/domains`, body);
			else
				await call(
					"PUT",
					`/domains/${idOf(snap, "domain", env, step.service, step.name)}`,
					body,
				);
			return;
		}
		case "backup": {
			const policy = () => idOf(snap, "backup", env, step.service, step.name);
			if (step.op === "delete")
				return void (await call("DELETE", `/backup-policies/${policy()}`));
			const b = step.want as ManifestBackup;
			let res: { encryptionKey?: string | null };
			if (step.op === "create")
				res = await call("POST", `/services/${svcId()}/backup-policies`, {
					...backupFields(b),
					target: b.target,
					volumeName:
						b.target !== "volume"
							? null
							: b.volume === "data"
								? svcId()
								: idOf(snap, "mount", env, step.service, b.volume),
					s3DestinationId: snap.refs.id("s3Destination", b.destination),
					encrypt: b.encrypt,
				});
			else
				res = await call("PATCH", `/backup-policies/${policy()}`, {
					...backupFields(b),
					...(b.encrypt && !step.have?.encrypt && { encrypt: true }),
				});
			if (res.encryptionKey)
				backupKeys.push({
					environment: env,
					service: step.service ?? "",
					backup: step.name,
					key: res.encryptionKey,
				});
			return;
		}
	}
}
