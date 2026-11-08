import { z } from "zod";
import { DrainNodeStatus, DrainsConfig, LogDrainConfig } from "./drains.ts";
import { NodeRole } from "./enums.ts";
import { TrafficConfig, TrafficMinute } from "./traffic.ts";

// Agent <-> server protocol. The agent dials AGENT_WS_PATH with `Authorization: Bearer <token>`
// and AGENT_NODE_HEADER, then sends `hello` first. Until the server answers `hello.ok` with a
// per-node `lsn_` token, the token is the installer's enrollment token; the agent keeps the node
// token and presents it from then on. Every frame is one JSON text message parsed with AgentMessage or
// ServerMessage. Requests carry an `id` chosen by the server; every reply for that request
// carries the same `id` and the stream ends with exactly one terminal message
// (`exec.exit`, `job.result`, `disk.result`, `archive.result`, `drains.result`, `rpc.error`, or
// `logs.end`). Capabilities gate newer requests: `log-drains` covers `drains.config` and
// `drains.test`.
//
// Backpressure:
// - Output is chunked to at most MAX_CHUNK_BYTES raw bytes (base64 in `data`) and log lines are
//   cut at MAX_LINE_BYTES, so no frame exceeds MAX_FRAME_BYTES.
// - Telemetry (heartbeat, metrics, docker_event) is dropped while the sender's socket buffer is
//   above HIGH_WATER_BYTES; the next tick carries fresh values anyway.
// - Stream output waits for the buffer to drain below HIGH_WATER_BYTES before sending more,
//   which pauses the Docker log stream. A stream stalled longer than STALL_TIMEOUT_MS is closed
//   with `rpc.error` code `backpressure`.
// - The server queues at most MAX_QUEUED_MESSAGES per request for its consumer; on overflow it
//   cancels the request and the consumer's iterator throws.
// - A job with `ackWindowBytes` sends at most that many output bytes past the last `job.ack`
//   (cumulative bytes its consumer has read), so a slow consumer pauses the job instead of
//   piling output up in memory. No ack for ACK_STALL_MS fails it with code `backpressure`.
// - An exec started with `stdinAck` answers `exec.stdin.ack` with the cumulative stdin bytes the
//   process has taken, so a caller streaming into a slow process holds a bounded window.

export const AGENT_WS_PATH = "/api/agent/ws";
/** Swarm node id on the upgrade request, so refusals happen before the socket opens. */
export const AGENT_NODE_HEADER = "x-logistack-node-id";
export const AGENT_PROTOCOL_VERSION = 1;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const MAX_LINE_BYTES = 16 * 1024;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const STALL_TIMEOUT_MS = 30_000;
export const MAX_QUEUED_MESSAGES = 1024;
/** Long enough for a slow link to upload one multipart part between acks. */
export const ACK_STALL_MS = 10 * 60_000;

const RequestId = z.string().min(1).max(64);
const Base64 = z.string().max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4);
const Bytes = z.number().int().nonnegative();
const OutputStream = z.enum(["stdout", "stderr"]);

/** A container on the agent's own node, found through Swarm task labels. */
export const ContainerTarget = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("task"), taskId: z.string().min(1) }),
	/** The oldest running task container of the service on this node. */
	z.object({ kind: z.literal("service"), serviceId: z.string().min(1) }),
]);
export type ContainerTarget = z.infer<typeof ContainerTarget>;

export const HostMetrics = z.object({
	/** 0..100 across all cores. */
	cpuPercent: z.number().nonnegative(),
	load: z.tuple([z.number(), z.number(), z.number()]),
	memory: z.object({
		totalBytes: Bytes,
		availableBytes: Bytes,
		usedBytes: Bytes,
	}),
	swap: z.object({ totalBytes: Bytes, usedBytes: Bytes }),
	disks: z.array(
		z.object({
			mount: z.string(),
			device: z.string(),
			fsType: z.string(),
			totalBytes: Bytes,
			usedBytes: Bytes,
			availableBytes: Bytes,
		}),
	),
	/** Cumulative counters summed over physical interfaces. */
	network: z.object({ rxBytes: Bytes, txBytes: Bytes }),
	uptimeSec: z.number().nonnegative(),
	/** 0..100 of all CPU time; older agents omit these and the fields below. */
	cpuIowaitPercent: z.number().nonnegative().optional(),
	cpuStealPercent: z.number().nonnegative().optional(),
	/** Cumulative bytes over whole physical disks. */
	diskIo: z.object({ readBytes: Bytes, writeBytes: Bytes }).optional(),
	/** hwmon sensors; empty on hosts that expose none (most VMs). */
	temperatures: z
		.array(z.object({ sensor: z.string().max(64), celsius: z.number() }))
		.max(64)
		.optional(),
});
export type HostMetrics = z.infer<typeof HostMetrics>;

export const ContainerMetrics = z.object({
	containerId: z.string(),
	name: z.string(),
	taskId: z.string().optional(),
	serviceId: z.string().optional(),
	serviceName: z.string().optional(),
	resourceId: z.string().optional(),
	/** Docker convention: 100 per fully used core, so up to cores * 100. */
	cpuPercent: z.number().nonnegative(),
	memoryBytes: Bytes,
	memoryLimitBytes: Bytes,
	/** Cumulative counters. */
	network: z.object({ rxBytes: Bytes, txBytes: Bytes }),
	blockIo: z.object({ readBytes: Bytes, writeBytes: Bytes }),
});
export type ContainerMetrics = z.infer<typeof ContainerMetrics>;

/** Docker's own event shape, forwarded as received. */
export const DockerEventPayload = z.object({
	Type: z.string(),
	Action: z.string(),
	Actor: z.object({
		ID: z.string(),
		Attributes: z.record(z.string(), z.string()),
	}),
	scope: z.string(),
	time: z.number(),
	timeNano: z.number(),
});

const Mount = z.object({
	type: z.enum(["volume", "bind"]),
	source: z.string().min(1),
	target: z.string().startsWith("/"),
	readOnly: z.boolean().default(false),
});

const JobCommon = {
	/** Fed to the process stdin, then stdin is closed. */
	script: z.string().optional(),
	env: z.array(z.string()).default([]),
	timeoutSec: z.number().int().positive().max(86_400),
	/** Output beyond this is counted in `bytes` but not sent. */
	outputLimitBytes: Bytes.default(1024 * 1024),
	/** Flow control: output bytes the agent may send past the last `job.ack`. */
	ackWindowBytes: z.number().int().positive().optional(),
};

export const JobSpec = z.discriminatedUnion("kind", [
	/** Runs inside an existing task container, e.g. `pg_dump` for a database backup. */
	z.object({
		kind: z.literal("exec"),
		target: ContainerTarget,
		cmd: z.array(z.string()).min(1),
		user: z.string().optional(),
		workingDir: z.string().optional(),
		...JobCommon,
	}),
	/** Runs in a fresh container that is removed afterwards. */
	z.object({
		kind: z.literal("container"),
		image: z.string().min(1),
		/** Derived from ids by the server (`ls-job-<id>`). */
		containerName: z.string().regex(/^ls-[a-z0-9-]+$/),
		cmd: z.array(z.string()).min(1).default(["sh"]),
		/** Merged with `logistack.managed=true`. */
		labels: z.record(z.string(), z.string()).default({}),
		mounts: z.array(Mount).default([]),
		network: z.string().optional(),
		...JobCommon,
	}),
]);
export type JobSpec = z.infer<typeof JobSpec>;
export type JobSpecInput = z.input<typeof JobSpec>;

const DiskCategory = z.object({
	count: z.number().int().nonnegative(),
	bytes: Bytes,
	/** What a prune could free; 0 where no prune applies (volumes are never pruned, logs need rotation). */
	reclaimableBytes: Bytes,
});

/** Where a node's disk goes, from the engine's `/system/df` plus the container log files. */
const VolumeSize = z.object({
	name: z.string(),
	bytes: Bytes,
	inUse: z.boolean(),
	/** `logistack.resource` when LogiStack created it. */
	resourceId: z.string().optional(),
});

export const DiskUsage = z.object({
	at: z.number(),
	dockerRootDir: z.string(),
	/** The filesystem holding the Docker root dir; null when the agent cannot statfs it. */
	filesystem: z.object({ totalBytes: Bytes, usedBytes: Bytes }).nullable(),
	images: DiskCategory,
	containers: DiskCategory,
	volumes: DiskCategory,
	buildCache: DiskCategory,
	/** json-file logs under the root dir; null when the agent cannot read them. */
	logs: DiskCategory.nullable(),
	/** Largest volumes first. */
	topVolumes: z.array(VolumeSize).max(20),
	/** Every volume, for usage attribution; older agents omit it. */
	allVolumes: z.array(VolumeSize).optional(),
});
export type DiskUsage = z.infer<typeof DiskUsage>;

/** Volumes are left out on purpose: an unused volume can still be someone's only copy of data. */
export const pruneTargets = ["containers", "images", "buildCache"] as const;
export const PruneTarget = z.enum(pruneTargets);
export type PruneTarget = z.infer<typeof PruneTarget>;

export const PruneReport = z.array(
	z.object({
		target: PruneTarget,
		deleted: z.number().int().nonnegative(),
		reclaimedBytes: Bytes,
	}),
);
export type PruneReport = z.infer<typeof PruneReport>;

export const DiskRequest = z.discriminatedUnion("op", [
	z.object({ op: z.literal("usage") }),
	z.object({
		op: z.literal("prune"),
		targets: z.array(PruneTarget).min(1),
		/** Only objects older than this; 0 prunes everything unused. */
		untilHours: z.number().int().min(0).max(8_760),
	}),
]);
export type DiskRequest = z.infer<typeof DiskRequest>;

/**
 * An absolute path inside a container in normal form ("/a/b"): `.` and empty segments dropped;
 * `..`, control characters and relative paths throw. The engine also keeps every path, symlinks
 * included, inside the container root.
 */
export function normalizeContainerPath(input: string): string {
	if (!input.startsWith("/")) throw new Error("must be an absolute path");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
	if (/[\u0000-\u001f\u007f]/.test(input))
		throw new Error("control characters are not allowed");
	const parts = input.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.includes("..")) throw new Error(".. is not allowed");
	const path = `/${parts.join("/")}`;
	if (path.length > 4096) throw new Error("longer than 4096 characters");
	return path;
}

const ContainerPath = z.string().refine((p) => {
	try {
		return normalizeContainerPath(p) === p;
	} catch {
		return false;
	}
}, "not a normalized absolute path");

/** Children listed per directory; more sets `truncated`. Keeps the reply under MAX_FRAME_BYTES. */
export const MAX_DIR_ENTRIES = 1000;
/** Largest file read through the archive endpoint (view or download). */
export const MAX_ARCHIVE_READ_BYTES = 50 * 1024 * 1024;
/** Largest tar accepted for a write: a 50 MB file plus headers. */
export const MAX_ARCHIVE_WRITE_BYTES = 50 * 1024 * 1024 + 64 * 1024;

export const FileEntry = z.object({
	name: z.string(),
	type: z.enum(["file", "dir", "symlink", "other"]),
	size: Bytes,
	/** Permission bits. */
	mode: z.number().int().nonnegative(),
	/** Unix seconds. */
	modifiedAt: z.number(),
	linkTarget: z.string().max(256).optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/**
 * A container filesystem operation through the engine's archive endpoint, run by the daemon
 * (as root) with no process in the container. Symlinks at `path` are followed.
 * - `stat`: the path, plus its children when it is a directory.
 * - `read`: a regular file's content as `archive.data`, cut at `limitBytes`.
 * - `write`: extracts the tar sent as `exec.stdin` frames (up to MAX_ARCHIVE_WRITE_BYTES, ended
 *   by `eof`) into the directory `path`.
 * - `host-dirs`: the directories under `path` on the agent's own host, read from its read-only
 *   view of `/` with symlinks resolved inside it. Picks a bind mount source; no container needed.
 */
export const ArchiveRequest = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("stat"),
		target: ContainerTarget,
		path: ContainerPath,
	}),
	z.object({
		op: z.literal("read"),
		target: ContainerTarget,
		path: ContainerPath,
		limitBytes: z.number().int().positive().max(MAX_ARCHIVE_READ_BYTES),
	}),
	z.object({
		op: z.literal("write"),
		target: ContainerTarget,
		path: ContainerPath,
	}),
	z.object({ op: z.literal("host-dirs"), path: ContainerPath }),
]);
export type ArchiveRequest = z.infer<typeof ArchiveRequest>;

export const ArchiveResult = z.object({
	/** `path` with symlinks resolved. */
	path: z.string(),
	entry: FileEntry,
	/** A directory's children, directories first; null for anything else. */
	entries: z.array(FileEntry).max(MAX_DIR_ENTRIES).nullable(),
	/** Children past MAX_DIR_ENTRIES or the listing time budget, or content past `limitBytes`. */
	truncated: z.boolean(),
});
export type ArchiveResult = z.infer<typeof ArchiveResult>;

export const rpcErrorCodes = [
	"not_found",
	"bad_request",
	"docker",
	"timeout",
	"backpressure",
	"cancelled",
	"internal",
] as const;
export const RpcErrorCode = z.enum(rpcErrorCodes);
export type RpcErrorCode = z.infer<typeof RpcErrorCode>;

const req = <T extends string>(type: T) => ({
	type: z.literal(type),
	id: RequestId,
});

export const AgentMessage = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("hello"),
		protocol: z.literal(AGENT_PROTOCOL_VERSION),
		nodeId: z.string().min(1).max(64),
		hostname: z.string().min(1).max(255),
		version: z.string().max(64),
		capabilities: z.array(z.string()),
		role: NodeRole.optional(),
		/** Swarm `NodeAddr`. */
		address: z.string().max(255).optional(),
	}),
	z.object({ type: z.literal("heartbeat"), at: z.number() }),
	z.object({
		type: z.literal("metrics"),
		at: z.number(),
		/** Null when the host's /proc is not readable (e.g. a dev run on macOS). */
		host: HostMetrics.nullable(),
		containers: z.array(ContainerMetrics),
	}),
	z.object({ type: z.literal("docker_event"), event: DockerEventPayload }),
	z.object({ ...req("exec.output"), stream: OutputStream, data: Base64 }),
	z.object({ ...req("exec.exit"), code: z.number().int().nullable() }),
	/** Stdin bytes written into the process so far; sent only for an exec started with `stdinAck`. */
	z.object({ ...req("exec.stdin.ack"), bytes: Bytes }),
	z.object({
		...req("logs.line"),
		stream: OutputStream,
		line: z.string().max(MAX_LINE_BYTES),
	}),
	z.object(req("logs.end")),
	z.object({ ...req("job.output"), stream: OutputStream, data: Base64 }),
	z.object({
		...req("job.result"),
		exitCode: z.number().int().nullable(),
		bytes: Bytes,
		truncated: z.boolean(),
		durationMs: Bytes,
	}),
	/** Usage after the request, so a prune also answers with what is left. */
	z.object({
		...req("disk.result"),
		usage: DiskUsage,
		report: PruneReport.nullable(),
	}),
	z.object({ ...req("archive.data"), data: Base64 }),
	z.object({ ...req("archive.result"), ...ArchiveResult.shape }),
	/** Telemetry: per-drain delivery state on this node. */
	z.object({
		type: z.literal("drains.status"),
		at: z.number(),
		drains: z.array(DrainNodeStatus).max(500),
	}),
	/** Outcome of `drains.test`: the destination's HTTP status, never its body. */
	z.object({
		...req("drains.result"),
		ok: z.boolean(),
		status: z.number().int().optional(),
		error: z.string().max(1024).optional(),
	}),
	/** Closed minutes of traffic aggregates; the server answers `traffic.ack` with the same `seq` once they are durable. */
	z.object({
		type: z.literal("traffic"),
		seq: z.number().int().nonnegative(),
		minutes: z.array(TrafficMinute).max(500),
	}),
	z.object({
		...req("rpc.error"),
		code: RpcErrorCode,
		message: z.string().max(4096),
	}),
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

export const ExecStart = z.object({
	target: ContainerTarget,
	cmd: z.array(z.string()).min(1),
	tty: z.boolean().default(false),
	stdin: z.boolean().default(true),
	/** Report stdin progress with `exec.stdin.ack` (agents with the `stdin-ack` capability). */
	stdinAck: z.boolean().optional(),
	env: z.array(z.string()).default([]),
	user: z.string().optional(),
	workingDir: z.string().optional(),
	size: z
		.object({
			rows: z.number().int().positive(),
			cols: z.number().int().positive(),
		})
		.optional(),
});
export type ExecStartInput = z.input<typeof ExecStart>;

export const LogsFollow = z.object({
	target: ContainerTarget,
	tail: z
		.union([z.number().int().nonnegative(), z.literal("all")])
		.default(100),
	/** Unix seconds. */
	since: z.number().int().nonnegative().optional(),
	timestamps: z.boolean().default(true),
});
export type LogsFollowInput = z.input<typeof LogsFollow>;

export const ServerMessage = z.discriminatedUnion("type", [
	/** Reply to `hello`; carries a node token only when the agent enrolled. */
	z.object({
		type: z.literal("hello.ok"),
		nodeToken: z.string().min(1).max(256).optional(),
	}),
	z.object({ type: z.literal("heartbeat"), at: z.number() }),
	z.object({ ...req("exec.start"), ...ExecStart.shape }),
	z.object({
		...req("exec.stdin"),
		data: Base64,
		eof: z.boolean().default(false),
	}),
	z.object({
		...req("exec.resize"),
		rows: z.number().int().positive(),
		cols: z.number().int().positive(),
	}),
	z.object(req("exec.close")),
	z.object({ ...req("logs.follow"), ...LogsFollow.shape }),
	z.object(req("logs.stop")),
	z.object({ ...req("run.job"), job: JobSpec }),
	z.object(req("job.cancel")),
	/** Bytes of the job's output the consumer has read so far. */
	z.object({ ...req("job.ack"), bytes: Bytes }),
	z.object({ ...req("disk.run"), request: DiskRequest }),
	z.object({ ...req("archive.start"), request: ArchiveRequest }),
	/** Replaces the agent's whole drain setup; not a request, nothing answers it. */
	z.object({ type: z.literal("drains.config"), ...DrainsConfig.shape }),
	/** Replaces the agent's traffic analytics setup (capability `traffic`). */
	z.object({ type: z.literal("traffic.config"), ...TrafficConfig.shape }),
	z.object({
		type: z.literal("traffic.ack"),
		seq: z.number().int().nonnegative(),
	}),
	/** Sends one test line through `drain` from this node. */
	z.object({ ...req("drains.test"), drain: LogDrainConfig }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerMessageInput = z.input<typeof ServerMessage>;

/** Parses one text frame; rejects oversize frames before JSON.parse. */
export function parseFrame<T extends z.ZodType>(
	schema: T,
	raw: string,
): z.infer<T> {
	if (raw.length > MAX_FRAME_BYTES)
		throw new Error(`frame of ${raw.length} bytes exceeds ${MAX_FRAME_BYTES}`);
	return schema.parse(JSON.parse(raw));
}
