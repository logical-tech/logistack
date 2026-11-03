import { readFileSync } from "node:fs";
import { RELEASE_REGISTRY } from "@logistack/contracts";
import { z } from "zod";

const json = <T extends z.ZodType>(schema: T) =>
	z
		.string()
		.transform((s, ctx) => {
			try {
				return JSON.parse(s) as unknown;
			} catch {
				ctx.addIssue({ code: "custom", message: "must be JSON" });
				return z.NEVER;
			}
		})
		.pipe(schema);

const ms = (fallback: number) =>
	z.coerce.number().int().min(0).default(fallback);

const ConfigSchema = z.object({
	DATABASE_URL: z.url(),
	REDIS_URL: z.url(),
	LOGISTACK_MASTER_KEY: z.string().min(1),
	DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
	/** Clones and per-deployment log files live here. */
	LS_WORK_DIR: z.string().default("/var/lib/logistack"),
	LS_CONTROL_NETWORK: z.string().default("ls-control"),
	LS_INGRESS_NETWORK: z.string().default("ls-ingress"),
	/** Shared by storage services, the api and the worker only; apps never join it. */
	LS_STORAGE_NETWORK: z.string().default("ls-storage"),
	LS_DB_NETWORK: z.string().default("ls-db"),
	/** Swarm service name of the Caddy ingress (stack `logistack`, service `caddy`). */
	LS_CADDY_SERVICE: z.string().default("logistack_caddy"),
	LS_API_UPSTREAM: z.string().default("logistack-api:3000"),
	LS_BUILDKIT_IMAGE: z.string().default("moby/buildkit:v0.34.1-rootless"),
	/** argv prefix that runs buildctl; tests point it at a client container. */
	LS_BUILDCTL: json(z.array(z.string()).min(1)).default(["buildctl"]),
	LS_RAILPACK: json(z.array(z.string()).min(1)).default(["railpack"]),
	/** Must match the railpack CLI pinned in the Dockerfile (RAILPACK_VERSION). */
	LS_RAILPACK_FRONTEND: z
		.string()
		.default("ghcr.io/railwayapp/railpack-frontend:v0.43.0"),
	LS_ZOT_IMAGE: z.string().default("ghcr.io/project-zot/zot:v2.1.23"),
	/** Publishes the local registry on this host port for loopback pushes (single node without DNS, tests). */
	LS_LOCAL_REGISTRY_PORT: z.coerce.number().int().min(0).max(65535).default(0),
	/** Allows `file://` git sources; only for tests, a clone of the worker's own disk is a leak. */
	LS_ALLOW_LOCAL_GIT: z.stringbool().default(false),
	/** Test isolation: prefix for every Docker name and labels added to every object. */
	LS_NAME_PREFIX: z.string().default(""),
	LS_SCOPE_LABELS: json(z.record(z.string(), z.string())).default({}),
	LS_DEPLOY_TIMEOUT_MS: ms(10 * 60_000),
	LS_RECONCILE_INTERVAL_MS: ms(30_000),
	LS_ORPHAN_GRACE_MS: ms(10 * 60_000),
	LS_PROXY_COALESCE_MS: ms(1_000),
	/** Rollups, retention and threshold checks; 0 disables the timer. */
	LS_METRICS_INTERVAL_MS: ms(60_000),
	/** Node sync and Add-server steps; the server also pokes them over `ls:node-ops`. */
	LS_NODE_SYNC_INTERVAL_MS: ms(15_000),
	LS_CONCURRENCY: z.coerce.number().int().min(1).default(4),
	/** Needs sh, tar and zstd (installed with apk on first use when missing). Volume backups and restores. */
	LS_BACKUP_TOOLS_IMAGE: z.string().default("alpine:3.22"),
	/** Host-target schedules chroot into the node's / from this image. */
	LS_HOST_JOB_IMAGE: z.string().default("busybox:1.37"),
	/** Schedule run output kept per run; the rest is counted, not stored. */
	LS_SCHEDULE_OUTPUT_LIMIT: z.coerce
		.number()
		.int()
		.min(1024)
		.default(1024 * 1024),
	LS_RUN_CONCURRENCY: z.coerce.number().int().min(1).default(8),
	/** Baked into the image at build time (Dockerfile ARG). */
	LOGISTACK_VERSION: z.string().default("dev"),
	/** Swarm stack the control plane runs in; in-app updates replace its services' images. */
	LS_STACK_NAME: z.string().default("logistack"),
	/** Where in-app updates take images from. `localhost` uses images already on this engine (tests). */
	LS_UPDATE_REGISTRY: z.string().default(RELEASE_REGISTRY),
	LS_UPDATE_TIMEOUT_MS: ms(10 * 60_000),
	LOG_LEVEL: z.enum(["info", "silent"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Every key also accepts `<KEY>_FILE` (Docker secrets); the file wins over the plain variable. */
export function loadConfig(
	env: Record<string, string | undefined> = process.env,
): Config {
	const raw: Record<string, string | undefined> = {};
	for (const key of Object.keys(ConfigSchema.shape)) {
		const file = env[`${key}_FILE`];
		raw[key] = file ? readFileSync(file, "utf8").trim() : env[key];
	}
	const parsed = ConfigSchema.safeParse(raw);
	if (!parsed.success)
		throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
	return parsed.data;
}
