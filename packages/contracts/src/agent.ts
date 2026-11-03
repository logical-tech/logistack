import { z } from "zod";
import { NodeRole } from "./enums.ts";

// Agent <-> server protocol. The agent dials AGENT_WS_PATH with `Authorization: Bearer <token>`
// and AGENT_NODE_HEADER, then sends `hello` first. Until the server answers `hello.ok` with a
// per-node `lsn_` token, the token is the installer's enrollment token; the agent keeps the node
// token and presents it from then on. Every frame is one JSON text message parsed with AgentMessage or
// ServerMessage. Requests carry an `id` chosen by the server; every reply for that request
// carries the same `id` and the stream ends with exactly one terminal message
// (`exec.exit`, `job.result`, `rpc.error`, or `logs.end`).
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
