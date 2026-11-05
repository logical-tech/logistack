/**
 * Imports Dokploy compose projects as LogiStack application services, through the API's own
 * routes (validation, permission checks, audit as `system:import-dokploy`). Run inside the
 * api container with Dokploy's compose directory mounted at /import:
 *
 *   bun apps/server/scripts/import-dokploy.ts --source /import --org <slug>
 *     [--folder "Imported from Dokploy"] [--dry-run] [--deploy] [--stopped <appName,...>]
 *     [--allow-sensitive] [--dokploy-db postgres://...] [--no-pin]
 *
 * Idempotent: a service whose `imported_from` marker exists in the organization is skipped.
 * With the Docker socket mounted, each image is pinned to what Dokploy's container runs, since a
 * mutable compose tag (`:stable`) may resolve to another version by now; `--no-pin` opts out.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { environment, organization, project, service } from "@logistack/db";
import { createDockerClient, type DockerClient } from "@logistack/docker";
import { and, eq, isNotNull } from "drizzle-orm";
import { systemActor } from "../src/actor.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Deps } from "../src/env.ts";
import { closeDeps, createDeps } from "../src/index.ts";
import { setLogLevel } from "../src/log.ts";
import { slugify } from "../src/openapi.ts";
import {
	type ImportPlan,
	type Mapped,
	mapCompose,
	parseDotenv,
	projectNameFromFolder,
} from "./dokploy-compose.ts";

export const ACTOR_ID = "import-dokploy";

/** What pinning learns from the image a Dokploy container runs. */
export type RunningImage = {
	repoDigests: string[];
	env: string[];
	labels: Record<string, string>;
};

/** Docker access pinning needs; injected so tests can stand in for the host. */
export type ImageProbe = {
	/** The image of a container Dokploy runs for this compose service, if any exists. */
	running(appName: string, service: string): Promise<RunningImage | undefined>;
	tagExists(ref: string): Promise<boolean>;
};

/** `ref` without its tag or digest; a `:` before the last `/` is a registry port. */
const repoOf = (ref: string) => {
	const name = ref.split("@")[0] as string;
	const colon = name.lastIndexOf(":");
	return colon > name.lastIndexOf("/") ? name.slice(0, colon) : name;
};

/** Docker Hub spells one repository several ways. */
const hubName = (repo: string) =>
	repo
		.replace(/^(docker\.io|index\.docker\.io)\//, "")
		.replace(/^library\//, "");

const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * The exact image a running container uses, for a compose `ref` whose tag may have moved since:
 * `repo:<version>` when the image's `VERSION` env or OCI version label names a tag that exists,
 * else `repo@<repo digest>`. Undefined when `ref` is already a digest or nothing identifies it.
 */
export async function pinImage(
	ref: string,
	image: RunningImage,
	tagExists: (ref: string) => Promise<boolean>,
): Promise<{ image: string; why: string } | undefined> {
	if (ref.includes("@")) return undefined;
	const repo = repoOf(ref);
	const versions: [string | undefined, string][] = [
		[image.env.find((e) => e.startsWith("VERSION="))?.slice(8), "VERSION env"],
		[
			image.labels["org.opencontainers.image.version"],
			"org.opencontainers.image.version label",
		],
	];
	for (const [version, why] of versions)
		if (version && TAG.test(version) && (await tagExists(`${repo}:${version}`)))
			return {
				image: `${repo}:${version}`,
				why: `${why} of the running image`,
			};
	const digest = image.repoDigests
		.find((d) => hubName(repoOf(d)) === hubName(repo))
		?.split("@")[1];
	return digest
		? { image: `${repo}@${digest}`, why: "repo digest of the running image" }
		: undefined;
}

/** Finds the container by compose labels, or by stack service name for Dokploy's stack mode. */
export function dockerProbe(docker: DockerClient): ImageProbe {
	return {
		async running(appName, svc) {
			for (const label of [
				[
					`com.docker.compose.project=${appName}`,
					`com.docker.compose.service=${svc}`,
				],
				[`com.docker.swarm.service.name=${appName}_${svc}`],
			]) {
				const found = await docker.containers.list({ label }, true);
				const c = found.find((x) => x.State === "running") ?? found[0];
				if (!c) continue;
				const img = await docker.images.inspect(c.ImageID);
				return {
					repoDigests: img.RepoDigests ?? [],
					env: img.Config.Env ?? [],
					labels: img.Config.Labels ?? {},
				};
			}
		},
		tagExists: (ref) =>
			docker.images.distribution(ref).then(
				() => true,
				() => false,
			),
	};
}

export type ImportOptions = {
	source: string;
	org: string;
	folder: string;
	dryRun: boolean;
	deploy: boolean;
	/** Dokploy appNames created with desired state stopped. */
	stopped: string[];
	allowSensitive: boolean;
	/** Dokploy's own Postgres, for project and compose names; folder names otherwise. */
	dokployDb?: string;
	/** Pins each image to what Dokploy runs; unset (`--no-pin`, no socket) keeps the compose tag. */
	images?: ImageProbe;
};

type DokployName = { project: string; compose: string };

async function dokployNames(
	url: string,
	print: (line: string) => void,
): Promise<Map<string, DokployName>> {
	const sql = new Bun.SQL(url);
	try {
		// Dokploy >= 0.25 schema: compose → environment → project.
		const rows: { appName: string; compose: string; project: string }[] =
			await sql`select c."appName", c."name" as compose, p."name" as project
				from compose c
				join environment e on e."environmentId" = c."environmentId"
				join project p on p."projectId" = e."projectId"`;
		return new Map(rows.map((r) => [r.appName, r]));
	} catch (error) {
		print(
			`warning: Dokploy database unreachable, names derive from folders (${error instanceof Error ? error.message : error})`,
		);
		return new Map();
	} finally {
		await sql.close();
	}
}

/** Every `<source>/<appName>/code/docker-compose.yml`, mapped; unreadable ones are refusals. */
export function readSource(
	source: string,
	names: Map<string, DokployName>,
	allowSensitive: boolean,
): (Mapped & { description: string })[] {
	return readdirSync(source, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort()
		.map((appName) => {
			const name = names.get(appName);
			const description = `Imported from Dokploy (${name ? `project ${name.project}, ` : ""}compose ${appName})`;
			const code = join(source, appName, "code");
			const file = ["docker-compose.yml", "docker-compose.yaml"]
				.map((f) => join(code, f))
				.find(existsSync);
			const refuse = (why: string) => ({
				kind: "refused" as const,
				appName,
				projectName: name?.compose ?? projectNameFromFolder(appName),
				unsupported: [why],
				description,
			});
			if (!file) return refuse("no code/docker-compose.yml");
			let compose: unknown;
			try {
				compose = Bun.YAML.parse(readFileSync(file, "utf8"));
			} catch (error) {
				return refuse(`invalid YAML: ${(error as Error).message}`);
			}
			const envFile = join(code, ".env");
			return {
				...mapCompose({
					appName,
					...(name && { projectName: name.compose }),
					compose,
					dotenv: parseDotenv(
						existsSync(envFile) ? readFileSync(envFile, "utf8") : "",
					),
					allowSensitive,
				}),
				description,
			};
		});
}

/** The plan as text: keys, ports, paths and hostnames, never an env value. */
export function describePlan(
	p: ImportPlan,
	state: string,
	pinned?: string,
): string[] {
	const s = p.spec;
	const lines = [
		`  service  ${p.serviceName}  image ${s.source.type === "image" ? s.source.image : ""}`,
		...(pinned ? [`  pinned   ${pinned}`] : []),
		`  ports    ${s.ports.map((x) => `${x.published ? `${x.published}:` : ""}${x.target}/${x.protocol}${x.mode ? ` ${x.mode}` : ""}`).join(", ") || "-"}`,
		`  mounts   ${s.mounts?.map((m) => `${m.hostPath}:${m.target}${m.readOnly ? ":ro" : ""}${m.allowSensitiveHostPath ? " (sensitive)" : ""}`).join(", ") || "-"}`,
		`  volumes  ${p.volumes.map((v) => `${v.volume}:${v.target} (adopted)`).join(", ") || "-"}`,
	];
	const host = [
		s.user && `user ${s.user}`,
		s.capAdd && `cap_add ${s.capAdd.join(",")}`,
		s.capDrop && `cap_drop ${s.capDrop.join(",")}`,
		s.restart && `restart ${s.restart}`,
	].filter(Boolean);
	if (host.length) lines.push(`  host     ${host.join("  ")}`);
	lines.push(
		`  env      ${p.env.map((e) => (e.isSecret ? `${e.key} (secret)` : e.key)).join(", ") || "-"}`,
		`  domains  ${p.domains.map((d) => `${d.hostname} -> ${d.port} (https auto)`).join(", ") || "-"}`,
		`  state    ${state}`,
		...p.warnings.map((w) => `  warning  ${w}`),
	);
	return lines;
}

/** `importedFrom` markers of every service in the organization. */
async function importedMarkers(deps: Deps, organizationId: string) {
	const rows = await deps.db
		.select({ importedFrom: service.importedFrom })
		.from(service)
		.innerJoin(environment, eq(environment.id, service.environmentId))
		.innerJoin(project, eq(project.id, environment.projectId))
		.where(
			and(
				eq(project.organizationId, organizationId),
				isNotNull(service.importedFrom),
			),
		);
	return new Set(rows.map((r) => r.importedFrom));
}

export type ImportSummary = {
	created: number;
	skipped: number;
	refused: number;
	failed: number;
};

export async function runImport(
	deps: Deps,
	opts: ImportOptions,
	print: (line: string) => void = console.log,
): Promise<ImportSummary> {
	const [org] = await deps.db
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.slug, opts.org));
	if (!org) throw new Error(`organization "${opts.org}" not found`);
	const actor = await systemActor(deps.db, org.id, ACTOR_ID);
	if (!actor) throw new Error(`organization "${opts.org}" has no owner`);

	const names = opts.dokployDb
		? await dokployNames(opts.dokployDb, print)
		: new Map<string, DokployName>();
	const mapped = readSource(opts.source, names, opts.allowSensitive);
	for (const unknown of opts.stopped.filter(
		(a) => !mapped.some((m) => m.appName === a),
	))
		print(`warning: --stopped ${unknown} is not in ${opts.source}`);
	const existing = await importedMarkers(deps, org.id);
	const summary: ImportSummary = {
		created: 0,
		skipped: 0,
		refused: 0,
		failed: 0,
	};

	const app = createApp(deps, { actor });
	const call = async <T = { id: string }>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> => {
		const res = await app.request(`/api${path}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const json = (await res.json().catch(() => null)) as {
			error?: { message?: string; details?: unknown };
		} | null;
		if (!res.ok) {
			const e = json?.error;
			throw new Error(
				`${method} ${path}: ${e?.message ?? res.status}${e?.details ? ` ${JSON.stringify(e.details)}` : ""}`,
			);
		}
		return json as T;
	};

	print(
		`${opts.dryRun ? "Dry run: " : ""}importing ${mapped.length} Dokploy compose project(s) into folder "${opts.folder}" of ${opts.org}`,
	);
	let folderId: string | undefined;
	for (const m of mapped) {
		const head = `${m.projectName} (dokploy ${m.appName})`;
		if (m.kind === "refused") {
			summary.refused++;
			print(`refuse  ${head}: unsupported ${m.unsupported.join("; ")}`);
			continue;
		}
		if (existing.has(m.importedFrom)) {
			summary.skipped++;
			print(`skip    ${head}: already imported`);
			continue;
		}
		const stopped = opts.stopped.includes(m.appName);
		const state = stopped
			? "stopped"
			: opts.deploy
				? "running, deployment queued"
				: "running, not deployed (pass --deploy)";
		print(`${opts.dryRun ? "plan  " : "create"}  ${head}`);
		let pinned: string | undefined;
		if (opts.images && m.spec.source.type === "image") {
			const from = m.spec.source.image;
			const running = await opts.images.running(m.appName, m.serviceName);
			const pin =
				running && (await pinImage(from, running, opts.images.tagExists));
			if (pin && pin.image !== from) {
				m.spec.source = { ...m.spec.source, image: pin.image };
				pinned = `${from} -> ${pin.image} (${pin.why})`;
			} else if (running && !pin)
				pinned = `${from} kept: the running image has no registry digest`;
		}
		for (const line of describePlan(m, state, pinned)) print(line);
		if (opts.dryRun) continue;
		try {
			folderId ??= await ensureFolder(call, opts.folder);
			const projects = await call<{ id: string; slug: string }[]>(
				"GET",
				`/projects?folderId=${folderId}`,
			);
			const prj =
				projects.find((p) => p.slug === slugify(m.projectName)) ??
				(await call<{ id: string }>("POST", "/projects", {
					name: m.projectName,
					description: m.description,
					folderId,
				}));
			const envs = await call<{ id: string; kind: string }[]>(
				"GET",
				`/projects/${prj.id}/environments`,
			);
			const env = envs.find((e) => e.kind === "production");
			if (!env)
				throw new Error(
					`project ${m.projectName} has no production environment`,
				);
			const svc = await call("POST", `/environments/${env.id}/services`, {
				name: m.serviceName,
				spec: m.spec,
				importedFrom: m.importedFrom,
				...(m.volumes.length && {
					mounts: m.volumes.map((v) => ({
						kind: "volume",
						target: v.target,
						name: v.name,
					})),
					adoptedVolumes: m.volumes.map((v) => ({
						target: v.target,
						volume: v.volume,
						source: "dokploy",
					})),
				}),
			});
			if (stopped) await call("POST", `/services/${svc.id}/stop`);
			if (m.env.length)
				await call("PUT", `/services/${svc.id}/env-vars`, {
					variables: m.env.map((e) => ({ ...e, isBuildTime: false })),
				});
			for (const d of m.domains)
				await call("POST", `/services/${svc.id}/domains`, {
					hostname: d.hostname,
					port: d.port,
					https: true,
					cert: "auto",
				});
			if (!stopped && opts.deploy)
				await call("POST", `/services/${svc.id}/deploy`);
			summary.created++;
			print(`  done     service ${svc.id}`);
		} catch (error) {
			summary.failed++;
			print(`  failed   ${(error as Error).message}`);
		}
	}
	print(
		`${summary.created} created, ${summary.skipped} skipped, ${summary.refused} refused, ${summary.failed} failed`,
	);
	return summary;
}

async function ensureFolder(
	call: <T>(method: string, path: string, body?: unknown) => Promise<T>,
	name: string,
): Promise<string> {
	const tree = await call<{ id: string; name: string }[]>("GET", "/folders");
	const found = tree.find((f) => f.name === name);
	if (found) return found.id;
	return (await call<{ id: string }>("POST", "/folders", { name })).id;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			source: { type: "string" },
			org: { type: "string" },
			folder: { type: "string", default: "Imported from Dokploy" },
			"dry-run": { type: "boolean", default: false },
			deploy: { type: "boolean", default: false },
			stopped: { type: "string", default: "" },
			"allow-sensitive": { type: "boolean", default: false },
			"dokploy-db": { type: "string" },
			"no-pin": { type: "boolean", default: false },
		},
		strict: true,
	});
	if (!values.source || !values.org) {
		console.error(
			"usage: bun apps/server/scripts/import-dokploy.ts --source /import --org <slug> [--folder <name>] [--dry-run] [--deploy] [--stopped <appName,...>] [--allow-sensitive] [--dokploy-db <url>] [--no-pin]",
		);
		process.exit(2);
	}
	const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
	const pin = !values["no-pin"] && existsSync(socket);
	if (!values["no-pin"] && !pin)
		console.log(
			`warning: no Docker socket at ${socket}, images keep their compose tags (mount it, or pass --no-pin)`,
		);
	const config = loadConfig();
	setLogLevel(config.LOG_LEVEL);
	const deps = await createDeps(config);
	let code = 1;
	try {
		const summary = await runImport(deps, {
			source: values.source,
			org: values.org,
			folder: values.folder,
			dryRun: values["dry-run"],
			deploy: values.deploy,
			stopped: values.stopped.split(",").filter(Boolean),
			allowSensitive: values["allow-sensitive"],
			...(values["dokploy-db"] && { dokployDb: values["dokploy-db"] }),
			...(pin && {
				images: dockerProbe(createDockerClient({ socketPath: socket })),
			}),
		});
		code = summary.failed ? 1 : 0;
	} catch (error) {
		console.error((error as Error).message);
	} finally {
		await closeDeps(deps);
	}
	// Like index.ts: queue and bus clients can keep the event loop alive after closing.
	process.exit(code);
}
