/**
 * Pure mapping from a `DokploySnapshot` to the migration inventory: one item per Dokploy service,
 * each `full`, `partial` (with notes) or `unsupported` (with notes), carrying the LogiStack
 * service drafts that replace it. Notes name keys, paths and hosts, never values.
 */
import {
	ApplicationSpec,
	type BindMount,
	type BuildConfig,
	DatabaseSpec,
	DomainInput,
	EnvKey,
	isSensitiveHostPath,
	type PortMapping,
} from "@logistack/contracts";
import { dataDirOf, dokployDescriptor, postgresMajor } from "@logistack/core";
import { Cron } from "../../cron.ts";
import {
	crossChecks,
	dependencyOrder,
	orgChecks,
	SENSITIVE,
} from "../shared.ts";
import type {
	BackupDraft,
	EnvDraft,
	Inventory,
	InventoryItem,
	ServiceDraft,
} from "../types.ts";
import { mapComposeServices, parseDotenv } from "./compose.ts";
import { isDokployEncrypted } from "./decrypt.ts";
import { buildOrgItems } from "./org.ts";
import type {
	DokployApplication,
	DokployCompose,
	DokployDatabase,
	DokployDomain,
	DokployMount,
	DokploySnapshot,
} from "./snapshot.ts";

export type {
	BackupDraft,
	EnvDraft,
	Inventory,
	InventoryItem,
	ServiceDraft,
	Status,
} from "../types.ts";

/** `${{project.X}}` and `${{environment.X}}`, Dokploy's only way to share a variable. */
const SHARED_REF = /\$\{\{(project|environment)\.([A-Za-z0-9_]+)\}\}/g;

/**
 * A service's env as its container sees it. Dokploy exposes only the service's own lines, with
 * shared references substituted, so everything lands at service scope with the reference resolved:
 * the value is kept, the link to the shared variable is not.
 */
export function serviceEnv(
	own: string | null,
	shared: { project: string | null; environment: string | null },
	notes: string[],
): EnvDraft[] {
	const scopes = {
		project: parseDotenv(shared.project ?? ""),
		environment: parseDotenv(shared.environment ?? ""),
	};
	const out: EnvDraft[] = [];
	if (isDokployEncrypted(own)) {
		notes.push(
			"env is encrypted by Dokploy with a key LogiStack does not have; set it here by hand",
		);
		return out;
	}
	for (const [key, raw] of parseDotenv(own ?? "")) {
		if (!EnvKey.safeParse(key).success) {
			// A key that is not a name may be a value pasted on its own line: never echo a long one.
			notes.push(
				/^[\w.-]{1,64}$/.test(key)
					? `env ${key} is not a valid variable name, skipped`
					: "an env line is not a valid variable, skipped",
			);
			continue;
		}
		if (raw.includes("${{vault.")) {
			notes.push(`env ${key} reads a Dokploy vault, skipped`);
			continue;
		}
		let fromShared = false;
		const value = raw.replace(
			SHARED_REF,
			(match, scope: "project" | "environment", ref: string) => {
				const v = scopes[scope].get(ref);
				if (v === undefined) {
					notes.push(`env ${key} references undefined ${scope}.${ref}`);
					return match;
				}
				fromShared = true;
				return v;
			},
		);
		out.push({ key, value, isSecret: SENSITIVE.test(key) || fromShared });
	}
	return out;
}

/** Dokploy keeps memory in bytes and CPU in nano CPUs, as Swarm does. */
export function resources(
	r: { memoryLimit: string | null; cpuLimit: string | null },
	notes: string[],
) {
	const out: { cpu?: number; memoryMb?: number } = {};
	const memory = Number(r.memoryLimit);
	if (r.memoryLimit && Number.isFinite(memory) && memory > 0)
		out.memoryMb = Math.max(1, Math.round(memory / 1024 / 1024));
	else if (r.memoryLimit)
		notes.push(`memory limit "${r.memoryLimit}" is not bytes, dropped`);
	const cpu = Number(r.cpuLimit);
	if (r.cpuLimit && Number.isFinite(cpu) && cpu > 0) out.cpu = cpu / 1e9;
	else if (r.cpuLimit)
		notes.push(`CPU limit "${r.cpuLimit}" is not nano CPUs, dropped`);
	return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const filled = (v: unknown) =>
	isRecord(v) ? Object.keys(v).length > 0 : Array.isArray(v) && v.length > 0;

/** Swarm settings LogiStack sets itself; a custom value in Dokploy is reported, not carried. */
function swarmNotes(
	row: Pick<
		DokployApplication,
		| "modeSwarm"
		| "labelsSwarm"
		| "networkSwarm"
		| "updateConfigSwarm"
		| "restartPolicySwarm"
	>,
	notes: string[],
) {
	if (isRecord(row.modeSwarm) && "Global" in row.modeSwarm)
		notes.push("global mode becomes one replica");
	const named = {
		labelsSwarm: "Swarm labels",
		networkSwarm: "extra networks",
		updateConfigSwarm: "update config",
		restartPolicySwarm: "restart policy",
	} as const;
	for (const [field, label] of Object.entries(named))
		if (filled(row[field as keyof typeof named]))
			notes.push(`custom ${label} not carried over`);
}

/** Swarm placement constraints map one to one. */
function placementOf(v: unknown): string[] {
	const constraints = isRecord(v) ? v.Constraints : undefined;
	return Array.isArray(constraints)
		? constraints.filter((c): c is string => typeof c === "string")
		: [];
}

/** Docker HealthConfig.Test → LogiStack check; `CMD-SHELL` keeps its shell, as Docker runs it. */
function healthcheckOf(v: unknown, notes: string[]) {
	const test = isRecord(v) ? v.Test : undefined;
	if (!Array.isArray(test) || test.length < 2) {
		if (filled(v)) notes.push("custom healthcheck not understood, dropped");
		return undefined;
	}
	const [kind, ...rest] = test.map(String);
	if (kind === "CMD") return { type: "command" as const, command: rest };
	if (kind === "CMD-SHELL")
		return { type: "command" as const, command: ["sh", "-c", rest.join(" ")] };
	if (kind !== "NONE") notes.push("custom healthcheck not understood, dropped");
	return undefined;
}

/** Dokploy splits `command` on spaces into the container command; so do we. */
const argv = (command: string | null) =>
	command?.split(" ").filter(Boolean) ?? [];

const cleanPath = (p: string | null | undefined) => {
	const trimmed = (p ?? "").replace(/^\/+|\/+$/g, "");
	return trimmed || "/";
};

function mapMounts(
	rows: DokployMount[],
	notes: string[],
): {
	binds: BindMount[];
	mounts: ServiceDraft["mounts"];
	adopted: ServiceDraft["adoptedVolumes"];
} {
	const binds: BindMount[] = [];
	const mounts: ServiceDraft["mounts"] = [];
	const adopted: ServiceDraft["adoptedVolumes"] = [];
	const target = (m: DokployMount) => m.mountPath.replace(/(.)\/+$/, "$1");
	for (const m of rows) {
		if (m.type === "bind" && m.hostPath) {
			binds.push({
				kind: "bind",
				hostPath: m.hostPath,
				target: target(m),
				...(isSensitiveHostPath(m.hostPath) && {
					allowSensitiveHostPath: true as const,
				}),
			});
			if (isSensitiveHostPath(m.hostPath))
				notes.push(`bind mount ${m.hostPath} is a sensitive host path`);
		} else if (m.type === "volume" && m.volumeName) {
			mounts.push({
				kind: "volume",
				name:
					m.volumeName
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/^-+|-+$/g, "")
						.slice(0, 40) || "data",
				target: target(m),
			});
			adopted.push({
				target: target(m),
				volume: m.volumeName,
				source: "dokploy",
			});
		} else if (m.type === "file" && m.content !== null) {
			mounts.push({
				kind: "config",
				target: m.filePath
					? `${target(m).replace(/\/$/, "")}/${m.filePath.replace(/^\/+/, "")}`
					: target(m),
				content: m.content,
			});
		} else
			notes.push(`${m.type} mount at ${m.mountPath} is incomplete, skipped`);
	}
	return { binds, mounts, adopted };
}

function mapDomain(
	d: DokployDomain,
	fallbackPort: number | undefined,
	notes: string[],
): DomainInput | undefined {
	const port = d.port ?? fallbackPort;
	if (!port) {
		notes.push(`domain ${d.host} has no port, skipped`);
		return undefined;
	}
	const prefix = d.path && d.path !== "/" ? d.path : null;
	if (prefix && d.stripPath)
		notes.push(
			`domain ${d.host}${prefix}: Dokploy stripped the path prefix, LogiStack forwards it`,
		);
	if (d.internalPath && d.internalPath !== "/")
		notes.push(
			`domain ${d.host}: internal path ${d.internalPath} is not supported`,
		);
	if (d.certificateType === "custom")
		notes.push(
			`domain ${d.host}: custom certificate resolver becomes Let's Encrypt`,
		);
	const parsed = DomainInput.safeParse({
		hostname: d.host,
		port,
		pathPrefix: prefix,
		https: d.https,
		cert: d.https && d.certificateType !== "none" ? "auto" : "none",
	});
	if (!parsed.success) {
		notes.push(
			`domain ${d.host}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
		);
		return undefined;
	}
	return parsed.data;
}

/** Repository, branch and path of a git source, and the Dokploy provider it authenticates with. */
function gitSource(a: DokployApplication) {
	const of = (
		type: NonNullable<ServiceDraft["gitProvider"]>["type"],
		id: string | null,
		repository: string | null | undefined,
		branch: string | null,
		path: string | null,
	) =>
		repository && branch
			? {
					source: {
						type: "git" as const,
						repository,
						branch,
						path: cleanPath(path),
					},
					...(id && { gitProvider: { type, sourceId: id } }),
				}
			: undefined;
	switch (a.sourceType) {
		case "github":
			return of(
				"github",
				a.githubId,
				a.owner && a.repository && `${a.owner}/${a.repository}`,
				a.branch,
				a.buildPath,
			);
		case "gitlab":
			return of(
				"gitlab",
				a.gitlabId,
				a.gitlabPathNamespace,
				a.gitlabBranch,
				a.gitlabBuildPath,
			);
		case "gitea":
			return of(
				"gitea",
				a.giteaId,
				a.giteaOwner &&
					a.giteaRepository &&
					`${a.giteaOwner}/${a.giteaRepository}`,
				a.giteaBranch,
				a.giteaBuildPath,
			);
		case "bitbucket":
			return of(
				"bitbucket",
				a.bitbucketId,
				a.bitbucketOwner &&
					a.bitbucketRepository &&
					`${a.bitbucketOwner}/${a.bitbucketRepository}`,
				a.bitbucketBranch,
				a.bitbucketBuildPath,
			);
		case "git":
			return of(
				"github",
				null,
				a.customGitUrl,
				a.customGitBranch,
				a.customGitBuildPath,
			);
		default:
			return undefined;
	}
}

function buildOf(
	a: DokployApplication,
	notes: string[],
): BuildConfig | undefined {
	switch (a.buildType) {
		case "dockerfile": {
			const args = [...parseDotenv(a.buildArgs ?? "")];
			return {
				type: "dockerfile",
				dockerfilePath: a.dockerfile || "Dockerfile",
				context: a.dockerContextPath?.replace(/^\/+/, "") || ".",
				...(a.dockerBuildStage && { target: a.dockerBuildStage }),
				...(args.length && { buildArgs: Object.fromEntries(args) }),
			};
		}
		case "railpack":
			return { type: "railpack" };
		case "static":
			return { type: "static", publishDir: a.publishDirectory || "." };
		case "nixpacks":
		case "heroku_buildpacks":
		case "paketo_buildpacks":
			notes.push(`built with Railpack instead of ${a.buildType}`);
			return { type: "railpack" };
		default:
			notes.push(`build type ${a.buildType} is not supported`);
			return undefined;
	}
}

type Context = {
	snapshot: DokploySnapshot;
	project: string;
	environment: string;
	sharedEnv: { project: string | null; environment: string | null };
};

function mapApplication(a: DokployApplication, ctx: Context): InventoryItem {
	const notes: string[] = [];
	const s = ctx.snapshot;
	const item = (services: ServiceDraft[]): InventoryItem => ({
		kind: "application",
		sourceId: a.applicationId,
		appName: a.appName,
		source: dokployDescriptor(
			"application",
			a.appName,
			services.some((x) => x.domains.length),
		),
		name: a.name,
		project: ctx.project,
		environment: ctx.environment,
		status: !services.length
			? "unsupported"
			: notes.length
				? "partial"
				: "full",
		notes,
		// Until Dokploy is removed, its Traefik and services reach each one by its old name.
		services: services.map((x) => ({
			...x,
			bridge: { aliases: [x.slug], routes: false },
		})),
	});
	if (a.serverId) {
		notes.push("runs on a remote Dokploy server");
		return item([]);
	}

	let source: ApplicationSpec["source"] | undefined;
	let build: BuildConfig | undefined;
	let gitProvider: ServiceDraft["gitProvider"];
	if (a.sourceType === "docker") {
		if (!a.dockerImage) notes.push("docker source without an image");
		else {
			source = { type: "image", image: a.dockerImage };
			build = { type: "image" };
		}
		if (a.username || a.registryUrl)
			notes.push("private registry credentials must be added in LogiStack");
	} else if (a.sourceType === "drop") {
		notes.push(
			"uploaded (drop) source cannot be rebuilt; redeploy from git or an image",
		);
	} else {
		const git = gitSource(a);
		if (!git) notes.push(`${a.sourceType} source is incomplete`);
		else {
			source = git.source;
			gitProvider = git.gitProvider;
			build = buildOf(a, notes);
			if (a.customGitSSHKeyId)
				notes.push("git SSH key must be added in LogiStack");
		}
	}
	if (a.registryId)
		notes.push("pushes to a Dokploy registry; LogiStack uses its own");
	if (a.isPreviewDeploymentsActive)
		notes.push("preview deployments are not carried over");
	swarmNotes(a, notes);

	const ports: PortMapping[] = s.ports
		.filter((p) => p.applicationId === a.applicationId)
		.map((p) => ({
			target: p.targetPort,
			published: p.publishedPort,
			protocol: p.protocol === "udp" ? "udp" : "tcp",
			mode: p.publishMode === "ingress" ? "ingress" : "host",
		}));
	const { binds, mounts, adopted } = mapMounts(
		s.mounts.filter((m) => m.ownerId === a.applicationId),
		notes,
	);
	const command = argv(a.command);
	const healthcheck = healthcheckOf(a.healthCheckSwarm, notes);
	const placement = placementOf(a.placementSwarm);
	const domainRows = s.domains.filter(
		(d) => d.applicationId === a.applicationId && d.domainType !== "preview",
	);
	const domains = domainRows
		.map((d) => mapDomain(d, ports[0]?.target, notes))
		.filter((d): d is DomainInput => !!d);
	const redirects = s.redirects.filter(
		(r) => r.applicationId === a.applicationId,
	);
	if (redirects.length)
		notes.push(`${redirects.length} redirect rule(s) are not carried over`);
	const env = serviceEnv(a.env, ctx.sharedEnv, notes);

	if (!source || !build) return item([]);
	const spec = ApplicationSpec.safeParse({
		kind: "application",
		source,
		build,
		ports,
		replicas: Math.max(1, a.replicas ?? 1),
		resources: resources(a, notes),
		placement,
		...(healthcheck && { healthcheck }),
		...(command.length && { command }),
		...(binds.length && { mounts: binds }),
	});
	if (!spec.success) {
		notes.push(
			...spec.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
		);
		return item([]);
	}
	return item([
		{
			name: a.name,
			slug: a.appName,
			dependsOn: [],
			importedFrom: `dokploy:${a.appName}`,
			spec: spec.data,
			mounts,
			adoptedVolumes: adopted,
			env,
			domains,
			basicAuth: s.security
				.filter((x) => x.applicationId === a.applicationId)
				.map(({ username, password }) => ({ username, password })),
			...(gitProvider && { gitProvider }),
			running: a.applicationStatus === "done",
			backups: [],
		},
	]);
}

/** The official image's repository per engine; anything else is a custom image LogiStack can't run. */
const OFFICIAL = /^(?:docker\.io\/)?(?:library\/)?([a-z]+):([A-Za-z0-9_.-]+)$/;

/** The env each engine's official image initialises from, with Dokploy's credentials. */
function credentialsEnv(d: DokployDatabase): EnvDraft[] {
	const secret = (key: string, value: string | null) =>
		value ? [{ key, value, isSecret: true }] : [];
	const plain = (key: string, value: string | null) =>
		value ? [{ key, value, isSecret: false }] : [];
	switch (d.engine) {
		case "postgres":
			return [
				...plain("POSTGRES_USER", d.databaseUser),
				...secret("POSTGRES_PASSWORD", d.databasePassword),
				...plain("POSTGRES_DB", d.databaseName),
			];
		case "mysql":
			return [
				...secret("MYSQL_ROOT_PASSWORD", d.rootPassword),
				...plain("MYSQL_USER", d.databaseUser),
				...secret("MYSQL_PASSWORD", d.databasePassword),
				...plain("MYSQL_DATABASE", d.databaseName),
			];
		case "mariadb":
			return [
				...secret("MARIADB_ROOT_PASSWORD", d.rootPassword),
				...plain("MARIADB_USER", d.databaseUser),
				...secret("MARIADB_PASSWORD", d.databasePassword),
				...plain("MARIADB_DATABASE", d.databaseName),
			];
		case "mongo":
			return [
				...plain("MONGO_INITDB_ROOT_USERNAME", d.databaseUser),
				...secret("MONGO_INITDB_ROOT_PASSWORD", d.databasePassword),
			];
		case "redis":
			return secret("REDIS_PASSWORD", d.databasePassword);
	}
}

function mapDatabase(d: DokployDatabase, ctx: Context): InventoryItem {
	const notes: string[] = [];
	const item = (services: ServiceDraft[]): InventoryItem => ({
		kind: d.engine,
		sourceId: d.id,
		appName: d.appName,
		source: dokployDescriptor(
			d.engine,
			d.appName,
			services.some((x) => x.domains.length),
		),
		name: d.name,
		project: ctx.project,
		environment: ctx.environment,
		status: !services.length
			? "unsupported"
			: notes.length
				? "partial"
				: "full",
		notes,
		// Until Dokploy is removed, its Traefik and services reach each one by its old name.
		services: services.map((x) => ({
			...x,
			bridge: { aliases: [x.slug], routes: false },
		})),
	});
	if (d.serverId) {
		notes.push("runs on a remote Dokploy server");
		return item([]);
	}
	const image = OFFICIAL.exec(d.dockerImage);
	if (!image || image[1] !== d.engine) {
		notes.push(
			`custom image ${d.dockerImage}; LogiStack runs the official ${d.engine} image`,
		);
		return item([]);
	}
	const version = image[2] as string;
	const spec = DatabaseSpec.parse({
		kind: "database",
		engine: d.engine,
		version,
		credentialsRef: "dokploy",
		resources: resources(d, notes),
	});
	const dataDir = dataDirOf(spec) as string;
	// Postgres 18+: Dokploy mounts the volume on the image's PGDATA, so the cluster is the volume
	// root. LogiStack mounts the parent directory, so PGDATA points back at the root.
	const major = postgresMajor(version);
	const pg18 =
		d.engine === "postgres" && major >= 18
			? `/var/lib/postgresql/${major}/docker`
			: undefined;
	const dokployDir = pg18 ?? dataDir;
	const mounts = ctx.snapshot.mounts.filter((m) => m.ownerId === d.id);
	const data = mounts.find(
		(m) =>
			m.type === "volume" &&
			m.volumeName &&
			m.mountPath.replace(/(.)\/+$/, "$1") === dokployDir,
	);
	if (!data?.volumeName) {
		notes.push(
			`no volume mounted at ${dokployDir}; the data would not carry over`,
		);
		return item([]);
	}
	if (mounts.length > 1)
		notes.push("extra mounts besides the data volume are not carried over");
	if (d.externalPort)
		notes.push(`external port ${d.externalPort} is not published`);
	if (d.command) notes.push("custom command is not carried over");
	if (placementOf(d.placementSwarm).length)
		notes.push("placement constraints are not carried over");
	swarmNotes(d, notes);
	const extra = serviceEnv(d.env, ctx.sharedEnv, notes);
	const credentials = [
		...credentialsEnv(d),
		...(pg18 ? [{ key: "PGDATA", value: dataDir, isSecret: false }] : []),
	];
	return item([
		{
			name: d.name,
			slug: d.appName,
			dependsOn: [],
			importedFrom: `dokploy:${d.appName}`,
			spec,
			mounts: [],
			adoptedVolumes: [
				{
					target: dataDir,
					volume: data.volumeName,
					source: "dokploy",
				},
			],
			env: [
				...credentials,
				...extra.filter((e) => !credentials.some((c) => c.key === e.key)),
			],
			domains: [],
			basicAuth: [],
			running: d.applicationStatus === "done",
			backups: backupsOf(d, ctx.snapshot, notes),
		},
	]);
}

function backupsOf(
	d: DokployDatabase,
	s: DokploySnapshot,
	notes: string[],
): BackupDraft[] {
	const out: BackupDraft[] = [];
	for (const b of s.backups.filter((x) => x.ownerId === d.id)) {
		if (!Cron.safeParse(b.schedule).success) {
			notes.push(
				`backup schedule "${b.schedule}" is not a 5-field cron, skipped`,
			);
			continue;
		}
		out.push({
			destination: b.destinationId,
			cron: b.schedule.trim(),
			// Dokploy keeps every backup unless told how many; so does an empty retention.
			retention:
				b.keepLatestCount && b.keepLatestCount > 0
					? { count: b.keepLatestCount }
					: {},
			enabled: b.enabled ?? true,
		});
	}
	return out;
}

function mapComposeItem(c: DokployCompose, ctx: Context): InventoryItem {
	const notes: string[] = [];
	const item = (services: ServiceDraft[]): InventoryItem => ({
		kind: "compose",
		sourceId: c.composeId,
		appName: c.appName,
		source: dokployDescriptor(
			"compose",
			c.appName,
			services.some((x) => x.domains.length),
		),
		name: c.name,
		project: ctx.project,
		environment: ctx.environment,
		status: !services.length
			? "unsupported"
			: notes.length
				? "partial"
				: "full",
		notes,
		// Until Dokploy is removed, its Traefik and services reach each one by its old name.
		services: services.map((x) => ({
			...x,
			bridge: { aliases: [x.slug], routes: true },
		})),
	});
	if (c.serverId) {
		notes.push("runs on a remote Dokploy server");
		return item([]);
	}
	const file =
		c.sourceType === "raw"
			? c.composeFile
			: ctx.snapshot.composeFiles[c.composeId];
	if (!file) {
		notes.push(
			c.sourceType === "raw"
				? "compose file is empty"
				: `${c.sourceType} compose file not found on disk`,
		);
		return item([]);
	}
	let compose: unknown;
	try {
		compose = Bun.YAML.parse(file);
	} catch {
		notes.push("compose file is not valid YAML");
		return item([]);
	}
	const backups = ctx.snapshot.backups.filter(
		(b) => b.ownerId === c.composeId,
	).length;
	if (backups)
		notes.push(
			`${backups} backup schedule(s) of databases inside the compose file are not carried over`,
		);
	if (c.composeType === "stack")
		notes.push("deployed as a Swarm stack in Dokploy; deploy keys are ignored");
	const env = serviceEnv(c.env, ctx.sharedEnv, notes);
	const mapped = mapComposeServices({
		appName: c.appName,
		projectName: ctx.project,
		compose,
		dotenv: new Map(env.map((e) => [e.key, e.value])),
	});
	if (mapped.kind === "refused") {
		notes.push(...mapped.unsupported);
		return item([]);
	}
	const rows = ctx.snapshot.domains.filter(
		(d) => d.composeId === c.composeId && d.domainType !== "preview",
	);
	const names = new Set(mapped.plans.map((p) => p.serviceName));
	for (const d of rows)
		if (!d.serviceName || !names.has(d.serviceName))
			notes.push(`domain ${d.host} names no service of the file, skipped`);
	const drafts: ServiceDraft[] = [];
	for (const plan of mapped.plans) {
		notes.push(...plan.warnings.map((w) => `${plan.serviceName}: ${w}`));
		if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(plan.serviceName)) {
			notes.push(
				`service name ${plan.serviceName} is not a DNS label, so siblings could not reach it`,
			);
			return item([]);
		}
		const domains = rows
			.filter((d) => d.serviceName === plan.serviceName)
			.map((d) => mapDomain(d, undefined, notes))
			.filter((d): d is DomainInput => !!d);
		drafts.push({
			name: plan.serviceName,
			slug: plan.serviceName,
			dependsOn: plan.dependsOn,
			importedFrom: plan.importedFrom,
			spec: plan.spec,
			mounts: plan.volumes.map((v) => ({
				kind: "volume" as const,
				name: v.name,
				target: v.target,
			})),
			adoptedVolumes: plan.volumes.map((v) => ({
				target: v.target,
				volume: v.volume,
				source: "dokploy" as const,
			})),
			env: plan.env,
			// Domains from Dokploy's domain table, plus Traefik labels in the file, deduplicated by host.
			domains: [
				...domains,
				...plan.domains
					.filter((d) => !domains.some((x) => x.hostname === d.hostname))
					.map((d) => ({
						hostname: d.hostname,
						port: d.port,
						https: true,
						cert: "auto" as const,
					})),
			],
			basicAuth: [],
			running: c.composeStatus === "done",
			backups: [],
		});
	}
	return item(dependencyOrder(drafts, notes));
}

export function buildInventory(snapshot: DokploySnapshot): Inventory {
	const envs = new Map(snapshot.environments.map((e) => [e.environmentId, e]));
	const projects = new Map(snapshot.projects.map((p) => [p.projectId, p]));
	const contextOf = (environmentId: string): Context => {
		const e = envs.get(environmentId);
		const p = e ? projects.get(e.projectId) : undefined;
		return {
			snapshot,
			project: p?.name ?? "Imported",
			environment: e?.name ?? "production",
			sharedEnv: { project: p?.env ?? null, environment: e?.env ?? null },
		};
	};
	const org = buildOrgItems(snapshot);
	const items = crossChecks([
		...snapshot.databases.map((d) =>
			mapDatabase(d, contextOf(d.environmentId)),
		),
		...snapshot.applications.map((a) =>
			mapApplication(a, contextOf(a.environmentId)),
		),
		...snapshot.composes.map((c) =>
			mapComposeItem(c, contextOf(c.environmentId)),
		),
	]);
	orgChecks(items, org);
	return { items, org };
}
