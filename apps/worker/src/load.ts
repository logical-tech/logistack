import type {
	ApplicationSpec,
	BuildPlatform,
	DatabaseSpec,
	GameSpec,
	StorageSpec,
} from "@logistack/contracts";
import {
	type CompileMount,
	type CompileServiceInput,
	type DeploymentContext,
	decrypt,
	dockerName,
	interpolateSecrets,
	type ResolvedEnvVar,
	type Resource,
	resolveEnv,
	scaledReplicas,
	secretChain as secretChainOf,
	secretExpressions,
	secretInChain,
	secretRank,
} from "@logistack/core";
import {
	adoptedVolume,
	domain,
	environment,
	envVar,
	folder,
	gitProvider,
	mount,
	node,
	project,
	registry,
	secret,
	service,
	serviceAutoscale,
	sshKey,
} from "@logistack/db";
import type { RegistryAuth } from "@logistack/docker";
import {
	type GitProvider,
	genericConfig,
	gitProviders,
	instantiate,
} from "@logistack/providers";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Ctx } from "./ctx.ts";
import {
	resolveExternalSecrets,
	storedPlaceholder,
} from "./external-secrets.ts";
import { readSecretValues } from "./secrets.ts";

export type ServiceRow = typeof service.$inferSelect;
export type DomainRow = typeof domain.$inferSelect;

export type ServiceContext = {
	service: ServiceRow & {
		spec: ApplicationSpec | DatabaseSpec | StorageSpec | GameSpec;
	};
	organizationId: string;
	projectName: string;
	environmentName: string;
	env: Record<string, ResolvedEnvVar>;
	mounts: CompileMount[];
	/** Docker volumes another platform created, by owner id; see `adopted_volume`. */
	adoptedVolumes: Record<string, string>;
	/** Runs in a pull request preview. */
	disposable: boolean;
	domains: DomainRow[];
	registry: { host: string; flat: boolean; auth?: RegistryAuth } | null;
	/** How the clone authenticates; absent for public https repositories. */
	git?: GitAuth;
	/** Swarm id of the node the service is pinned to, when the row names one. */
	pinnedSwarmNodeId?: string;
	/** The autoscaler's replica count while it is enabled. */
	scaledReplicas?: number;
};

export const svcName = (ctx: Ctx, serviceId: string) =>
	`${ctx.cfg.LS_NAME_PREFIX}${dockerName("svc", serviceId)}`;
export const envNetworkName = (ctx: Ctx, environmentId: string) =>
	`${ctx.cfg.LS_NAME_PREFIX}${dockerName("env", environmentId)}`;

/** `<registry>/<org>/<service>:<deploymentId>`; `ls-local/...` when the image never leaves this node. */
export function imageRef(
	ctx: Ctx,
	sc: ServiceContext,
	deploymentId: string,
): string {
	const org = sc.organizationId.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
	const host = sc.registry?.host ?? "ls-local";
	const svc = svcName(ctx, sc.service.id);
	return sc.registry?.flat
		? `${host}/${org}-${svc}:${deploymentId}`
		: `${host}/${org}/${svc}:${deploymentId}`;
}

export type GitAuth =
	| { kind: "https"; url: string; username: string; password: string }
	| { kind: "ssh"; url: string; privateKey: string; knownHosts?: string };

/**
 * Clone credentials from the provider: a fresh installation token for a GitHub App, the
 * configured token otherwise, or the deploy key of a generic SSH remote.
 */
async function gitAuth(
	ctx: LoadCtx,
	gp: typeof gitProvider.$inferSelect,
	repository: string,
): Promise<GitAuth> {
	const config = JSON.parse(await decrypt(ctx.masterKey, gp.configEncrypted));
	if (gp.kind === "generic") {
		const g = genericConfig.parse(config);
		const [key] = await ctx.db
			.select({ privateKeyEncrypted: sshKey.privateKeyEncrypted })
			.from(sshKey)
			.where(
				and(
					eq(sshKey.id, g.sshKeyId),
					eq(sshKey.organizationId, gp.organizationId),
				),
			);
		if (!key) throw new Error(`git provider ${gp.id}: its SSH key was removed`);
		return {
			kind: "ssh",
			url: g.repoUrl,
			privateKey: await decrypt(ctx.masterKey, key.privateKeyEncrypted),
			...(g.knownHosts ? { knownHosts: g.knownHosts } : {}),
		};
	}
	const provider = instantiate(gitProviders[gp.kind], config) as GitProvider;
	// getCloneUrl embeds the credentials; they are split back out so they travel through env, never argv.
	const u = new URL(await provider.getCloneUrl(repository));
	const { username, password } = u;
	u.username = "";
	u.password = "";
	return {
		kind: "https",
		url: u.href,
		username: decodeURIComponent(username),
		password: decodeURIComponent(password),
	};
}

/** A project's folder and its parent, outermost first. */
async function folderChain(
	ctx: Pick<Ctx, "db">,
	folderId: string | null,
): Promise<string[]> {
	if (!folderId) return [];
	const [f] = await ctx.db
		.select({ parentId: folder.parentId })
		.from(folder)
		.where(eq(folder.id, folderId));
	return f?.parentId ? [f.parentId, folderId] : [folderId];
}

type LoadCtx = Pick<Ctx, "db" | "masterKey" | "secretsKek">;

/** For each key, the id of the most specific secret with that key on the resource's chain. */
async function secretsByKey(
	ctx: Pick<Ctx, "db">,
	organizationId: string,
	chain: Resource,
	keys: string[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (!keys.length) return out;
	const rows = await ctx.db
		.select({
			id: secret.id,
			key: secret.key,
			scope: secret.scope,
			scopeId: secret.scopeId,
		})
		.from(secret)
		.where(
			and(eq(secret.organizationId, organizationId), inArray(secret.key, keys)),
		);
	const ranked = secretChainOf(chain);
	for (const r of rows.filter((r) => secretInChain(r, chain)))
		if (
			!out.has(r.key) ||
			secretRank(r, ranked) >
				secretRank(
					rows.find((o) => o.id === out.get(r.key)) as typeof r,
					ranked,
				)
		)
			out.set(r.key, r.id);
	return out;
}

/**
 * `gitAuth: false` skips minting clone credentials, for callers that only compile.
 * `external: "placeholder"` does not contact secret providers: external secrets get the
 * placeholder of the value last read, which only fits a comparison, never a rollout.
 */
export async function loadService(
	ctx: LoadCtx,
	serviceId: string,
	{
		gitAuth: withGit = true,
		external = "resolve",
	}: { gitAuth?: boolean; external?: "resolve" | "placeholder" } = {},
): Promise<ServiceContext | null> {
	const [row] = await ctx.db
		.select({
			service,
			organizationId: project.organizationId,
			project,
			environmentName: environment.name,
			preview: environment.preview,
			autoscale: serviceAutoscale,
		})
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.leftJoin(serviceAutoscale, eq(serviceAutoscale.serviceId, service.id))
		.where(eq(service.id, serviceId));
	if (!row) return null;
	const svc = row.service;
	if (svc.spec.kind === "compose")
		throw new Error(
			`service ${svc.id}: compose services are not supported yet`,
		);
	const orgId = row.organizationId;
	const open = (v: string) => decrypt(ctx.masterKey, v);

	const vars = await ctx.db
		.select()
		.from(envVar)
		.where(
			or(
				and(eq(envVar.scope, "organization"), eq(envVar.scopeId, orgId)),
				and(eq(envVar.scope, "project"), eq(envVar.scopeId, row.project.id)),
				and(
					eq(envVar.scope, "environment"),
					eq(envVar.scopeId, svc.environmentId),
				),
				and(eq(envVar.scope, "service"), eq(envVar.scopeId, svc.id)),
			),
		);
	const chainOf: Resource = {
		type: "service",
		organizationId: orgId,
		folderIds: await folderChain(ctx, row.project.folderId),
		projectId: row.project.id,
		environmentId: svc.environmentId,
		serviceId: svc.id,
	};
	const plainValues = new Map(
		await Promise.all(
			vars
				.filter((v) => !v.secretId)
				.map(async (v) => [v.id, await open(v.valueEncrypted)] as const),
		),
	);
	// `${{ secrets.KEY }}` in plain values: the most specific secret of that key on the chain.
	const named = await secretsByKey(ctx, orgId, chainOf, [
		...new Set([...plainValues.values()].flatMap(secretExpressions)),
	]);
	const secrets = await readSecretValues(ctx, [
		...vars.flatMap((v) => (v.secretId ? [v.secretId] : [])),
		...named.values(),
	]);
	const externals =
		external === "resolve"
			? await resolveExternalSecrets(
					ctx,
					[...secrets.values()].filter((s) => s.organizationId === orgId),
				)
			: new Map(
					await Promise.all(
						[...secrets.values()]
							.filter((s) => s.providerId)
							.map(async (s) => {
								const placeholder = await storedPlaceholder(ctx, s);
								return [s.id, { value: placeholder, placeholder }] as const;
							}),
					),
				);
	const secretValue = (id: string) => {
		const s = secrets.get(id);
		const ext = externals.get(id);
		if (!s || (s.value === null && !ext))
			throw new Error(`external secret ${id} was not read`);
		return { value: ext?.value ?? (s.value as string), ext };
	};
	const env = resolveEnv(
		await Promise.all(
			vars.map(async (v) => {
				if (!v.secretId) {
					const plain = plainValues.get(v.id) as string;
					const keys = secretExpressions(plain);
					if (!keys.length)
						return {
							scope: v.scope,
							key: v.key,
							value: plain,
							isSecret: v.isSecret,
							isBuildTime: v.isBuildTime,
						};
					const resolved = (snapshot: boolean) =>
						interpolateSecrets(plain, (k) => {
							const id = named.get(k);
							if (!id) return undefined;
							const { value, ext } = secretValue(id);
							return snapshot && ext ? ext.placeholder : value;
						});
					const out = resolved(false);
					if (out.missing.length)
						throw new Error(
							`${v.key} uses \${{ secrets.${out.missing[0]} }}, but no secret of that name is defined on this service's chain`,
						);
					const external = out.used.some((k) =>
						externals.has(named.get(k) as string),
					);
					return {
						scope: v.scope,
						key: v.key,
						value: out.value,
						// Holds a secret now: masked in logs, kept out of build args.
						isSecret: true,
						isBuildTime: v.isBuildTime,
						...(external ? { snapshotValue: resolved(true).value } : {}),
					};
				}
				const s = secrets.get(v.secretId);
				// Re-checked here: moving a project to another folder can strand a folder secret.
				if (!s || s.organizationId !== orgId || !secretInChain(s, chainOf))
					throw new Error(
						`${v.key} references a secret this service cannot use; pick another in its Environment tab`,
					);
				const { value, ext } = secretValue(s.id);
				return {
					scope: v.scope,
					key: v.key,
					value,
					isSecret: true,
					isBuildTime: v.isBuildTime,
					...(ext ? { snapshotValue: ext.placeholder } : {}),
					...(v.asFile ? { fileId: v.id } : {}),
				};
			}),
		),
	);

	// References mounted as files leave the env: the app reads `/run/secrets/<KEY>`, named by `<KEY>_FILE`.
	const secretFiles: CompileMount[] = [];
	for (const [key, v] of Object.entries(env)) {
		if (!v.fileId) continue;
		secretFiles.push({
			id: v.fileId,
			kind: "secret",
			target: `/run/secrets/${key}`,
			readOnly: true,
			content: v.value,
		});
		delete env[key];
		env[`${key}_FILE`] ??= {
			scope: "service",
			value: `/run/secrets/${key}`,
			isSecret: false,
			isBuildTime: false,
		};
	}

	const mounts = await Promise.all(
		(await ctx.db.select().from(mount).where(eq(mount.serviceId, svc.id))).map(
			async (m): Promise<CompileMount> => ({
				id: m.id,
				kind: m.kind,
				target: m.target,
				readOnly: m.readOnly,
				...(m.contentEncrypted
					? { content: await open(m.contentEncrypted) }
					: {}),
			}),
		),
	);

	const adoptedVolumes = Object.fromEntries(
		(
			await ctx.db
				.select()
				.from(adoptedVolume)
				.where(eq(adoptedVolume.serviceId, svc.id))
		).map((a) => [a.ownerId, a.volumeName]),
	);

	const domains = await ctx.db
		.select()
		.from(domain)
		.where(eq(domain.serviceId, svc.id))
		.orderBy(asc(domain.createdAt), asc(domain.id));

	const [reg] = await ctx.db
		.select()
		.from(registry)
		.where(
			and(eq(registry.organizationId, orgId), eq(registry.isDefault, true)),
		);
	const host = reg?.url.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");
	const auth =
		reg?.username && reg.passwordEncrypted
			? {
					username: reg.username,
					password: await open(reg.passwordEncrypted),
					serveraddress: host as string,
				}
			: undefined;

	let git: GitAuth | undefined;
	const spec = svc.spec;
	if (
		withGit &&
		spec.kind === "application" &&
		spec.source.type === "git" &&
		spec.source.gitProviderId
	) {
		const [gp] = await ctx.db
			.select()
			.from(gitProvider)
			.where(
				and(
					eq(gitProvider.id, spec.source.gitProviderId),
					eq(gitProvider.organizationId, orgId),
				),
			);
		if (!gp)
			throw new Error(
				`service ${svc.id}: git provider ${spec.source.gitProviderId} was removed`,
			);
		git = await gitAuth(ctx, gp, spec.source.repository);
	}

	let pinnedSwarmNodeId: string | undefined;
	if (svc.nodeId) {
		const [n] = await ctx.db
			.select({ swarmNodeId: node.swarmNodeId })
			.from(node)
			.where(eq(node.id, svc.nodeId));
		pinnedSwarmNodeId = n?.swarmNodeId;
	}

	const scaled = scaledReplicas(row.autoscale);
	return {
		service: { ...svc, spec },
		organizationId: orgId,
		projectName: row.project.name,
		environmentName: row.environmentName,
		env,
		mounts: [...mounts, ...secretFiles],
		adoptedVolumes,
		disposable: row.preview !== null,
		domains,
		registry: host
			? {
					host,
					// Docker Hub repositories are one level deep: <namespace>/<name>.
					flat: reg?.kind === "dockerhub",
					...(auth ? { auth } : {}),
				}
			: null,
		...(git ? { git } : {}),
		...(pinnedSwarmNodeId ? { pinnedSwarmNodeId } : {}),
		...(scaled !== undefined && { scaledReplicas: scaled }),
	};
}

/** The `LOGISTACK_*` context of a deployment of this service, for its build and its containers. */
export function deploymentContext(
	sc: ServiceContext,
	d: {
		id: string;
		commitSha: string | null;
		commitMessage: string | null;
		/** Set for a tag or release deployment, which is not on a branch. */
		gitRef: string | null;
	},
): DeploymentContext {
	const source =
		sc.service.spec.kind === "application" ? sc.service.spec.source : null;
	return {
		deploymentId: d.id,
		...(d.commitSha && {
			commit: {
				sha: d.commitSha,
				message: d.commitMessage,
				...(source?.type === "git" && !d.gitRef && { branch: source.branch }),
			},
		}),
		environment: sc.environmentName,
		project: sc.projectName,
		service: sc.service.name,
		domains: sc.domains,
	};
}

export type DeploymentRef = {
	id: string;
	imageRef: string | null;
	platforms: BuildPlatform[] | null;
	imageShell: boolean | null;
	commitSha: string | null;
	commitMessage: string | null;
	gitRef: string | null;
};

/** Pure: the compiler input for a deployment of this service; `refs` are the Docker objects it lands on. */
export function compileInput(
	sc: ServiceContext,
	deployment: DeploymentRef,
	refs: Pick<
		CompileServiceInput,
		| "networks"
		| "pinNodeId"
		| "scope"
		| "bridgeLabels"
		| "bridgeContainerLabels"
		| "bridgeAliases"
	>,
): CompileServiceInput {
	return {
		service: {
			id: sc.service.id,
			organizationId: sc.organizationId,
			environmentId: sc.service.environmentId,
			slug: sc.service.slug,
			desiredState: sc.service.desiredState,
			spec: sc.service.spec,
			...(sc.scaledReplicas !== undefined && {
				scaledReplicas: sc.scaledReplicas,
			}),
		},
		deploymentId: deployment.id,
		...(deployment.imageRef ? { image: deployment.imageRef } : {}),
		...(deployment.platforms ? { platforms: deployment.platforms } : {}),
		...(deployment.imageShell !== null
			? { imageShell: deployment.imageShell }
			: {}),
		env: Object.fromEntries(
			Object.entries(sc.env).map(([k, v]) => [k, v.value]),
		),
		context: deploymentContext(sc, deployment),
		mounts: sc.mounts,
		adoptedVolumes: sc.adoptedVolumes,
		...(sc.disposable && { disposable: true }),
		domains: sc.domains,
		...refs,
		fileIds: {},
	};
}
