import type {
	ApplicationSpec,
	Capability,
	DatabaseEngine,
	DatabaseSpec,
	DesiredState,
	Healthcheck as HealthcheckSpec,
	MountKind,
	StorageSpec,
} from "@logistack/contracts";
import {
	type ConfigReference,
	type Healthcheck,
	type Labels,
	type ManagedKind,
	type Mount,
	managedLabels,
	type SecretReference,
	type ServiceSpec,
} from "@logistack/docker";
import { dockerName } from "./ids.ts";
import { LIBSQL_ENV, LIBSQL_HEALTH } from "./libsql.ts";
import { storageEngineDefs } from "./storage.ts";

export type CompileMount = {
	id: string;
	kind: MountKind;
	target: string;
	readOnly: boolean;
	/** Decrypted file content; required for config and secret mounts. */
	content?: string;
};

export type CompileServiceInput = {
	service: {
		id: string;
		organizationId: string;
		environmentId: string;
		/** DNS alias on the environment network; validated by the API. */
		slug: string;
		desiredState: DesiredState;
		spec: ApplicationSpec | DatabaseSpec | StorageSpec;
	};
	/** Rolls the tasks even when nothing else changed, so every deployment is a real update. */
	deploymentId: string;
	/** Application image ref; databases use the engine's official image. */
	image?: string;
	/** Resolved and decrypted runtime env. */
	env: Record<string, string>;
	mounts: CompileMount[];
	domains: { port: number }[];
	/** `storage`: the shared network the api and worker reach storage services on; required for storage. */
	networks: { environment: string; ingress: string; storage?: string };
	/** Swarm node id stateful services are pinned to. */
	pinNodeId?: string;
	/** Swarm ids of the configs and secrets named by `serviceFiles`, keyed by name. */
	fileIds: Record<string, string>;
	/** Test isolation: a prefix for every derived name and extra labels on every object. */
	scope?: { namePrefix: string; labels: Labels };
};

export type ServiceFile = {
	mountId: string;
	target: string;
	kind: "config" | "secret";
	/** Carries a content hash, so a content change creates a new object and rolls the service. */
	name: string;
	data: string;
	labels: Labels;
};

const s = (n: number) => n * 1e9;
const ROLLOUT_MONITOR = s(30);

type Engine = {
	image: (version: string) => string;
	dataDir: string;
	/** Env keys the official image needs to initialise with credentials. */
	required: string[];
	healthcheck: string[];
	args?: string[];
};

const engines: Record<DatabaseEngine, Engine> = {
	postgres: {
		image: (v) => `postgres:${v}`,
		dataDir: "/var/lib/postgresql/data",
		required: ["POSTGRES_PASSWORD"],
		healthcheck: [
			"CMD-SHELL",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the container shell
			'pg_isready -U "${POSTGRES_USER:-postgres}" -h 127.0.0.1',
		],
	},
	mysql: {
		image: (v) => `mysql:${v}`,
		dataDir: "/var/lib/mysql",
		required: ["MYSQL_ROOT_PASSWORD"],
		healthcheck: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "--silent"],
	},
	mariadb: {
		image: (v) => `mariadb:${v}`,
		dataDir: "/var/lib/mysql",
		required: ["MARIADB_ROOT_PASSWORD"],
		healthcheck: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
	},
	mongo: {
		image: (v) => `mongo:${v}`,
		dataDir: "/data/db",
		required: ["MONGO_INITDB_ROOT_USERNAME", "MONGO_INITDB_ROOT_PASSWORD"],
		healthcheck: [
			"CMD",
			"mongosh",
			"--quiet",
			"--eval",
			"db.adminCommand('ping').ok",
		],
	},
	redis: {
		image: (v) => `redis:${v}`,
		dataDir: "/data",
		required: ["REDIS_PASSWORD"],
		healthcheck: [
			"CMD-SHELL",
			'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping | grep -q PONG',
		],
		// The official image has no password env; a config file keeps it out of the process argv.
		args: [
			"sh",
			"-c",
			"umask 077 && printf 'requirepass %s\\n' \"$REDIS_PASSWORD\" > /tmp/redis.conf && chown redis:redis /tmp/redis.conf && exec docker-entrypoint.sh redis-server /tmp/redis.conf --appendonly yes",
		],
	},
	libsql: {
		image: (v) => `ghcr.io/tursodatabase/libsql-server:v${v}`,
		dataDir: "/var/lib/sqld",
		required: [LIBSQL_ENV.jwtKey],
		healthcheck: ["CMD", "bash", "-c", LIBSQL_HEALTH],
	},
};

/** The image a database service runs: each engine's official one at the pinned version. */
export const databaseImage = (engine: DatabaseEngine, version: string) =>
	engines[engine].image(version);

const sha256 = (data: string) =>
	new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 12);

const prefixOf = (input: CompileServiceInput) => input.scope?.namePrefix ?? "";

function labelsFor(
	input: CompileServiceInput,
	resource: string,
	kind: ManagedKind,
): Labels {
	return {
		...managedLabels({ resource, kind, org: input.service.organizationId }),
		...input.scope?.labels,
	};
}

/** The Swarm configs and secrets a service mounts; create them before `compileService`. */
export function serviceFiles(input: CompileServiceInput): ServiceFile[] {
	const spec = input.service.spec;
	const engineFiles = (
		spec.kind === "storage" ? (storageEngineDefs[spec.engine].files ?? []) : []
	).map(
		(f, i): ServiceFile => ({
			mountId: `${input.service.id}#${i}`,
			target: f.target,
			kind: "config",
			name: `${prefixOf(input)}${dockerName("cfg", input.service.id)}-${sha256(f.content)}`,
			data: f.content,
			labels: labelsFor(input, input.service.id, "config"),
		}),
	);
	return input.mounts
		.flatMap((m): ServiceFile[] => {
			if (m.kind === "volume") return [];
			if (m.content === undefined)
				throw new Error(`mount ${m.id}: ${m.kind} mount without content`);
			const kind = m.kind;
			const base = dockerName(kind === "config" ? "cfg" : "sec", m.id);
			return [
				{
					mountId: m.id,
					target: m.target,
					kind,
					name: `${prefixOf(input)}${base}-${sha256(m.content)}`,
					data: m.content,
					labels: labelsFor(input, m.id, kind),
				},
			];
		})
		.concat(engineFiles);
}

function shellQuote(v: string): string {
	return `'${v.replaceAll("'", `'"'"'`)}'`;
}

/** Listening check without nc or curl: any image with a shell and grep has /proc/net/tcp. */
function tcpCheck(port: number): string[] {
	const hex = port.toString(16).toUpperCase().padStart(4, "0");
	// shortcut: needs sh + grep in the image (not distroless); such images must declare a command healthcheck.
	return [
		"CMD-SHELL",
		`grep -sqE ':${hex} [0-9A-F]{8,32}:0000 0A' /proc/net/tcp /proc/net/tcp6`,
	];
}

function healthcheckTest(
	check: HealthcheckSpec | undefined,
	fallbackPort: number | undefined,
): string[] | undefined {
	if (!check) return fallbackPort ? tcpCheck(fallbackPort) : undefined;
	switch (check.type) {
		case "tcp":
			return tcpCheck(check.port);
		case "http": {
			const url = shellQuote(`http://127.0.0.1:${check.port}${check.path}`);
			return [
				"CMD-SHELL",
				`wget -q -O /dev/null ${url} || curl -fsS -o /dev/null ${url}`,
			];
		}
		case "command":
			return ["CMD", ...check.command];
	}
}

const cap = (c: Capability) => (c === "ALL" ? c : `CAP_${c}`);

const healthTimings = (startPeriod: number): Omit<Healthcheck, "Test"> => ({
	Interval: s(5),
	Timeout: s(3),
	Retries: 3,
	StartPeriod: s(startPeriod),
	StartInterval: s(1),
});

/** Pure: compiles a service row plus resolved inputs into a Swarm service spec. */
export function compileService(input: CompileServiceInput): ServiceSpec {
	const { service } = input;
	const spec = service.spec;
	const prefix = prefixOf(input);
	const db = spec.kind === "database" ? spec : undefined;
	const app = spec.kind === "application" ? spec : undefined;
	const store =
		spec.kind === "storage" ? storageEngineDefs[spec.engine] : undefined;
	const isDb = db !== undefined;
	const kind: ManagedKind = isDb ? "db" : "service";
	// The slug is the service's DNS name on the environment network; siblings resolve it.
	if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(service.slug))
		throw new Error(
			`service ${service.id}: slug ${service.slug} is not a DNS label`,
		);

	const volumeMounts: Mount[] = input.mounts
		.filter((m) => m.kind === "volume")
		.map((m) => ({
			Type: "volume",
			Source: `${prefix}${dockerName("vol", m.id)}`,
			Target: m.target,
			ReadOnly: m.readOnly,
			VolumeOptions: { Labels: labelsFor(input, m.id, "volume") },
		}));
	const engine = db ? engines[db.engine] : undefined;
	if (db && engine) {
		const missing = engine.required.filter((k) => !input.env[k]);
		if (missing.length)
			throw new Error(
				`service ${service.id}: ${db.engine} needs env ${missing.join(", ")}`,
			);
		volumeMounts.push({
			Type: "volume",
			Source: `${prefix}${dockerName("vol", service.id)}`,
			Target: engine.dataDir,
			VolumeOptions: { Labels: labelsFor(input, service.id, "volume") },
		});
	}
	if (store) {
		const missing = store.required.filter((k) => !input.env[k]);
		if (missing.length)
			throw new Error(
				`service ${service.id}: ${store.label} needs env ${missing.join(", ")}`,
			);
		if (!input.networks.storage)
			throw new Error(
				`service ${service.id}: storage needs the storage network`,
			);
		volumeMounts.push({
			Type: "volume",
			Source: `${prefix}${dockerName("vol", service.id)}`,
			Target: store.dataDir,
			VolumeOptions: { Labels: labelsFor(input, service.id, "volume") },
		});
	}

	const bindMounts: Mount[] = (app?.mounts ?? []).map((m) => ({
		Type: "bind",
		Source: m.hostPath,
		Target: m.target,
		ReadOnly: m.readOnly ?? false,
	}));

	const configs: ConfigReference[] = [];
	const secrets: SecretReference[] = [];
	for (const f of serviceFiles(input)) {
		const id = input.fileIds[f.name];
		if (!id) throw new Error(`${f.kind} ${f.name} has no Swarm id`);
		const File = { Name: f.target, UID: "0", GID: "0", Mode: 0o444 };
		if (f.kind === "config")
			configs.push({ ConfigID: id, ConfigName: f.name, File });
		else secrets.push({ SecretID: id, SecretName: f.name, File });
	}

	const stateful = volumeMounts.length > 0 || bindMounts.length > 0;
	if (stateful && !input.pinNodeId)
		throw new Error(
			`service ${service.id} is stateful and needs a node to pin`,
		);

	const image =
		db && engine ? engine.image(db.version) : (store?.image ?? input.image);
	if (!image) throw new Error(`service ${service.id}: no image to deploy`);

	const hasIngress = !isDb && input.domains.length > 0;
	const test = engine
		? engine.healthcheck
		: store
			? store.healthcheck
			: healthcheckTest(
					app?.healthcheck,
					hasIngress
						? (app?.ports[0]?.target ?? input.domains[0]?.port)
						: undefined,
				);

	const deploymentLabel = { "logistack.deployment": input.deploymentId };
	const published = (app?.ports ?? []).filter((p) => p.published);
	// A host port is held by the old task until it stops, so a start-first update would never schedule.
	const holdsHostPort = published.some((p) => (p.mode ?? "host") === "host");
	const order = stateful || holdsHostPort ? "stop-first" : "start-first";
	const resources = spec.resources;
	const replicas =
		service.desiredState === "stopped" ? 0 : isDb ? 1 : (app?.replicas ?? 1);
	const env = Object.entries({ ...input.env, ...store?.env(input.env) })
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`);

	return {
		Name: `${prefix}${dockerName("svc", service.id)}`,
		Labels: {
			...labelsFor(input, service.id, kind),
			"logistack.environment": service.environmentId,
			...deploymentLabel,
		},
		TaskTemplate: {
			ContainerSpec: {
				Image: image,
				Labels: { ...labelsFor(input, service.id, kind), ...deploymentLabel },
				...(engine?.args
					? { Command: engine.args }
					: (app?.command ?? store?.args)
						? { Args: app?.command ?? store?.args }
						: {}),
				...(app?.entrypoint ? { Command: app.entrypoint } : {}),
				Env: env,
				...(app?.user ? { User: app.user } : {}),
				...(app?.capAdd?.length ? { CapabilityAdd: app.capAdd.map(cap) } : {}),
				...(app?.capDrop?.length
					? { CapabilityDrop: app.capDrop.map(cap) }
					: {}),
				Mounts: [...volumeMounts, ...bindMounts],
				Configs: configs,
				Secrets: secrets,
				StopGracePeriod: s(10),
				...(test
					? {
							Healthcheck: {
								Test: test,
								...healthTimings(isDb || store ? 30 : 15),
							},
						}
					: {}),
			},
			Resources: {
				Limits: {
					...(resources.cpu
						? { NanoCPUs: Math.round(resources.cpu * 1e9) }
						: {}),
					...(resources.memoryMb
						? { MemoryBytes: resources.memoryMb * 1024 * 1024 }
						: {}),
				},
			},
			RestartPolicy: {
				Condition: app?.restart ?? "any",
				Delay: s(5),
				MaxAttempts: 0,
			},
			Placement: {
				Constraints: [
					...(app?.placement ?? []),
					...(stateful ? [`node.id==${input.pinNodeId}`] : []),
				],
			},
			Networks: [
				{ Target: input.networks.environment, Aliases: [service.slug] },
				...(hasIngress ? [{ Target: input.networks.ingress }] : []),
				...(store && input.networks.storage
					? [{ Target: input.networks.storage }]
					: []),
			],
		},
		Mode: { Replicated: { Replicas: replicas } },
		UpdateConfig: {
			Parallelism: 1,
			Order: order,
			FailureAction: "rollback",
			Monitor: ROLLOUT_MONITOR,
			MaxFailureRatio: 0,
		},
		RollbackConfig: {
			Parallelism: 1,
			Order: order,
			FailureAction: "pause",
			Monitor: ROLLOUT_MONITOR,
		},
		EndpointSpec: {
			Mode: "vip",
			Ports: published.map((p) => ({
				Protocol: p.protocol,
				TargetPort: p.target,
				PublishedPort: p.published,
				PublishMode: p.mode ?? "host",
			})),
		},
	};
}
