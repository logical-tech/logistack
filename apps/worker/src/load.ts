import type {
	ApplicationSpec,
	DatabaseSpec,
	StorageSpec,
} from "@logistack/contracts";
import {
	type CompileMount,
	type CompileServiceInput,
	type DeploymentContext,
	decrypt,
	dockerName,
	type ResolvedEnvVar,
	resolveEnv,
} from "@logistack/core";
import {
	adoptedVolume,
	domain,
	environment,
	envVar,
	gitProvider,
	mount,
	node,
	project,
	registry,
	service,
	sshKey,
} from "@logistack/db";
import type { RegistryAuth } from "@logistack/docker";
import {
	type GitProvider,
	genericConfig,
	gitProviders,
	instantiate,
} from "@logistack/providers";
import { and, asc, eq, or } from "drizzle-orm";
import type { Ctx } from "./ctx.ts";

export type ServiceRow = typeof service.$inferSelect;
export type DomainRow = typeof domain.$inferSelect;

export type ServiceContext = {
	service: ServiceRow & { spec: ApplicationSpec | DatabaseSpec | StorageSpec };
	organizationId: string;
	projectName: string;
	environmentName: string;
	env: Record<string, ResolvedEnvVar>;
	mounts: CompileMount[];
	/** Docker volumes another platform created, by owner id; see `adopted_volume`. */
	adoptedVolumes: Record<string, string>;
	domains: DomainRow[];
	registry: { host: string; flat: boolean; auth?: RegistryAuth } | null;
	/** How the clone authenticates; absent for public https repositories. */
	git?: GitAuth;
	/** Swarm id of the node the service is pinned to, when the row names one. */
	pinnedSwarmNodeId?: string;
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

type LoadCtx = Pick<Ctx, "db" | "masterKey">;

/** `gitAuth: false` skips minting clone credentials, for callers that only compile. */
export async function loadService(
	ctx: LoadCtx,
	serviceId: string,
	{ gitAuth: withGit = true } = {},
): Promise<ServiceContext | null> {
	const [row] = await ctx.db
		.select({
			service,
			organizationId: project.organizationId,
			project,
			environmentName: environment.name,
		})
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
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
	const env = resolveEnv(
		await Promise.all(
			vars.map(async (v) => ({
				scope: v.scope,
				key: v.key,
				value: await open(v.valueEncrypted),
				isSecret: v.isSecret,
				isBuildTime: v.isBuildTime,
			})),
		),
	);

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

	return {
		service: { ...svc, spec },
		organizationId: orgId,
		projectName: row.project.name,
		environmentName: row.environmentName,
		env,
		mounts,
		adoptedVolumes,
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
		"networks" | "pinNodeId" | "scope" | "bridgeLabels"
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
		},
		deploymentId: deployment.id,
		...(deployment.imageRef ? { image: deployment.imageRef } : {}),
		env: Object.fromEntries(
			Object.entries(sc.env).map(([k, v]) => [k, v.value]),
		),
		context: deploymentContext(sc, deployment),
		mounts: sc.mounts,
		adoptedVolumes: sc.adoptedVolumes,
		domains: sc.domains,
		...refs,
		fileIds: {},
	};
}
