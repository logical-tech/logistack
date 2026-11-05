/**
 * Pure mapping from a `CoolifySnapshot` to the migration inventory: one item per Coolify
 * application, standalone database and one-click service, each `full`, `partial` or
 * `unsupported` with notes, carrying the LogiStack drafts that replace it. Notes name keys,
 * paths and hosts, never values.
 *
 * Coolify runs plain containers named after uuids. A database keeps its uuid as its slug, because
 * that is the host in every connection string Coolify generated; an application gets a slug from
 * its name (its container name changes with each deploy, so nothing reaches it by name). Until
 * Coolify is removed, each service answers on LogiStack's bridge overlay under its old container
 * names, and Coolify's Traefik routes its domains by labels (`traefik-docker`).
 */
import {
	ApplicationSpec,
	type BindMount,
	type BuildConfig,
	DatabaseSpec,
	DomainInput,
	EnvKey,
	type PortMapping,
} from "@logistack/contracts";
import { dataDirOf, type SourceDescriptor } from "@logistack/core";
import { Cron } from "../../cron.ts";
import { slugify } from "../../openapi.ts";
import { mapComposeServices, mountName } from "../dokploy/compose.ts";
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
import { buildCoolifyOrgItems } from "./org.ts";
import type {
	CoolifyApplication,
	CoolifyDatabase,
	CoolifyEngine,
	CoolifyService,
	CoolifySnapshot,
} from "./snapshot.ts";

/** Coolify's model classes, as stored in polymorphic `*_type` columns. */
const MODEL = {
	application: "App\\Models\\Application",
	service: "App\\Models\\Service",
	serviceApplication: "App\\Models\\ServiceApplication",
	serviceDatabase: "App\\Models\\ServiceDatabase",
	standaloneDocker: "App\\Models\\StandaloneDocker",
	github: "App\\Models\\GithubApp",
} as const;
const DATABASE_MODEL: Record<CoolifyEngine, string> = {
	postgres: "App\\Models\\StandalonePostgresql",
	mysql: "App\\Models\\StandaloneMysql",
	mariadb: "App\\Models\\StandaloneMariadb",
	mongo: "App\\Models\\StandaloneMongodb",
	redis: "App\\Models\\StandaloneRedis",
	keydb: "App\\Models\\StandaloneKeydb",
	dragonfly: "App\\Models\\StandaloneDragonfly",
	clickhouse: "App\\Models\\StandaloneClickhouse",
};
/** Engines LogiStack runs; the others stay on Coolify. */
const SUPPORTED_ENGINES = new Set<CoolifyEngine>([
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
]);

/** Where Coolify keeps per-resource files on the host. */
const DATA_ROOT = "/data/coolify";

/** `{{project.KEY}}` and friends: Coolify's shared variables. */
const SHARED_REF =
	/\{\{\s*(team|project|environment|server)\.([A-Za-z0-9_]+)\s*\}\}/g;

type Context = {
	s: CoolifySnapshot;
	project: { id: number; name: string; team_id: number };
	environment: { id: number; name: string };
};

const running = (status: string | null) => !!status?.startsWith("running");

/** The same `<uuid>` compose project label Coolify gives every container of a resource. */
const descriptor = (uuid: string, routed: boolean): SourceDescriptor => ({
	containerLabels: [
		"coolify.managed=true",
		`com.docker.compose.project=${uuid}`,
	],
	routedByLabels: routed,
});

/** Docker size strings (`512m`, `1g`, `0`) as Coolify stores them, in MB. */
function memoryMb(v: string | null, notes: string[]): number | undefined {
	if (!v || v === "0") return undefined;
	const m = /^(\d+(?:\.\d+)?)\s*([bkmg]?)b?$/i.exec(v.trim());
	if (!m) {
		notes.push(`memory limit "${v}" not understood, dropped`);
		return undefined;
	}
	const n = Number(m[1]);
	const unit = (m[2] ?? "").toLowerCase();
	const mb =
		unit === "g"
			? n * 1024
			: unit === "m"
				? n
				: unit === "k"
					? n / 1024
					: n / 1024 / 1024;
	return Math.max(1, Math.round(mb));
}

function resourcesOf(
	r: { limits_memory: string | null; limits_cpus: string | null },
	notes: string[],
) {
	const out: { cpu?: number; memoryMb?: number } = {};
	const mem = memoryMb(r.limits_memory, notes);
	if (mem) out.memoryMb = mem;
	const cpu = Number(r.limits_cpus);
	if (r.limits_cpus && r.limits_cpus !== "0") {
		if (Number.isFinite(cpu) && cpu > 0) out.cpu = cpu;
		else notes.push(`CPU limit "${r.limits_cpus}" not understood, dropped`);
	}
	return out;
}

/**
 * A resource's env as its container gets it: the non-preview rows, with shared references and
 * `$SIBLING` references resolved. A value Coolify's key did not open, a vault reference or an
 * invalid key is skipped and named.
 */
function envOf(
	ctx: Context,
	model: string,
	id: number,
	notes: string[],
): EnvDraft[] {
	const { s } = ctx;
	const rows = s.envs.filter(
		(e) =>
			e.resourceable_type === model &&
			e.resourceable_id === id &&
			!e.is_preview,
	);
	const undecryptable = new Set(
		s.undecryptable
			.filter((u) => u.table === "environment_variables")
			.map((u) => u.id),
	);
	const shared = (type: string, key: string) =>
		s.sharedEnvs.find(
			(v) =>
				v.type === type &&
				v.key === key &&
				(type === "team"
					? v.team_id === ctx.project.team_id
					: type === "project"
						? v.project_id === ctx.project.id
						: type === "environment"
							? v.environment_id === ctx.environment.id
							: true),
		)?.value;
	const own = new Map(rows.map((r) => [r.key, r.value]));
	const out: EnvDraft[] = [];
	let buildOnly = 0;
	for (const r of rows) {
		if (!EnvKey.safeParse(r.key).success) {
			notes.push(
				/^[\w.-]{1,64}$/.test(r.key)
					? `env ${r.key} is not a valid variable name, skipped`
					: "an env line is not a valid variable, skipped",
			);
			continue;
		}
		if (r.value === null) {
			if (undecryptable.has(r.key))
				notes.push(
					`env ${r.key} could not be decrypted with Coolify's APP_KEY; set it here by hand`,
				);
			continue;
		}
		if (r.value.includes("{{vault.")) {
			notes.push(`env ${r.key} reads a remote secret manager, skipped`);
			continue;
		}
		let fromShared = false;
		let value = r.is_literal
			? r.value
			: r.value.replace(SHARED_REF, (match, type: string, key: string) => {
					const v = shared(type, key);
					if (v === undefined || v === null) {
						notes.push(`env ${r.key} references undefined ${type}.${key}`);
						return match;
					}
					fromShared = true;
					return v;
				});
		const sibling =
			!r.is_literal && /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
		if (sibling && own.has(sibling[1] as string) && sibling[1] !== r.key)
			value = own.get(sibling[1] as string) ?? value;
		if (r.is_buildtime && r.is_runtime === false) buildOnly++;
		out.push({
			key: r.key,
			value,
			isSecret: SENSITIVE.test(r.key) || fromShared,
		});
	}
	if (buildOnly)
		notes.push(
			`${buildOnly} build-time-only variable(s) are also set at runtime in LogiStack`,
		);
	return out;
}

/** `https://a.com:3000/api` → a domain; the port falls back to the service's first port. */
function domainsOf(
	fqdn: string | null,
	fallbackPort: number | undefined,
	notes: string[],
): DomainInput[] {
	const out: DomainInput[] = [];
	for (const raw of (fqdn ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)) {
		let url: URL;
		try {
			url = new URL(/^[a-z]+:\/\//.test(raw) ? raw : `http://${raw}`);
		} catch {
			notes.push(`domain ${raw} is not a URL, skipped`);
			continue;
		}
		const port = url.port ? Number(url.port) : fallbackPort;
		if (!port) {
			notes.push(`domain ${url.hostname} has no port, skipped`);
			continue;
		}
		const https = url.protocol === "https:";
		const parsed = DomainInput.safeParse({
			hostname: url.hostname,
			port,
			pathPrefix:
				url.pathname && url.pathname !== "/"
					? url.pathname.replace(/\/+$/, "")
					: null,
			https,
			cert: https ? "auto" : "none",
		});
		if (parsed.success) out.push(parsed.data);
		else
			notes.push(`domain ${url.hostname}: ${parsed.error.issues[0]?.message}`);
	}
	return out;
}

/** Coolify's own key to its host, `host.docker.internal`: server 0. Anything else is remote. */
function onLocalhost(
	s: CoolifySnapshot,
	r: { destination_type: string | null; destination_id: number | null },
	notes: string[],
): boolean {
	if (r.destination_type !== MODEL.standaloneDocker) {
		notes.push("runs on a Swarm destination in Coolify");
		return false;
	}
	const d = s.destinations.find((x) => x.id === r.destination_id);
	if (d?.server_id !== 0) {
		notes.push("runs on a remote Coolify server");
		return false;
	}
	return true;
}

/** Persistent and file volumes of one resource. */
function volumesOf(
	s: CoolifySnapshot,
	model: string,
	id: number,
	notes: string[],
) {
	const binds: BindMount[] = [];
	const mounts: ServiceDraft["mounts"] = [];
	const adopted: ServiceDraft["adoptedVolumes"] = [];
	for (const v of s.volumes.filter(
		(v) => v.resource_type === model && v.resource_id === id,
	)) {
		const target = v.mount_path.replace(/(.)\/+$/, "$1");
		if (v.host_path)
			binds.push({ kind: "bind", hostPath: v.host_path, target });
		else {
			mounts.push({ kind: "volume", name: mountName(v.name), target });
			adopted.push({ target, volume: v.name, source: "coolify" });
		}
	}
	for (const f of s.fileVolumes.filter(
		(f) => f.resource_type === model && f.resource_id === id,
	)) {
		const target = f.mount_path.replace(/(.)\/+$/, "$1");
		if (f.is_directory)
			binds.push({ kind: "bind", hostPath: f.fs_path, target });
		else if (f.content !== null)
			mounts.push({ kind: "config", target, content: f.content });
		else notes.push(`file ${target} could not be decrypted, skipped`);
	}
	return { binds, mounts, adopted };
}

/** Labels Coolify writes itself (routing, its own bookkeeping); anything else was the user's. */
function customLabelNotes(raw: string | null, notes: string[]) {
	if (!raw) return;
	let text = raw;
	if (/^[A-Za-z0-9+/=\s]+$/.test(raw))
		try {
			text = Buffer.from(raw, "base64").toString("utf8");
		} catch {}
	const own = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(
			(l) =>
				l && !/^(traefik\.|caddy|coolify\.|com\.docker\.compose\.)/.test(l),
		);
	if (own.length)
		notes.push(`${own.length} custom container label(s) not carried over`);
}

function gitSourceOf(
	a: CoolifyApplication,
	s: CoolifySnapshot,
	notes: string[],
):
	| {
			source: ApplicationSpec["source"];
			gitProvider?: ServiceDraft["gitProvider"];
	  }
	| undefined {
	const repo = a.git_repository ?? "";
	if (!repo) return undefined;
	const app =
		a.source_type === MODEL.github
			? s.githubApps.find((g) => g.id === a.source_id)
			: undefined;
	if (a.source_type && a.source_type !== MODEL.github) {
		notes.push(
			`${a.source_type.split("\\").pop()} source must be reconnected in LogiStack`,
		);
		return undefined;
	}
	if ((a.private_key_id ?? 0) > 0 && !app) {
		notes.push(
			"deploys through an SSH deploy key; connect the repository through a provider",
		);
		return undefined;
	}
	const branch = a.git_branch || "main";
	const path = (a.base_directory ?? "/").replace(/^\/+|\/+$/g, "") || "/";
	if (app && !app.is_public)
		return {
			source: {
				type: "git",
				repository: repo
					.replace(/^https?:\/\/[^/]+\//, "")
					.replace(/\.git$/, ""),
				branch,
				path,
			},
			gitProvider: { type: "github", sourceId: String(app.id) },
		};
	const base = (app?.html_url ?? "https://github.com").replace(/\/+$/, "");
	return {
		source: {
			type: "git",
			repository: /^https?:\/\//.test(repo)
				? repo
				: `${base}/${repo.replace(/^\/+/, "")}`,
			branch,
			path,
		},
	};
}

function buildOf(
	a: CoolifyApplication,
	isStatic: boolean,
	notes: string[],
): BuildConfig | undefined {
	switch (a.build_pack) {
		case "dockerfile":
			return {
				type: "dockerfile",
				dockerfilePath: (a.dockerfile_location || "/Dockerfile").replace(
					/^\/+/,
					"",
				),
				context: ".",
				...(a.dockerfile_target_build && { target: a.dockerfile_target_build }),
			};
		case "static":
			return {
				type: "static",
				publishDir: (a.publish_directory || "/").replace(/^\/+/, "") || ".",
			};
		case "nixpacks":
		case "railpack":
			if (isStatic)
				return {
					type: "static",
					publishDir: (a.publish_directory || "/").replace(/^\/+/, "") || ".",
				};
			if (a.build_pack === "nixpacks")
				notes.push("built with Railpack instead of Nixpacks");
			if (a.install_command || a.build_command || a.start_command)
				notes.push(
					"custom install, build or start commands are not carried over",
				);
			return { type: "railpack" };
		default:
			notes.push(`build pack ${a.build_pack} is not supported`);
			return undefined;
	}
}

function mapApplication(a: CoolifyApplication, ctx: Context): InventoryItem {
	const { s } = ctx;
	const notes: string[] = [];
	const settings = s.applicationSettings.find((x) => x.application_id === a.id);
	const compose = a.build_pack === "dockercompose";
	const item = (services: ServiceDraft[]): InventoryItem => ({
		kind: compose ? "compose" : "application",
		sourceId: a.uuid,
		appName: a.uuid,
		source: descriptor(
			a.uuid,
			services.some((x) => x.domains.length > 0),
		),
		name: a.name,
		project: ctx.project.name,
		environment: ctx.environment.name,
		status: !services.length
			? "unsupported"
			: notes.length
				? "partial"
				: "full",
		notes,
		services,
	});
	if (!onLocalhost(s, a, notes)) return item([]);
	if (settings?.is_preview_deployments_enabled)
		notes.push("preview deployments are not carried over");
	if (settings?.is_gpu_enabled) notes.push("GPU access is not carried over");
	if (a.pre_deployment_command || a.post_deployment_command)
		notes.push("pre- and post-deployment commands are not carried over");
	if (a.custom_docker_run_options)
		notes.push("custom docker run options are not carried over");
	customLabelNotes(a.custom_labels, notes);
	const env = envOf(ctx, MODEL.application, a.id, notes);
	if (compose)
		return item(
			composeDrafts(ctx, a, env, notes, [], a.docker_compose_domains),
		);

	let source: ApplicationSpec["source"] | undefined;
	let build: BuildConfig | undefined;
	let gitProvider: ServiceDraft["gitProvider"];
	if (a.build_pack === "dockerimage") {
		if (!a.docker_registry_image_name)
			notes.push("docker image app without an image");
		else {
			const tag = a.docker_registry_image_tag || "latest";
			source = {
				type: "image",
				image: `${a.docker_registry_image_name}:${tag}`,
			};
			build = { type: "image" };
		}
	} else if (a.build_pack === "dockerfile" && a.dockerfile) {
		notes.push(
			"built from a Dockerfile written in Coolify; LogiStack builds from a repository, so push it to one",
		);
	} else {
		const git = gitSourceOf(a, s, notes);
		if (!git) notes.push("the git source could not be carried over");
		else {
			source = git.source;
			gitProvider = git.gitProvider;
			build = buildOf(a, !!settings?.is_static, notes);
		}
	}
	const exposes = (a.ports_exposes ?? "")
		.split(",")
		.map((p) => Number(p.trim()))
		.filter((p) => Number.isInteger(p) && p > 0);
	const ports: PortMapping[] = [];
	for (const m of (a.ports_mappings ?? "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean)) {
		const pm = /^(\d+):(\d+)(?:\/(tcp|udp))?$/.exec(m);
		if (pm)
			ports.push({
				published: Number(pm[1]),
				target: Number(pm[2]),
				protocol: pm[3] === "udp" ? "udp" : "tcp",
				mode: "host",
			});
		else notes.push(`port mapping ${m} not understood, skipped`);
	}
	const { binds, mounts, adopted } = volumesOf(
		s,
		MODEL.application,
		a.id,
		notes,
	);
	const healthPort = Number(a.health_check_port) || exposes[0];
	const healthcheck =
		a.health_check_enabled && a.health_check_path?.startsWith("/") && healthPort
			? { type: "http" as const, port: healthPort, path: a.health_check_path }
			: undefined;
	const domains = domainsOf(a.fqdn, exposes[0], notes);
	if (!source || !build) return item([]);
	const spec = ApplicationSpec.safeParse({
		kind: "application",
		source,
		build,
		ports,
		replicas: 1,
		resources: resourcesOf(a, notes),
		placement: [],
		...(healthcheck && { healthcheck }),
		...(binds.length && { mounts: binds }),
	});
	if (!spec.success) {
		notes.push(
			...spec.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
		);
		return item([]);
	}
	// A consistent container name is the one other containers may use; else nothing reaches it by name.
	const internal = settings?.is_consistent_container_name_enabled
		? (settings.custom_internal_name || a.uuid).toLowerCase()
		: undefined;
	const slug = internal ?? (slugify(a.name).slice(0, 63) || a.uuid);
	return item([
		{
			name: a.name,
			slug,
			dependsOn: [],
			importedFrom: `coolify:${a.uuid}`,
			spec: spec.data,
			mounts,
			adoptedVolumes: adopted,
			env,
			domains,
			basicAuth:
				a.is_http_basic_auth_enabled &&
				a.http_basic_auth_username &&
				a.http_basic_auth_password
					? [
							{
								username: a.http_basic_auth_username,
								password: a.http_basic_auth_password,
							},
						]
					: [],
			...(gitProvider && { gitProvider }),
			running: running(a.status),
			backups: [],
			bridge: {
				aliases: [...new Set([slug, a.uuid])],
				routes: domains.length > 0,
			},
		},
	]);
}

/** A compose split: `dockercompose` applications and one-click services. */
function composeDrafts(
	ctx: Context,
	r: { uuid: string; docker_compose_raw: string | null },
	env: EnvDraft[],
	notes: string[],
	parts: { name: string; fqdn: string | null; status: string | null }[] = [],
	composeDomains?: string | null,
): ServiceDraft[] {
	if (!r.docker_compose_raw) {
		notes.push("compose file is empty");
		return [];
	}
	let compose: unknown;
	try {
		compose = Bun.YAML.parse(r.docker_compose_raw);
	} catch {
		notes.push("compose file is not valid YAML");
		return [];
	}
	const kind = parts.length ? "services" : "applications";
	const mapped = mapComposeServices({
		appName: r.uuid,
		projectName: ctx.project.name,
		compose,
		dotenv: new Map(env.map((e) => [e.key, e.value])),
		source: "coolify",
		bindRoot: `${DATA_ROOT}/${kind}/${r.uuid}`,
		// Coolify creates every named volume itself as `<uuid>_<name>`, declared or not.
		undeclaredVolume: (key) => `${r.uuid}_${key}`,
		// Coolify-only keys: status checks, and file contents it writes next to the compose file.
		ignoredKeys: ["exclude_from_hc", "content", "isDirectory", "is_directory"],
	});
	if (mapped.kind === "refused") {
		notes.push(...mapped.unsupported);
		return [];
	}
	let byService: Record<string, { domain?: string }> = {};
	try {
		byService = composeDomains ? JSON.parse(composeDomains) : {};
	} catch {
		notes.push("compose domains are not valid JSON, skipped");
	}
	const drafts: ServiceDraft[] = [];
	for (const plan of mapped.plans) {
		notes.push(...plan.warnings.map((w) => `${plan.serviceName}: ${w}`));
		if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(plan.serviceName)) {
			notes.push(
				`service name ${plan.serviceName} is not a DNS label, so siblings could not reach it`,
			);
			return [];
		}
		const part = parts.find((p) => p.name === plan.serviceName);
		// `SERVICE_FQDN_APP_3000`: the port Coolify routes the part's domain to.
		const magicPort = plan.env
			.map((e) => /^SERVICE_(?:FQDN|URL)_[A-Z0-9_]*?_(\d+)$/.exec(e.key)?.[1])
			.find(Boolean);
		const fallback =
			(magicPort && Number(magicPort)) || plan.spec.ports[0]?.target || 80;
		const domains = domainsOf(
			part?.fqdn ?? byService[plan.serviceName]?.domain ?? null,
			fallback,
			notes,
		);
		for (const d of plan.domains)
			if (!domains.some((x) => x.hostname === d.hostname))
				domains.push({
					hostname: d.hostname,
					port: d.port,
					https: true,
					cert: "auto",
				});
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
				source: "coolify" as const,
			})),
			env: plan.env,
			domains,
			basicAuth: [],
			running: part ? running(part.status) : true,
			backups: [],
			// Coolify names the container `<service>-<uuid>`.
			bridge: {
				aliases: [`${plan.serviceName}-${r.uuid}`],
				routes: domains.length > 0,
			},
		});
	}
	return dependencyOrder(drafts, notes);
}

function mapService(svc: CoolifyService, ctx: Context): InventoryItem {
	const { s } = ctx;
	const notes: string[] = [];
	const parts = s.serviceParts.filter((p) => p.service_id === svc.id);
	const item = (services: ServiceDraft[]): InventoryItem => ({
		kind: "service",
		sourceId: svc.uuid,
		appName: svc.uuid,
		source: descriptor(
			svc.uuid,
			services.some((x) => x.domains.length > 0),
		),
		name: svc.name,
		project: ctx.project.name,
		environment: ctx.environment.name,
		status: !services.length
			? "unsupported"
			: notes.length
				? "partial"
				: "full",
		notes,
		services,
	});
	if (svc.server_id !== 0) {
		notes.push("runs on a remote Coolify server");
		return item([]);
	}
	for (const p of parts.filter((p) => p.is_public))
		notes.push(
			`${p.name} is published on port ${p.public_port}; LogiStack does not publish it`,
		);
	const env = envOf(ctx, MODEL.service, svc.id, notes);
	return item(composeDrafts(ctx, svc, env, notes, parts));
}

/** The env each engine's official image initialises from, with Coolify's credentials. */
function credentialsEnv(d: CoolifyDatabase): EnvDraft[] {
	const secret = (key: string, value: string | null) =>
		value ? [{ key, value, isSecret: true }] : [];
	const plain = (key: string, value: string | null) =>
		value ? [{ key, value, isSecret: false }] : [];
	switch (d.engine) {
		case "postgres":
			return [
				...plain("POSTGRES_USER", d.user),
				...secret("POSTGRES_PASSWORD", d.password),
				...plain("POSTGRES_DB", d.database),
			];
		case "mysql":
			return [
				...secret("MYSQL_ROOT_PASSWORD", d.root_password),
				...plain("MYSQL_USER", d.user),
				...secret("MYSQL_PASSWORD", d.password),
				...plain("MYSQL_DATABASE", d.database),
			];
		case "mariadb":
			return [
				...secret("MARIADB_ROOT_PASSWORD", d.root_password),
				...plain("MARIADB_USER", d.user),
				...secret("MARIADB_PASSWORD", d.password),
				...plain("MARIADB_DATABASE", d.database),
			];
		case "mongo":
			return [
				...plain("MONGO_INITDB_ROOT_USERNAME", d.user),
				...secret("MONGO_INITDB_ROOT_PASSWORD", d.password),
				...plain("MONGO_INITDB_DATABASE", d.database),
			];
		default:
			return [];
	}
}

const OFFICIAL = /^(?:docker\.io\/)?(?:library\/)?([a-z]+):([A-Za-z0-9_.-]+)$/;

/** Coolify's frequency aliases, as cron. */
const FREQUENCY: Record<string, string> = {
	every_minute: "* * * * *",
	hourly: "0 * * * *",
	daily: "0 0 * * *",
	weekly: "0 0 * * 0",
	monthly: "0 0 1 * *",
	yearly: "0 0 1 1 *",
};

function backupsOf(
	d: CoolifyDatabase,
	s: CoolifySnapshot,
	notes: string[],
): BackupDraft[] {
	const out: BackupDraft[] = [];
	for (const b of s.backups.filter(
		(b) =>
			b.database_type === DATABASE_MODEL[d.engine] && b.database_id === d.id,
	)) {
		const cron = FREQUENCY[b.frequency] ?? b.frequency;
		if (!Cron.safeParse(cron).success) {
			notes.push(
				`backup schedule "${b.frequency}" is not a 5-field cron, skipped`,
			);
			continue;
		}
		if (!b.save_s3) {
			notes.push(
				"a backup kept on the server only is not carried over; LogiStack backs up to S3",
			);
			continue;
		}
		const destinations = new Set(
			[
				b.s3_storage_id,
				...s.backupDestinations
					.filter((x) => x.scheduled_database_backup_id === b.id)
					.map((x) => x.s3_storage_id),
			].filter((x): x is number => x !== null),
		);
		if (!destinations.size)
			notes.push("a backup has no S3 destination, skipped");
		const count = b.database_backup_retention_amount_s3 ?? 0;
		for (const destination of destinations)
			out.push({
				destination: String(destination),
				cron,
				retention: count > 0 ? { count } : {},
				enabled: b.enabled ?? true,
			});
	}
	return out;
}

function mapDatabase(d: CoolifyDatabase, ctx: Context): InventoryItem {
	const { s } = ctx;
	const notes: string[] = [];
	const item = (services: ServiceDraft[]): InventoryItem => ({
		kind: d.engine,
		sourceId: d.uuid,
		appName: d.uuid,
		source: descriptor(d.uuid, false),
		name: d.name,
		project: ctx.project.name,
		environment: ctx.environment.name,
		status: !services.length
			? "unsupported"
			: notes.length
				? "partial"
				: "full",
		notes,
		services,
	});
	if (!onLocalhost(s, d, notes)) return item([]);
	if (!SUPPORTED_ENGINES.has(d.engine)) {
		notes.push(`${d.engine} is not an engine LogiStack runs`);
		return item([]);
	}
	if (d.enable_ssl) {
		notes.push(
			"served over SSL in Coolify; LogiStack databases do not terminate SSL",
		);
		return item([]);
	}
	const image = OFFICIAL.exec(d.image);
	if (!image || image[1] !== d.engine) {
		notes.push(
			`custom image ${d.image}; LogiStack runs the official ${d.engine} image`,
		);
		return item([]);
	}
	const spec = DatabaseSpec.safeParse({
		kind: "database",
		engine: d.engine,
		version: image[2],
		credentialsRef: "coolify",
		resources: resourcesOf(d, notes),
	});
	if (!spec.success) {
		notes.push(
			...spec.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
		);
		return item([]);
	}
	const dataDir = dataDirOf(spec.data) as string;
	const vols = s.volumes.filter(
		(v) =>
			v.resource_type === DATABASE_MODEL[d.engine] && v.resource_id === d.id,
	);
	const data = vols.find(
		(v) => !v.host_path && v.mount_path.replace(/(.)\/+$/, "$1") === dataDir,
	);
	if (!data) {
		notes.push(
			`no volume mounted at ${dataDir}; the data would not carry over`,
		);
		return item([]);
	}
	if (vols.length > 1)
		notes.push("volumes besides the data volume are not carried over");
	if (d.is_public) notes.push(`public port ${d.public_port} is not published`);
	if (d.conf) notes.push("custom configuration file is not carried over");
	if (d.init_scripts && d.init_scripts !== "[]")
		notes.push("init scripts are not carried over");
	if (d.custom_docker_run_options)
		notes.push("custom docker run options are not carried over");
	if (
		s.undecryptable.some(
			(u) => u.table.startsWith("standalone_") && u.id === d.name,
		)
	)
		notes.push("its password could not be decrypted with Coolify's APP_KEY");
	const credentials = credentialsEnv(d);
	const extra = envOf(ctx, DATABASE_MODEL[d.engine], d.id, notes);
	return item([
		{
			name: d.name,
			slug: d.uuid,
			dependsOn: [],
			importedFrom: `coolify:${d.uuid}`,
			spec: spec.data,
			mounts: [],
			adoptedVolumes: [
				{ target: dataDir, volume: data.name, source: "coolify" },
			],
			env: [
				...credentials,
				...extra.filter((e) => !credentials.some((c) => c.key === e.key)),
			],
			domains: [],
			basicAuth: [],
			running: running(d.status),
			backups: backupsOf(d, s, notes),
			bridge: { aliases: [d.uuid], routes: false },
		},
	]);
}

export function buildCoolifyInventory(s: CoolifySnapshot): Inventory {
	const environments = new Map(s.environments.map((e) => [e.id, e]));
	const projects = new Map(s.projects.map((p) => [p.id, p]));
	const contextOf = (environmentId: number): Context => {
		const e = environments.get(environmentId);
		const p = e ? projects.get(e.project_id) : undefined;
		return {
			s,
			project: p ?? { id: -1, name: "Imported", team_id: 0 },
			environment: e ?? { id: -1, name: "production" },
		};
	};
	const org = buildCoolifyOrgItems(s);
	const items = crossChecks([
		...s.databases.map((d) => mapDatabase(d, contextOf(d.environment_id))),
		...s.applications.map((a) =>
			mapApplication(a, contextOf(a.environment_id)),
		),
		...s.services.map((x) => mapService(x, contextOf(x.environment_id))),
	]);
	orgChecks(items, org);
	return { items, org };
}
