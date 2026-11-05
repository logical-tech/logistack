/**
 * Pure mapping from one Dokploy compose project (docker-compose.yml + .env) to the
 * LogiStack application service that replaces it. No I/O; `scripts/import-dokploy.ts` does that.
 */
import { posix } from "node:path";
import {
	ApplicationSpec,
	type BindMount,
	type Capability,
	EnvKey,
	isSensitiveHostPath,
	linuxCapabilities,
	type PortMapping,
	type RestartCondition,
} from "@logistack/contracts";

/** Where Dokploy keeps compose projects on the host; relative bind sources resolve under it. */
export const DOKPLOY_COMPOSE_ROOT = "/etc/dokploy/compose";

/** Keys Dokploy writes into every `.env`; never user secrets. */
const DOKPLOY_INTERNAL = new Set([
	"APP_NAME",
	"COMPOSE_PROJECT_NAME",
	"DOCKER_CONFIG",
]);

// Dokploy attaches routed services to its overlay; `default` is the network compose creates implicitly.
const IGNORED_NETWORKS = new Set(["dokploy-network", "default"]);

export type EnvEntry = { key: string; value: string; isSecret: boolean };
export type DomainEntry = { hostname: string; port: number };
/** A named volume Dokploy's compose created, mounted in place by LogiStack (an adopted volume). */
export type VolumeEntry = {
	/** LogiStack's mount name, from the compose key. */
	name: string;
	target: string;
	/** The Docker volume as it exists on the host. */
	volume: string;
};

export type ImportPlan = {
	kind: "plan";
	appName: string;
	projectName: string;
	serviceName: string;
	/** Stored in `service.imported_from`; a re-run skips a service carrying it. */
	importedFrom: string;
	spec: ApplicationSpec;
	env: EnvEntry[];
	domains: DomainEntry[];
	volumes: VolumeEntry[];
	/** Names keys only, never values. */
	warnings: string[];
};

export type Refusal = {
	kind: "refused";
	appName: string;
	projectName: string;
	/** Compose paths LogiStack cannot represent, e.g. `services.app.build`. */
	unsupported: string[];
};

export type Mapped = ImportPlan | Refusal;

/** `factorio-server-o8zeig` → `factorio-server`: Dokploy appends a 6-character suffix. */
export const projectNameFromFolder = (appName: string) =>
	appName.replace(/-[a-z0-9]{6}$/, "");

/** KEY=value lines; `#` comments, an `export ` prefix and matching quotes are stripped. */
export function parseDotenv(text: string): Map<string, string> {
	const env = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim().replace(/^export\s+/, "");
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const value = line.slice(eq + 1).trim();
		const quoted = /^(["'])(.*)\1$/.exec(value);
		env.set(line.slice(0, eq).trim(), quoted ? (quoted[2] as string) : value);
	}
	return env;
}

const VARIABLE =
	/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Compose interpolation: `$$`, `$V`, `${V}`, `${V:-d}`, `${V-d}`, `${V:?e}`, `${V:+a}`. */
export function interpolate(input: string, env: Map<string, string>) {
	const used: string[] = [];
	const missing: string[] = [];
	const value = input.replace(
		VARIABLE,
		(match, braced?: string, op?: string, arg?: string, bare?: string) => {
			if (match === "$$") return "$";
			const name = (braced ?? bare) as string;
			const set = env.has(name);
			const val = env.get(name) ?? "";
			const present = op?.startsWith(":") ? val !== "" : set;
			switch (op?.replace(":", "")) {
				case "-":
					if (present) used.push(name);
					return present ? val : (arg as string);
				case "+":
					return present ? (arg as string) : "";
				default:
					if (!present) missing.push(name);
					else used.push(name);
					return val;
			}
		},
	);
	return { value, used, missing };
}

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Compose accepts both `KEY=value` lists and `{ KEY: value }` maps for environment and labels. */
function entries(v: unknown): [string, string | undefined][] {
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

const PORT_SHORT = /^(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/;

function mapPorts(svc: Raw, path: string, unsupported: string[]) {
	const ports: PortMapping[] = [];
	for (const p of (svc.ports as unknown[] | undefined) ?? []) {
		if (isRecord(p)) {
			const extra = Object.keys(p).filter(
				(k) => !["target", "published", "protocol", "mode"].includes(k),
			);
			if (extra.length) {
				unsupported.push(...extra.map((k) => `${path}.ports.${k}`));
				continue;
			}
			ports.push({
				target: Number(p.target),
				...(p.published !== undefined && { published: Number(p.published) }),
				protocol: p.protocol === "udp" ? "udp" : "tcp",
				mode: p.mode === "ingress" ? "ingress" : "host",
			});
			continue;
		}
		const m = PORT_SHORT.exec(String(p));
		if (!m) {
			unsupported.push(`${path}.ports "${p}" (host IPs and ranges)`);
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
	for (const e of (svc.expose as unknown[] | undefined) ?? []) {
		const m = PORT_SHORT.exec(String(e));
		if (!m || m[1]) {
			unsupported.push(`${path}.expose "${e}"`);
			continue;
		}
		const target = Number(m[2]);
		const protocol = m[3] === "udp" ? "udp" : "tcp";
		if (!ports.some((p) => p.target === target && p.protocol === protocol))
			ports.push({ target, protocol });
	}
	return ports;
}

/**
 * Docker volume names of the compose file's top-level `volumes`. Dokploy runs compose with
 * `-p <appName>`, so a plain volume is `<appName>_<key>`; `name:` or `external: true` keep their own.
 */
function volumeNames(
	declared: unknown,
	appName: string,
	unsupported: string[],
): Map<string, string> {
	const names = new Map<string, string>();
	for (const [key, raw] of Object.entries(isRecord(declared) ? declared : {})) {
		const v = isRecord(raw) ? raw : {};
		const extra = Object.keys(v).filter(
			(k) => !["name", "external"].includes(k),
		);
		if (extra.length) {
			unsupported.push(`volumes.${key}.${extra.join(", ")}`);
			continue;
		}
		names.set(
			key,
			typeof v.name === "string"
				? v.name
				: v.external === true
					? key
					: `${appName}_${key}`,
		);
	}
	return names;
}

/** `Game Data_1` → `game-data-1`: what the API takes as a volume mount name. */
const mountName = (key: string) =>
	key
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "data";

function mapMounts(
	svc: Raw,
	path: string,
	appName: string,
	declaredVolumes: Map<string, string>,
	allowSensitive: boolean,
	unsupported: string[],
) {
	const mounts: BindMount[] = [];
	const volumes: VolumeEntry[] = [];
	const base = posix.join(DOKPLOY_COMPOSE_ROOT, appName, "code");
	for (const v of (svc.volumes as unknown[] | undefined) ?? []) {
		let source: string;
		let target: string;
		let readOnly = false;
		if (isRecord(v)) {
			const extra = Object.keys(v).filter(
				(k) => !["type", "source", "target", "read_only"].includes(k),
			);
			if (!["bind", "volume"].includes(String(v.type)) || extra.length) {
				unsupported.push(
					!["bind", "volume"].includes(String(v.type))
						? `${path}.volumes ${v.type} "${v.source ?? v.target}"`
						: `${path}.volumes ${extra.join(", ")}`,
				);
				continue;
			}
			source = String(v.source);
			target = String(v.target);
			readOnly = v.read_only === true;
		} else {
			const parts = String(v).split(":");
			const mode = parts[2];
			if (
				parts.length < 2 ||
				parts.length > 3 ||
				(mode && !/^r[ow]$/.test(mode))
			) {
				unsupported.push(`${path}.volumes "${v}"`);
				continue;
			}
			source = parts[0] as string;
			target = parts[1] as string;
			readOnly = mode === "ro";
		}
		if (!source.startsWith("/") && !source.startsWith(".")) {
			const volume = declaredVolumes.get(source);
			if (!volume)
				unsupported.push(`${path}.volumes undeclared volume "${source}"`);
			// The API mounts named volumes read-write only.
			else if (readOnly)
				unsupported.push(`${path}.volumes read-only named volume "${source}"`);
			else
				volumes.push({
					name: mountName(source),
					target: posix.normalize(target).replace(/(.)\/$/, "$1"),
					volume,
				});
			continue;
		}
		const hostPath = posix.resolve(base, source);
		const sensitive = isSensitiveHostPath(hostPath);
		if (sensitive && !allowSensitive) {
			unsupported.push(
				`${path}.volumes sensitive host path "${hostPath}" (pass --allow-sensitive)`,
			);
			continue;
		}
		mounts.push({
			kind: "bind",
			hostPath,
			target: posix.normalize(target).replace(/(.)\/$/, "$1"),
			...(readOnly && { readOnly: true }),
			...(sensitive && { allowSensitiveHostPath: true as const }),
		});
	}
	return { mounts, volumes };
}

function mapCapabilities(
	list: unknown,
	path: string,
	unsupported: string[],
): Capability[] | undefined {
	if (!Array.isArray(list)) return undefined;
	const caps: Capability[] = [];
	for (const raw of list) {
		const name = String(raw).toUpperCase().replace(/^CAP_/, "");
		if ((linuxCapabilities as readonly string[]).includes(name))
			caps.push(name as Capability);
		else unsupported.push(`${path} "${raw}"`);
	}
	return caps;
}

const RESTART: Record<string, RestartCondition> = {
	always: "any",
	"unless-stopped": "any",
	"on-failure": "on-failure",
	no: "none",
};

const TRAEFIK_RULE = /^traefik\.http\.routers\.([^.]+)\.rule$/;
const TRAEFIK_ROUTER_SERVICE = /^traefik\.http\.routers\.([^.]+)\.service$/;
const TRAEFIK_PORT =
	/^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.port$/;
const HOST = /^Host\(`([^`]+)`\)$/;

/** Traefik `Host()` routers with their load-balancer port; every other `traefik.*` label is Dokploy plumbing. */
function mapDomains(
	labels: [string, string | undefined][],
	ports: PortMapping[],
	path: string,
	unsupported: string[],
) {
	const rules = new Map<string, string>();
	const routerService = new Map<string, string>();
	const servicePort = new Map<string, number>();
	for (const [key, value = ""] of labels) {
		if (!key.startsWith("traefik.")) {
			unsupported.push(`${path}.labels.${key}`);
			continue;
		}
		const rule = TRAEFIK_RULE.exec(key);
		if (rule) rules.set(rule[1] as string, value);
		const svc = TRAEFIK_ROUTER_SERVICE.exec(key);
		if (svc) routerService.set(svc[1] as string, value);
		const port = TRAEFIK_PORT.exec(key);
		if (port) servicePort.set(port[1] as string, Number(value));
	}
	const domains: DomainEntry[] = [];
	for (const [router, rule] of rules) {
		const port =
			servicePort.get(routerService.get(router) ?? router) ??
			(servicePort.size === 1 ? [...servicePort.values()][0] : undefined) ??
			(ports.length === 1 ? ports[0]?.target : undefined);
		if (port === undefined) {
			unsupported.push(`${path}.labels router "${router}" without a port`);
			continue;
		}
		for (const clause of rule.split("||").map((s) => s.trim())) {
			const host = HOST.exec(clause);
			if (!host) {
				unsupported.push(`${path}.labels rule "${clause}" (only Host() maps)`);
				continue;
			}
			const hostname = (host[1] as string).toLowerCase();
			if (!domains.some((d) => d.hostname === hostname && d.port === port))
				domains.push({ hostname, port });
		}
	}
	return domains;
}

const TOP_LEVEL = new Set([
	"services",
	"networks",
	"volumes",
	"version",
	"name",
]);
const SERVICE_KEYS = new Set([
	"image",
	"ports",
	"expose",
	"volumes",
	"user",
	"cap_add",
	"cap_drop",
	"restart",
	"environment",
	"labels",
	"networks",
]);

/** Deep-maps every string through compose interpolation. */
function interpolateAll(v: unknown, sub: (s: string) => string): unknown {
	if (typeof v === "string") return sub(v);
	if (Array.isArray(v)) return v.map((x) => interpolateAll(x, sub));
	if (isRecord(v))
		return Object.fromEntries(
			Object.entries(v).map(([k, x]) => [k, interpolateAll(x, sub)]),
		);
	return v;
}

export function mapCompose(input: {
	appName: string;
	projectName?: string;
	/** Parsed docker-compose.yml. */
	compose: unknown;
	dotenv: Map<string, string>;
	allowSensitive?: boolean;
}): Mapped {
	const { appName, dotenv } = input;
	const projectName = input.projectName ?? projectNameFromFolder(appName);
	const unsupported: string[] = [];
	const warnings: string[] = [];
	const refuse = (): Refusal => ({
		kind: "refused",
		appName,
		projectName,
		unsupported,
	});
	const compose = isRecord(input.compose) ? input.compose : {};

	for (const key of Object.keys(compose))
		if (!TOP_LEVEL.has(key)) unsupported.push(key);
	const declaredVolumes = volumeNames(compose.volumes, appName, unsupported);
	for (const net of Object.keys(
		isRecord(compose.networks) ? compose.networks : {},
	))
		if (!IGNORED_NETWORKS.has(net)) unsupported.push(`networks.${net}`);
	const services = isRecord(compose.services) ? compose.services : {};
	const names = Object.keys(services);
	if (names.length !== 1) {
		unsupported.push(
			names.length ? `multiple services (${names.join(", ")})` : "no services",
		);
		return refuse();
	}
	const serviceName = names[0] as string;
	const path = `services.${serviceName}`;
	const raw = services[serviceName];
	if (!isRecord(raw)) {
		unsupported.push(path);
		return refuse();
	}
	for (const key of Object.keys(raw))
		if (!SERVICE_KEYS.has(key)) unsupported.push(`${path}.${key}`);

	const missing = new Set<string>();
	const sub = (s: string) => {
		const r = interpolate(s, dotenv);
		for (const m of r.missing) missing.add(m);
		return r;
	};
	const { environment, ...rest } = raw;
	const svc = interpolateAll(rest, (s) => sub(s).value) as Raw;

	for (const net of entries(svc.networks).map(([k]) => k))
		if (!IGNORED_NETWORKS.has(net)) unsupported.push(`${path}.networks.${net}`);

	const env: EnvEntry[] = [];
	for (const [key, value] of entries(environment)) {
		if (!EnvKey.safeParse(key).success) {
			unsupported.push(`${path}.environment.${key}`);
			continue;
		}
		if (value === undefined) {
			const passed = dotenv.get(key);
			if (passed === undefined) warnings.push(`${key} is not in .env, skipped`);
			else
				env.push({ key, value: passed, isSecret: !DOKPLOY_INTERNAL.has(key) });
			continue;
		}
		const r = sub(value);
		env.push({
			key,
			value: r.value,
			isSecret: r.used.some((u) => !DOKPLOY_INTERNAL.has(u)),
		});
	}
	for (const m of missing)
		warnings.push(`\${${m}} is not set in .env, substituted with ""`);

	const ports = mapPorts(svc, path, unsupported);
	const { mounts, volumes } = mapMounts(
		svc,
		path,
		appName,
		declaredVolumes,
		input.allowSensitive ?? false,
		unsupported,
	);
	const capAdd = mapCapabilities(svc.cap_add, `${path}.cap_add`, unsupported);
	const capDrop = mapCapabilities(
		svc.cap_drop,
		`${path}.cap_drop`,
		unsupported,
	);
	const restartKey =
		svc.restart === undefined ? undefined : String(svc.restart);
	const restart = restartKey && RESTART[restartKey.split(":")[0] as string];
	if (restartKey && !restart)
		unsupported.push(`${path}.restart "${restartKey}"`);
	const domains = mapDomains(entries(svc.labels), ports, path, unsupported);
	if (typeof svc.image !== "string") unsupported.push(`${path} without image`);

	const parsed = ApplicationSpec.safeParse({
		kind: "application",
		source: { type: "image", image: svc.image },
		build: { type: "image" },
		ports,
		replicas: 1,
		resources: {},
		placement: [],
		...(mounts.length && { mounts }),
		...(svc.user !== undefined && { user: String(svc.user) }),
		...(capAdd?.length && { capAdd }),
		...(capDrop?.length && { capDrop }),
		...(restart && { restart }),
	});
	if (!parsed.success)
		unsupported.push(
			...parsed.error.issues.map(
				(i) => `${path} ${i.path.join(".")}: ${i.message}`,
			),
		);
	if (unsupported.length || !parsed.success) return refuse();
	return {
		kind: "plan",
		appName,
		projectName,
		serviceName,
		importedFrom: `dokploy:${appName}/${serviceName}`,
		spec: parsed.data,
		env,
		domains,
		volumes,
		warnings,
	};
}
