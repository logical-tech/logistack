/**
 * Pure mapping from an upstream compose file to LogiStack template services. Each source
 * adapter (coolify.ts, dokploy.ts) supplies how `${VAR}` interpolation resolves; this module
 * owns everything that is compose: services, volumes, ports, healthchecks, dependencies.
 */
import {
	type Capability,
	floatingTags,
	type Healthcheck,
	linuxCapabilities,
	type PortMapping,
	type RestartCondition,
	type TemplateInput,
	type TemplateService,
	templateRefs,
} from "@logistack/contracts";

export type Raw = Record<string, unknown>;
export const isRecord = (v: unknown): v is Raw =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Why a template cannot be converted; `code` groups the report. */
export type Reason = { code: string; detail: string };

export class Skip extends Error {
	constructor(readonly reasons: Reason[]) {
		super(reasons.map((r) => `${r.code}: ${r.detail}`).join("; "));
	}
}

/** Inputs collected while interpolating, keyed by what they generate so reuse dedupes. */
export class Inputs {
	readonly list: TemplateInput[] = [];
	private byIdentity = new Map<string, string>();

	/** Returns the key of the input for `identity`, creating it from `make(key)` the first time. */
	use(
		identity: string,
		preferred: string,
		make: (key: string) => TemplateInput,
	): string {
		const known = this.byIdentity.get(identity);
		if (known) return known;
		let key = inputKey(preferred);
		for (let n = 2; this.list.some((i) => i.key === key); n++)
			key = `${inputKey(preferred)}${n}`;
		this.list.push(make(key));
		this.byIdentity.set(identity, key);
		return key;
	}
}

/** `SERVICE_PASSWORD_POSTGRES` words → `postgresPassword`. */
export function inputKey(words: string): string {
	const parts = words
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
	const key = parts
		.map((w, i) => (i === 0 ? w : w[0]?.toUpperCase() + w.slice(1)))
		.join("");
	return /^[a-z]/.test(key) ? key : `v${key}`;
}

export const expr = (key: string) => `\${{ inputs.${key} }}`;

/** Resolves one `${NAME}` / `${NAME:-default}` occurrence to a fragment (may hold expressions). */
export type Resolve = (
	name: string,
	op: string | undefined,
	arg: string | undefined,
) => string;

const VARIABLE =
	/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])((?:[^{}]|\{[^{}]*\})*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Compose interpolation; `$$` is a literal `$`. */
export function interpolate(value: string, resolve: Resolve): string {
	return value.replace(
		VARIABLE,
		(m, braced?: string, op?: string, arg?: string, bare?: string) =>
			m === "$$" ? "$" : resolve((braced ?? bare) as string, op, arg),
	);
}

/** Compose accepts `KEY=value` lists and `{ KEY: value }` maps. */
export function entries(v: unknown): [string, string | undefined][] {
	if (Array.isArray(v))
		return v.map((item) => {
			const s = String(item);
			const eq = s.indexOf("=");
			return eq < 0 ? [s, undefined] : [s.slice(0, eq), s.slice(eq + 1)];
		});
	if (isRecord(v))
		return Object.entries(v).map(([k, val]) => [
			k,
			val === null || val === undefined ? undefined : String(val),
		]);
	return [];
}

/** POSIX-ish word splitting for string commands: quotes and backslashes, no expansion. */
export function shellSplit(s: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: "'" | '"' | null = null;
	let started = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i] as string;
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
			else cur += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			started = true;
		} else if (c === "\\" && i + 1 < s.length) {
			cur += s[++i];
			started = true;
		} else if (/\s/.test(c)) {
			if (started) out.push(cur);
			cur = "";
			started = false;
		} else {
			cur += c;
			started = true;
		}
	}
	if (quote) throw new Error("unterminated quote");
	if (started) out.push(cur);
	return out;
}

/** Keys mapped below, or dropped without changing behaviour; any other key refuses the template. */
const HANDLED = new Set([
	"privileged",
	"network_mode",
	"container_name",
	"hostname",
	"logging",
	"platform",
	"pull_policy",
	"stop_grace_period",
	"stop_signal",
	"labels",
	"exclude_from_hc",
	"init",
	"tty",
	"stdin_open",
	"networks",
	"restart",
	"expose",
	"ports",
	"image",
	"environment",
	"volumes",
	"depends_on",
	"healthcheck",
	"command",
	"entrypoint",
	"user",
	"cap_add",
	"cap_drop",
	"mem_limit",
	"cpus",
	"deploy",
	"security_opt",
	"links",
	"env_file",
	"build",
]);

const RESTART: Record<string, RestartCondition> = {
	always: "any",
	"unless-stopped": "any",
	"on-failure": "on-failure",
	no: "none",
};

const DATABASES = {
	postgres: {
		dataDir: "/var/lib/postgresql/data",
		required: [["POSTGRES_PASSWORD"]],
	},
	mysql: { dataDir: "/var/lib/mysql", required: [["MYSQL_ROOT_PASSWORD"]] },
	mariadb: { dataDir: "/var/lib/mysql", required: [["MARIADB_ROOT_PASSWORD"]] },
	mongo: {
		dataDir: "/data/db",
		required: [["MONGO_INITDB_ROOT_USERNAME"], ["MONGO_INITDB_ROOT_PASSWORD"]],
	},
} as const;

/** `postgres:16-alpine` or `docker.io/library/postgres:16` → engine and tag. */
function officialDatabase(image: string) {
	const m =
		/^(?:(?:docker\.io\/)?library\/)?(postgres|mysql|mariadb|mongo):([\w][\w.-]*)$/.exec(
			image,
		);
	if (!m || floatingTags.has(m[2] as string)) return undefined;
	return { engine: m[1] as keyof typeof DATABASES, version: m[2] as string };
}

const MEMORY = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i;
function memoryMb(v: unknown): number | undefined {
	const m = MEMORY.exec(String(v ?? ""));
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = (m[2] ?? "").toLowerCase();
	const mb =
		unit === "g"
			? n * 1024
			: unit === "m"
				? n
				: unit === "k"
					? n / 1024
					: n / 1048576;
	return Math.max(1, Math.round(mb));
}

export const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/, "");

export type Domain = { input: string; port: number };

export type ComposeContext = {
	/** Resolves `${VAR}` in environment values; may produce expressions. */
	resolve: Resolve;
	/** Domain routed to each compose service, decided by the adapter. */
	domains: Map<string, Domain>;
	/** Inputs that must never reach a spec (command, healthcheck) in clear. */
	secretInputs: Set<string>;
	/** Content for a bind source that is really a file the template ships, if any. */
	file?: (source: string) => string | undefined;
	/** `env_file: .env` entries, for adapters whose env file is known. */
	envFile?: [string, string][];
	/**
	 * Receives each service's `build:` keyed by service name, when the compose comes from a
	 * repository that can be built. Without it `build:` is refused.
	 */
	builds?: Map<string, ComposeBuild>;
};

/** A compose `build:` as written; paths are relative to the compose file's directory. */
export type ComposeBuild = {
	context: string;
	dockerfile: string;
	target?: string;
	args: Record<string, string>;
};

const BUILD_KEYS = new Set(["context", "dockerfile", "target", "args"]);

function parseBuild(
	raw: unknown,
	path: string,
	literal: (s: string) => string,
	skip: (code: string, detail: string) => void,
): ComposeBuild | undefined {
	const b = typeof raw === "string" ? { context: raw } : raw;
	if (!isRecord(b)) {
		skip("build", `${path}.build`);
		return undefined;
	}
	for (const k of Object.keys(b))
		if (!BUILD_KEYS.has(k)) skip("build", `${path}.build.${k}`);
	const context = literal(String(b.context ?? "."));
	// A remote context (git URL, tarball) is fetched by the builder, outside the repository.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(context) || context.includes("${{")) {
		skip("build", `${path}.build.context ${context}`);
		return undefined;
	}
	const args: Record<string, string> = {};
	for (const [k, v] of entries(b.args)) args[k] = literal(v ?? "");
	return {
		context,
		dockerfile: literal(String(b.dockerfile ?? "Dockerfile")),
		...(b.target !== undefined && { target: literal(String(b.target)) }),
		args,
	};
}

/**
 * Rewrites literal mentions of sibling hostnames to expressions: inside URLs (`@db:5432`,
 * `http://redis/`), a bare `db:5432`, or the whole value of a host-like key (`DB_HOST=db`).
 */
export function linkHosts(
	key: string,
	value: string,
	hosts: Map<string, string>,
): string {
	let v = value;
	const hostKey = /HOST|ADDR|SERVER|ENDPOINT/i.test(key);
	for (const [original, name] of hosts) {
		const esc = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const ref = `\${{ services.${name}.host }}`;
		v = v
			// Not the user in `//user:password@host`.
			.replace(
				new RegExp(`(//|@)${esc}(?=[:/]|$)(?![^/]*@)`, "g"),
				(_m, pre: string) => `${pre}${ref}`,
			)
			.replace(
				new RegExp(`^${esc}(?=:\\d+$${hostKey ? "|$" : ""})`),
				() => ref,
			);
	}
	return v;
}

function mapHealthcheck(
	raw: unknown,
	env: Record<string, string>,
	resolve: (s: string) => string,
): Healthcheck | undefined {
	if (!isRecord(raw) || raw.disable === true) return undefined;
	const test = Array.isArray(raw.test)
		? raw.test.map(String)
		: typeof raw.test === "string"
			? ["CMD-SHELL", raw.test]
			: [];
	const [kind, ...rest] = test;
	if (kind === "NONE" || rest.length === 0) return undefined;
	const argv =
		kind === "CMD-SHELL"
			? ["sh", "-c", rest.join(" ")]
			: kind === "CMD"
				? rest
				: test;
	// A value that needs an input is read from the container env instead, when a key holds it.
	const byValue = new Map(Object.entries(env).map(([k, v]) => [v, k]));
	let unresolved = false;
	const out = argv.map((a) =>
		resolve(a).replace(/\$\{\{[^}]*\}\}/g, (m) => {
			const key = byValue.get(m);
			if (key && kind === "CMD-SHELL") return `\${${key}}`;
			unresolved = true;
			return m;
		}),
	);
	return unresolved ? undefined : { type: "command", command: out };
}

/** Maps every compose service; throws Skip with every reason found. */
export function mapServices(
	compose: Raw,
	ctx: ComposeContext,
): TemplateService[] {
	const reasons: Reason[] = [];
	const skip = (code: string, detail: string) => reasons.push({ code, detail });
	for (const key of Object.keys(compose))
		if (
			!["services", "volumes", "networks", "version", "name"].includes(key) &&
			!key.startsWith("x-")
		)
			skip(key, `top-level ${key}`);
	const raw = isRecord(compose.services) ? compose.services : {};
	const originals = Object.keys(raw);
	if (!originals.length)
		throw new Skip([{ code: "empty", detail: "no services" }]);
	const names = new Map(originals.map((o) => [o, slug(o)]));
	if (
		new Set(names.values()).size !== names.size ||
		[...names.values()].some((n) => !n)
	)
		skip(
			"names",
			`service names collide once lowercased: ${originals.join(", ")}`,
		);
	const hosts = new Map([...names].sort((a, b) => b[0].length - a[0].length));

	/** Fields outside env: interpolated, with expressions only where the caller allows. */
	const literal = (s: string) => interpolate(s, ctx.resolve);
	const volumeUsers = new Map<string, string[]>();
	const services: TemplateService[] = [];

	for (const [original, name] of names) {
		const svc = raw[original];
		const path = `services.${original}`;
		if (!isRecord(svc)) {
			skip("invalid", path);
			continue;
		}
		for (const key of Object.keys(svc))
			if (!HANDLED.has(key)) skip(key, `${path}.${key}`);
		if (svc.network_mode !== undefined)
			skip("network_mode", `${path}.network_mode`);
		if (svc.privileged)
			skip("privileged", `${path}: Swarm services cannot run privileged`);
		for (const opt of Array.isArray(svc.security_opt)
			? svc.security_opt.map(String)
			: [])
			if (!/^no-new-privileges(:true)?$/.test(opt))
				skip("security_opt", `${path}.security_opt ${opt}`);
		for (const l of Array.isArray(svc.links) ? svc.links.map(String) : [])
			if (l.includes(":")) skip("links", `${path}.links ${l}`);
		const deploy = isRecord(svc.deploy) ? svc.deploy : {};
		for (const k of Object.keys(deploy))
			if (k !== "resources") skip("deploy", `${path}.deploy.${k}`);

		const env: Record<string, string> = {};
		const envFiles = Array.isArray(svc.env_file)
			? svc.env_file
			: svc.env_file
				? [svc.env_file]
				: [];
		if (envFiles.length) {
			if (
				!ctx.envFile ||
				envFiles.some(
					(f) => !/^\.\/?\.env$/.test(String(isRecord(f) ? f.path : f)),
				)
			)
				skip("env_file", `${path}.env_file`);
			else for (const [k, v] of ctx.envFile) env[k] = linkHosts(k, v, hosts);
		}
		for (const [key, value] of entries(svc.environment)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				skip("env", `${path}.environment.${key}`);
				continue;
			}
			const v =
				value === undefined
					? ctx.resolve(key, undefined, undefined)
					: literal(value);
			env[key] = linkHosts(key, v, hosts);
		}

		let build: ComposeBuild | undefined;
		if (svc.build !== undefined) {
			if (ctx.builds) {
				build = parseBuild(svc.build, path, literal, skip);
				if (build) ctx.builds.set(name, build);
			} else skip("build", `${path}.build`);
		}
		// A built service runs its own image; `image:` only names it in Docker Compose.
		const image = build
			? ""
			: typeof svc.image === "string"
				? literal(svc.image)
				: "";
		if (!image && !build) skip("image", `${path} has no image`);
		else if (image.includes("${{"))
			skip("image", `${path}.image takes a variable`);

		const argv = (key: "command" | "entrypoint"): string[] | undefined => {
			const v = svc[key];
			if (v === undefined || v === null) return undefined;
			let out: string[] | undefined;
			try {
				out = (Array.isArray(v) ? v.map(String) : shellSplit(String(v))).map(
					literal,
				);
			} catch {
				skip(key, `${path}.${key} does not parse`);
			}
			if (
				out?.some((a) =>
					templateRefs(a).some(
						(r) => r.kind === "input" && ctx.secretInputs.has(r.key),
					),
				)
			)
				skip(
					"command_secret",
					`${path}.${key} carries a secret on the command line`,
				);
			return out;
		};
		const command = argv("command");
		const entrypoint = argv("entrypoint");

		const ports: PortMapping[] = [];
		for (const p of [
			...(Array.isArray(svc.ports) ? svc.ports : []),
			...(Array.isArray(svc.expose) ? svc.expose.map(String) : []),
		]) {
			if (isRecord(p)) {
				const target = Number(literal(String(p.target)));
				const published =
					p.published === undefined
						? undefined
						: Number(literal(String(p.published)));
				if (
					!Number.isInteger(target) ||
					(published !== undefined && !Number.isInteger(published))
				) {
					skip("ports", `${path}.ports ${JSON.stringify(p)}`);
					continue;
				}
				if (!ports.some((x) => x.target === target))
					ports.push({
						target,
						protocol: p.protocol === "udp" ? "udp" : "tcp",
						...(published !== undefined && {
							published,
							mode: p.mode === "ingress" ? "ingress" : "host",
						}),
					});
				continue;
			}
			const m = /^(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/.exec(literal(String(p)));
			if (!m) {
				skip("ports", `${path}.ports "${p}" (host IPs and ranges)`);
				continue;
			}
			const protocol = m[3] === "udp" ? "udp" : "tcp";
			ports.push(
				m[1]
					? {
							target: Number(m[2]),
							published: Number(m[1]),
							protocol,
							mode: "host",
						}
					: { target: Number(m[2]), protocol },
			);
		}

		const volumes: { name: string; target: string; readOnly?: boolean }[] = [];
		const files: { target: string; content: string }[] = [];
		for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
			let source: string | undefined;
			let target: string;
			let readOnly = false;
			let content: string | undefined;
			if (isRecord(v)) {
				if (v.type === "tmpfs") {
					skip("tmpfs", `${path}.volumes tmpfs`);
					continue;
				}
				source = v.source === undefined ? undefined : literal(String(v.source));
				target = literal(String(v.target ?? ""));
				readOnly = v.read_only === true;
				if (typeof v.content === "string") content = v.content;
				else if (v.is_directory === false) content = "";
			} else {
				const parts = literal(String(v)).split(":");
				if (parts.length === 1) target = parts[0] as string;
				else {
					source = parts[0];
					target = parts[1] as string;
					readOnly = parts[2]?.split(",").includes("ro") ?? false;
				}
			}
			target = target.replace(/(.)\/+$/, "$1");
			if (!target.startsWith("/") || target.includes("${{")) {
				skip("volumes", `${path}.volumes target ${target}`);
				continue;
			}
			const shipped =
				source !== undefined ? (content ?? ctx.file?.(source)) : undefined;
			if (shipped !== undefined) {
				files.push({ target, content: shipped });
				continue;
			}
			if (source?.startsWith("/") || source?.startsWith("~")) {
				skip("bind", `${path}.volumes host path ${source}`);
				continue;
			}
			// A named volume keeps its name; a relative bind becomes a volume named after its path.
			const vname = slug(source ?? target) || "data";
			const users = volumeUsers.get(vname) ?? [];
			if (!users.includes(name)) users.push(name);
			volumeUsers.set(vname, users);
			if (volumes.some((x) => x.target === target)) continue;
			let unique = vname;
			for (let n = 2; volumes.some((x) => x.name === unique); n++)
				unique = `${vname}-${n}`;
			volumes.push({
				name: unique,
				target,
				...(readOnly && { readOnly: true }),
			});
		}

		const dependsOn = (
			Array.isArray(svc.depends_on)
				? svc.depends_on.map(String)
				: Object.keys(isRecord(svc.depends_on) ? svc.depends_on : {})
		)
			.map((d) => names.get(d))
			.filter((d): d is string => !!d);

		const caps = (list: unknown, key: string): Capability[] | undefined => {
			if (!Array.isArray(list)) return undefined;
			const out: Capability[] = [];
			for (const c of list.map((x) =>
				String(x).toUpperCase().replace(/^CAP_/, ""),
			))
				if ((linuxCapabilities as readonly string[]).includes(c))
					out.push(c as Capability);
				else skip(key, `${path}.${key} ${c}`);
			return out;
		};
		const restartKey =
			svc.restart === undefined ? undefined : String(svc.restart).split(":")[0];
		const restart = restartKey ? RESTART[restartKey] : undefined;
		const limits =
			isRecord(deploy.resources) && isRecord(deploy.resources.limits)
				? deploy.resources.limits
				: {};
		const memory = memoryMb(svc.mem_limit ?? limits.memory);
		const cpu = Number(svc.cpus ?? limits.cpus) || undefined;

		const db = image ? officialDatabase(image) : undefined;
		const dbInfo = db && DATABASES[db.engine];
		const asDatabase =
			db &&
			dbInfo &&
			!command &&
			!entrypoint &&
			!ports.some((p) => p.published) &&
			!env.PGDATA &&
			!files.length &&
			volumes.every((v) => v.target === dbInfo.dataDir) &&
			volumes.length === 1 &&
			dbInfo.required.every(([k]) => env[k as string]) &&
			!ctx.domains.has(original);
		const base = { name, dependsOn, env, volumes, files };
		if (asDatabase) {
			services.push({
				...base,
				kind: "database",
				engine: db.engine,
				version: db.version,
			});
			continue;
		}
		const domain = ctx.domains.get(original);
		const user =
			svc.user === undefined
				? undefined
				: String(svc.user).replace(/^root(?=$|:)/, "0");
		const capAdd = caps(svc.cap_add, "cap_add");
		const capDrop = caps(svc.cap_drop, "cap_drop");
		const healthcheck = mapHealthcheck(svc.healthcheck, env, literal);
		services.push({
			...base,
			kind: "application",
			image,
			ports,
			...(command && { command }),
			...(entrypoint && { entrypoint }),
			...(healthcheck && { healthcheck }),
			...(domain && { public: { port: domain.port, domain: domain.input } }),
			...(user !== undefined && { user }),
			...(capAdd?.length && { capAdd }),
			...(capDrop?.length && { capDrop }),
			...(restart && { restart }),
			...((memory || cpu) && {
				resources: { ...(memory && { memoryMb: memory }), ...(cpu && { cpu }) },
			}),
		});
		if (user !== undefined && !/^\d+(:\d+)?$/.test(user))
			skip("user", `${path}.user ${user} is not numeric`);
	}
	for (const [vol, users] of volumeUsers)
		if (users.length > 1)
			skip("shared_volume", `volume ${vol} is shared by ${users.join(", ")}`);
	if (reasons.length) throw new Skip(reasons);
	return services;
}
