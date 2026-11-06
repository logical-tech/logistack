import { z } from "zod";
import { DatabaseEngine } from "./enums.ts";
import { StorageEngine } from "./storage.ts";

const Port = z.int().min(1).max(65535);

export const Resources = z.object({
	/** CPU cores, fractional allowed (0.5 = half a core). */
	cpu: z.number().positive().optional(),
	memoryMb: z.int().positive().optional(),
});
export type Resources = z.infer<typeof Resources>;

const GitSource = z.object({
	type: z.literal("git"),
	gitProviderId: z.string().optional(),
	repository: z.string().min(1),
	branch: z.string().min(1),
	path: z.string().min(1),
});

/** Where a git stack reads its compose file; pushes to `branch` re-sync it. */
export const StackGitSource = z.object({
	gitProviderId: z.string().min(1),
	repository: z.string().min(1),
	branch: z.string().min(1),
	/** Relative to the repository root, like `docker-compose.yml` or `deploy/compose.yaml`. */
	composePath: z
		.string()
		.min(1)
		.max(500)
		.refine(
			(p) =>
				!p.startsWith("/") &&
				p.split("/").every((s) => s !== ".." && s !== "" && !s.includes("\0")),
			"must be a path inside the repository, like deploy/compose.yaml",
		),
});
export type StackGitSource = z.infer<typeof StackGitSource>;

export const ApplicationSource = z.discriminatedUnion("type", [
	GitSource,
	z.object({ type: z.literal("image"), image: z.string().min(1) }),
]);
export type ApplicationSource = z.infer<typeof ApplicationSource>;

export const BuildPlatform = z.enum(["linux/amd64", "linux/arm64"]);
export type BuildPlatform = z.infer<typeof BuildPlatform>;

/** Absent: the architectures of the swarm's nodes. */
const platforms = (max: number) =>
	z
		.array(BuildPlatform)
		.min(1)
		.max(max)
		.refine((p) => new Set(p).size === p.length, "duplicate platform")
		.optional();

export const BuildConfig = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("dockerfile"),
		dockerfilePath: z.string().min(1),
		context: z.string().min(1),
		target: z.string().optional(),
		buildArgs: z.record(z.string(), z.string()).optional(),
		platforms: platforms(2),
	}),
	/** The railpack frontend solves one platform per build, so it cannot produce a manifest list. */
	z.object({ type: z.literal("railpack"), platforms: platforms(1) }),
	z.object({ type: z.literal("static"), publishDir: z.string().min(1) }),
	z.object({ type: z.literal("image") }),
]);
export type BuildConfig = z.infer<typeof BuildConfig>;

export const Healthcheck = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("http"),
		port: Port,
		path: z.string().startsWith("/"),
	}),
	z.object({ type: z.literal("tcp"), port: Port }),
	/** argv, never a shell string. */
	z.object({ type: z.literal("command"), command: z.array(z.string()).min(1) }),
]);
export type Healthcheck = z.infer<typeof Healthcheck>;

export const PortMapping = z.object({
	target: Port,
	published: Port.optional(),
	protocol: z.enum(["tcp", "udp"]),
	/** `host` (default) binds on the task's node only; `ingress` uses the routing mesh on every node. */
	mode: z.enum(["host", "ingress"]).optional(),
});
export type PortMapping = z.infer<typeof PortMapping>;

/** Host paths a bind mount may only reach with `allowSensitiveHostPath`, granted by an admin. */
export const sensitiveHostPaths = [
	"/",
	"/etc",
	"/proc",
	"/sys",
	"/root",
	"/var/run/docker.sock",
	"/run/docker.sock",
] as const;

/** Overlap both ways: a denied directory's children, and any ancestor that would expose it. */
export function isSensitiveHostPath(path: string): boolean {
	if (path === "/") return true;
	return sensitiveHostPaths.some(
		(d) => d === path || path.startsWith(`${d}/`) || d.startsWith(`${path}/`),
	);
}

/** Canonical absolute path: no `.`/`..` segments, empty segments or trailing slash, so prefix checks hold. */
const AbsolutePath = z.string().refine(
	(p) =>
		p === "/" ||
		(p.startsWith("/") &&
			p
				.slice(1)
				.split("/")
				.every(
					(seg) =>
						seg !== "" && seg !== "." && seg !== ".." && !seg.includes("\0"),
				)),
	{
		message:
			"must be an absolute path without '..', '.', '//' or a trailing '/'",
	},
);

export const BindMount = z
	.object({
		kind: z.literal("bind"),
		hostPath: AbsolutePath,
		target: AbsolutePath,
		readOnly: z.boolean().optional(),
		/** Explicit admin confirmation for a host path in `sensitiveHostPaths`. */
		allowSensitiveHostPath: z.literal(true).optional(),
	})
	.refine((m) => m.allowSensitiveHostPath || !isSensitiveHostPath(m.hostPath), {
		message:
			"host path is sensitive; an admin must set allowSensitiveHostPath to mount it",
		path: ["hostPath"],
	});
export type BindMount = z.infer<typeof BindMount>;

/** Linux capability names as Docker takes them, without the `CAP_` prefix. */
export const linuxCapabilities = [
	"ALL",
	"AUDIT_CONTROL",
	"AUDIT_READ",
	"AUDIT_WRITE",
	"BLOCK_SUSPEND",
	"BPF",
	"CHECKPOINT_RESTORE",
	"CHOWN",
	"DAC_OVERRIDE",
	"DAC_READ_SEARCH",
	"FOWNER",
	"FSETID",
	"IPC_LOCK",
	"IPC_OWNER",
	"KILL",
	"LEASE",
	"LINUX_IMMUTABLE",
	"MAC_ADMIN",
	"MAC_OVERRIDE",
	"MKNOD",
	"NET_ADMIN",
	"NET_BIND_SERVICE",
	"NET_BROADCAST",
	"NET_RAW",
	"PERFMON",
	"SETFCAP",
	"SETGID",
	"SETPCAP",
	"SETUID",
	"SYS_ADMIN",
	"SYS_BOOT",
	"SYS_CHROOT",
	"SYS_MODULE",
	"SYS_NICE",
	"SYS_PACCT",
	"SYS_PTRACE",
	"SYS_RAWIO",
	"SYS_RESOURCE",
	"SYS_TIME",
	"SYS_TTY_CONFIG",
	"SYSLOG",
	"WAKE_ALARM",
] as const;
export const Capability = z.enum(linuxCapabilities);
export type Capability = z.infer<typeof Capability>;

export const RestartCondition = z.enum(["any", "on-failure", "none"]);
export type RestartCondition = z.infer<typeof RestartCondition>;

export const ApplicationSpec = z
	.object({
		kind: z.literal("application"),
		source: ApplicationSource,
		build: BuildConfig,
		ports: z.array(PortMapping),
		replicas: z.int().min(0),
		resources: Resources,
		healthcheck: Healthcheck.optional(),
		/** argv, never a shell string. */
		command: z.array(z.string()).optional(),
		/** Replaces the image's entrypoint; argv, never a shell string. */
		entrypoint: z.array(z.string()).optional(),
		/** Swarm placement constraints, e.g. `node.labels.region==eu`. */
		placement: z.array(z.string()),
		/** Host bind mounts; they pin the service to its node. Writing them needs `admin`. */
		mounts: z.array(BindMount).optional(),
		/** `uid[:gid]`, numeric so it never depends on the image's /etc/passwd. */
		user: z
			.string()
			.regex(/^\d+(:\d+)?$/, "must be uid or uid:gid")
			.optional(),
		capAdd: z.array(Capability).optional(),
		capDrop: z.array(Capability).optional(),
		/** Swarm restart condition; default `any`. */
		restart: RestartCondition.optional(),
	})
	.refine((s) => (s.source.type === "image") === (s.build.type === "image"), {
		message:
			"build.type 'image' is required for, and only allowed with, an image source",
		path: ["build", "type"],
	});
export type ApplicationSpec = z.infer<typeof ApplicationSpec>;

export const DatabaseSpec = z.object({
	kind: z.literal("database"),
	engine: DatabaseEngine,
	version: z.string().min(1),
	/** Reference to the encrypted credentials, never the credentials themselves. */
	credentialsRef: z.string().min(1),
	resources: Resources,
});
export type DatabaseSpec = z.infer<typeof DatabaseSpec>;

export const ComposeSpec = z.object({
	kind: z.literal("compose"),
	source: z.discriminatedUnion("type", [
		z.object({ type: z.literal("inline") }),
		GitSource,
	]),
	/** Stored verbatim; the deploy pipeline rewrites a copy. */
	originalYaml: z.string(),
	servicesOverrides: z.record(
		z.string(),
		z
			.object({
				replicas: z.int().min(0),
				resources: Resources,
				placement: z.array(z.string()),
			})
			.partial(),
	),
});
export type ComposeSpec = z.infer<typeof ComposeSpec>;

/** S3-compatible object storage; root credentials live in the service's secret env vars. */
export const StorageSpec = z.object({
	kind: z.literal("storage"),
	engine: StorageEngine,
	resources: Resources,
});
export type StorageSpec = z.infer<typeof StorageSpec>;

export const ServiceSpec = z.discriminatedUnion("kind", [
	ApplicationSpec,
	DatabaseSpec,
	ComposeSpec,
	StorageSpec,
]);
export type ServiceSpec = z.infer<typeof ServiceSpec>;
