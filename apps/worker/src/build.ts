import { mkdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import type { ApplicationSpec } from "@logistack/contracts";
import {
	jsonLines,
	managedLabels,
	type RegistryAuth,
	registryAuthHeader,
	type ServiceSpec,
} from "@logistack/docker";
import { inspectService, upsertService } from "./apply.ts";
import { log } from "./bus.ts";
import { type Ctx, scope } from "./ctx.ts";
import type { GitAuth } from "./load.ts";
import { publicAddress } from "./ssrf.ts";

/** Splits `ssh://[user@]host[:port]/path` or scp-style `user@host:path` around its host. */
export function sshHost(
	url: string,
): { host: string; withHost: (h: string) => string } | null {
	if (url.startsWith("ssh://")) {
		const u = URL.parse(url);
		if (!u?.hostname) return null;
		return {
			host: u.hostname,
			withHost: (h) => {
				const pinned = new URL(url);
				pinned.hostname = h;
				return pinned.href;
			},
		};
	}
	const m = /^([\w.-]+@)?([\w.-]+):(.+)$/.exec(url);
	if (!m?.[2]) return null;
	return { host: m[2], withHost: (h) => `${m[1] ?? ""}${h}:${m[3]}` };
}

export type LogLine = (line: string) => void;

/** Children get only what they need: never the worker's DATABASE_URL or master key. */
const baseEnv = () => ({
	PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
	HOME: process.env.HOME ?? "/tmp",
});

async function pipeLines(stream: ReadableStream<Uint8Array>, out: LogLine) {
	let buf = "";
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		buf += decoder.decode(chunk, { stream: true });
		const lines = buf.split(/\r?\n/);
		buf = lines.pop() ?? "";
		for (const l of lines) out(l);
	}
	if (buf) out(buf);
}

/**
 * Runs argv (never a shell) and streams its output as log lines. `stdout` may instead be
 * consumed raw (buildctl writes the image tarball there). Aborting `signal` kills this child only.
 */
export async function run(
	argv: string[],
	o: {
		log: LogLine;
		signal: AbortSignal;
		cwd?: string;
		env?: Record<string, string>;
		stdout?: (s: ReadableStream<Uint8Array>) => Promise<void>;
	},
): Promise<string> {
	const [cmd] = argv;
	const child = Bun.spawn(argv, {
		cwd: o.cwd,
		env: { ...baseEnv(), ...o.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal: o.signal,
		killSignal: "SIGKILL",
	});
	let captured = "";
	const out = o.stdout
		? o.stdout(child.stdout)
		: pipeLines(child.stdout, (l) => {
				captured += `${l}\n`;
				o.log(l);
			});
	await Promise.all([out, pipeLines(child.stderr, o.log), child.exited]);
	o.signal.throwIfAborted();
	if (child.exitCode !== 0)
		throw new Error(`${cmd} exited with code ${child.exitCode}`);
	return captured.trim();
}

export type CloneResult = {
	dir: string;
	commitSha: string;
	commitMessage: string;
};

export async function clone(
	ctx: Ctx,
	source: Extract<ApplicationSpec["source"], { type: "git" }>,
	o: {
		deploymentId: string;
		auth?: GitAuth;
		log: LogLine;
		signal: AbortSignal;
	},
): Promise<CloneResult> {
	const url = o.auth?.url ?? source.repository;
	const local = url.startsWith("file://") || !/^[a-z]+:\/\//.test(url);
	if (o.auth?.kind !== "ssh") {
		if (local && !ctx.cfg.LS_ALLOW_LOCAL_GIT)
			throw new Error(`unsupported repository URL ${url}: use https://`);
		if (!local && !/^https:\/\//.test(url))
			throw new Error(`unsupported repository URL ${url}: use https://`);
	}
	const dir = join(ctx.cfg.LS_WORK_DIR, "builds", o.deploymentId);
	const keys = `${dir}.ssh`;
	await rm(dir, { recursive: true, force: true });
	await mkdir(dirname(dir), { recursive: true });
	try {
		const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
		const config: [string, string][] = [];
		let target = url;
		const pin = (a: string) => (isIP(a) === 6 ? `[${a}]` : a);
		if (!local && o.auth?.kind !== "ssh") {
			// Connect to the address just checked, and never follow a redirect to an unchecked one.
			const { hostname, port } = new URL(url);
			const address = await publicAddress(ctx, hostname);
			config.push(
				["http.curloptResolve", `${hostname}:${port || 443}:${pin(address)}`],
				["http.followRedirects", "false"],
			);
		}
		if (o.auth?.kind === "https")
			// Credentials travel as an HTTP header set through env-only git config, never argv or the URL.
			config.push([
				"http.extraHeader",
				`Authorization: Basic ${btoa(`${o.auth.username}:${o.auth.password}`)}`,
			]);
		if (o.auth?.kind === "ssh") {
			const host = sshHost(url);
			if (!host) throw new Error(`unsupported SSH URL ${url}`);
			target = host.withHost(pin(await publicAddress(ctx, host.host)));
			await mkdir(keys, { recursive: true, mode: 0o700 });
			await writeFile(join(keys, "id"), o.auth.privateKey, { mode: 0o600 });
			await writeFile(join(keys, "known_hosts"), o.auth.knownHosts ?? "");
			// git runs this through sh; it holds only paths derived from the deployment id and a parsed hostname.
			env.GIT_SSH_COMMAND = `ssh -i '${join(keys, "id")}' -o IdentitiesOnly=yes -o BatchMode=yes -o HostKeyAlias='${host.host}' -o UserKnownHostsFile='${join(keys, "known_hosts")}' -o StrictHostKeyChecking=${o.auth.knownHosts ? "yes" : "accept-new"}`;
		}
		env.GIT_CONFIG_COUNT = String(config.length);
		config.forEach(([k, v], i) => {
			env[`GIT_CONFIG_KEY_${i}`] = k;
			env[`GIT_CONFIG_VALUE_${i}`] = v;
		});
		const git = (args: string[], cwd?: string) =>
			run(["git", ...args], { log: o.log, signal: o.signal, env, cwd });
		await git([
			"clone",
			"--depth",
			"1",
			"--single-branch",
			"--branch",
			source.branch,
			"--",
			target,
			dir,
		]);
		const commitSha = await git(["rev-parse", "HEAD"], dir);
		const commitMessage = await git(["log", "-1", "--format=%s"], dir);
		return { dir, commitSha, commitMessage };
	} finally {
		await rm(keys, { recursive: true, force: true });
	}
}

/** Resolves a user path inside the checkout; `..` escapes are rejected. */
function inside(root: string, p: string): string {
	const abs = resolve(root, p);
	const rel = relative(root, abs);
	if (rel.startsWith("..") || resolve(root, rel) !== abs)
		throw new Error(`path ${p} escapes the repository`);
	return abs;
}

export type BuildPlan = {
	/** buildctl arguments after `--addr <host>`. */
	args: string[];
	env: Record<string, string>;
	/** Runs before buildctl (railpack prepare). */
	prepare?: string[];
};

/**
 * Pure: the buildctl invocation for a build config. Secret build-time vars go through env, never argv.
 * Context vars are Dockerfile build args only: BuildKit hands an arg to the build only where an `ARG` declares it.
 */
export function buildPlan(o: {
	dir: string;
	appPath: string;
	build: ApplicationSpec["build"];
	buildEnv: { key: string; value: string; isSecret: boolean }[];
	/** The deployment's `LOGISTACK_*` values; none of them is secret. */
	context: Record<string, string>;
	imageRef: string;
	railpackFrontend: string;
}): BuildPlan {
	const app = inside(o.dir, o.appPath);
	const output = ["--output", `type=docker,name=${o.imageRef}`];
	const env: Record<string, string> = {};
	const vars: string[] = [];
	for (const v of [...o.buildEnv].sort((a, b) => (a.key < b.key ? -1 : 1))) {
		if (v.isSecret) {
			env[v.key] = v.value;
			vars.push("--secret", `id=${v.key},env=${v.key}`);
		} else vars.push("--opt", `build-arg:${v.key}=${v.value}`);
	}
	const common = ["build", "--progress", "plain"];
	switch (o.build.type) {
		case "dockerfile": {
			const file = inside(app, o.build.dockerfilePath);
			const args = [
				...common,
				"--frontend",
				"dockerfile.v0",
				"--local",
				`context=${inside(app, o.build.context)}`,
				"--local",
				`dockerfile=${dirname(file)}`,
				"--opt",
				`filename=${file.slice(dirname(file).length + 1)}`,
				...(o.build.target ? ["--opt", `target=${o.build.target}`] : []),
				...Object.entries(o.build.buildArgs ?? {})
					.sort(([a], [b]) => (a < b ? -1 : 1))
					.flatMap(([k, v]) => ["--opt", `build-arg:${k}=${v}`]),
				...vars,
				...Object.entries(o.context)
					.sort(([a], [b]) => (a < b ? -1 : 1))
					.flatMap(([k, v]) => ["--opt", `build-arg:${k}=${v}`]),
				...output,
			];
			return { args, env };
		}
		case "railpack": {
			const plan = join(app, "railpack-plan.json");
			return {
				prepare: ["prepare", app, "--plan-out", plan],
				args: [
					...common,
					"--frontend",
					"gateway.v0",
					"--opt",
					`source=${o.railpackFrontend}`,
					"--local",
					`context=${app}`,
					"--local",
					`dockerfile=${app}`,
					"--opt",
					"filename=railpack-plan.json",
					...vars,
					...output,
				],
				env,
			};
		}
		default:
			throw new Error(`build type ${o.build.type} is not supported yet`);
	}
}

const BUILDKIT_PORT = 1234;
export const buildkitName = (ctx: Ctx) =>
	`${ctx.cfg.LS_NAME_PREFIX}ls-buildkit`;
export const buildkitAddr = (ctx: Ctx) =>
	`tcp://${buildkitName(ctx)}:${BUILDKIT_PORT}`;

/** Rootless BuildKit as a managed system service on ls-control; Swarm cannot run privileged tasks. */
export async function ensureBuildkit(ctx: Ctx): Promise<void> {
	const name = buildkitName(ctx);
	if (await inspectService(ctx, name)) return;
	// shortcut: assumes a found service is serving; a crashlooping buildkit surfaces as a buildctl error.
	const labels = {
		...managedLabels({ resource: "buildkit", kind: "system", org: "system" }),
		...scope(ctx).labels,
	};
	const spec: ServiceSpec = {
		Name: name,
		Labels: labels,
		TaskTemplate: {
			ContainerSpec: {
				Image: ctx.cfg.LS_BUILDKIT_IMAGE,
				Labels: labels,
				Args: [
					"--addr",
					`tcp://0.0.0.0:${BUILDKIT_PORT}`,
					"--oci-worker-no-process-sandbox",
				],
				// Not in our hand-written types: rootless BuildKit needs these relaxed (API >= 1.44).
				...({
					Privileges: {
						Seccomp: { Mode: "unconfined" },
						AppArmor: { Mode: "disabled" },
						NoNewPrivileges: false,
					},
				} as object),
				Mounts: [
					{
						Type: "volume",
						Source: `${name}-cache`,
						Target: "/home/user/.local/share/buildkit",
						VolumeOptions: { Labels: labels },
					},
				],
			},
			RestartPolicy: { Condition: "any", Delay: 5e9 },
			Networks: [{ Target: ctx.cfg.LS_CONTROL_NETWORK }],
		},
		Mode: { Replicated: { Replicas: 1 } },
	};
	await upsertService(ctx, undefined, spec);
	log("info", "created buildkit service", { name });
	for (let i = 0; i < 120; i++) {
		const tasks = await ctx.docker.tasks.list({ service: [name] });
		if (tasks.some((t) => t.Status.State === "running")) return;
		await Bun.sleep(500);
	}
	throw new Error("buildkit did not start within 60 s");
}

const engineUrl = (path: string) => `http://docker/v1.47${path}`;

async function engineStream(
	ctx: Ctx,
	path: string,
	init: RequestInit,
	logLine: LogLine,
): Promise<void> {
	const res = await fetch(engineUrl(path), {
		...init,
		unix: ctx.cfg.DOCKER_SOCKET,
	} as RequestInit);
	if (!res.ok)
		throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
	for await (const msg of jsonLines<{
		stream?: string;
		status?: string;
		error?: string;
		errorDetail?: { message: string };
	}>(res.body as ReadableStream<Uint8Array>)) {
		if (msg.error) throw new Error(msg.errorDetail?.message ?? msg.error);
		const text = (msg.stream ?? msg.status ?? "").trim();
		if (text) logLine(text);
	}
}

// shortcut: images load/push are raw Engine calls; move them into @logistack/docker when a second caller needs them.
export const loadImage = (
	ctx: Ctx,
	tar: ReadableStream<Uint8Array>,
	logLine: LogLine,
	signal: AbortSignal,
) =>
	engineStream(
		ctx,
		"/images/load",
		{
			method: "POST",
			body: tar,
			headers: { "content-type": "application/x-tar" },
			signal,
		},
		logLine,
	);

export function pushImage(
	ctx: Ctx,
	ref: string,
	auth: RegistryAuth | undefined,
	logLine: LogLine,
	signal: AbortSignal,
) {
	const colon = ref.lastIndexOf(":");
	const name = ref.slice(0, colon);
	const tag = ref.slice(colon + 1);
	return engineStream(
		ctx,
		`/images/${encodeURIComponent(name)}/push?tag=${encodeURIComponent(tag)}`,
		{
			method: "POST",
			headers: auth ? { "x-registry-auth": registryAuthHeader(auth) } : {},
			signal,
		},
		logLine,
	);
}
