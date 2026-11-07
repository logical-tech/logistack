import { z } from "zod";
import {
	ArchiveRequest,
	ArchiveResult,
	DiskRequest,
	DiskUsage,
	ExecStart,
	JobSpec,
	LogsFollow,
	MAX_CHUNK_BYTES,
	MAX_LINE_BYTES,
	PruneReport,
	rpcErrorCodes,
} from "./agent.ts";

// Agent RPC over Redis: lets any process reach a node whose agent socket lives on some api
// replica. The caller subscribes to agentRpcReplyChannel(id), then publishes a start request on
// agentRpcChannel(nodeId). Only the replica holding that node's socket subscribes to that channel,
// so PUBLISH returning 0 means the node is offline. The replica streams replies, a `ping` every
// AGENT_RPC_PING_MS, and ends with exactly one of `result`, `exit`, `end`, `disk`, `archive` or
// `error`. An archive read streams its content as `output` on stdout; a write takes `stdin`.
// `stdin`, `resize`, `ack` and `cancel` go to the node channel too, after the start request.

export const agentRpcChannel = (nodeId: string) => `ls:agent:rpc:${nodeId}`;
export const agentRpcReplyChannel = (requestId: string) =>
	`ls:agent:rpc:reply:${requestId}`;
export const AGENT_RPC_PING_MS = 5_000;

export const agentRpcErrorCodes = [
	...rpcErrorCodes,
	/** No replica holds the node's agent socket. */
	"offline",
	/** The agent socket closed mid-request. */
	"disconnected",
] as const;
export type AgentRpcErrorCode = (typeof agentRpcErrorCodes)[number];

const Id = z.string().min(1).max(64);
const Base64 = z.string().max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4);
const OutputStream = z.enum(["stdout", "stderr"]);

export const AgentRpcRequest = z.discriminatedUnion("type", [
	z.object({ type: z.literal("job"), id: Id, job: JobSpec }),
	z.object({ type: z.literal("exec"), id: Id, req: ExecStart }),
	z.object({ type: z.literal("logs"), id: Id, req: LogsFollow }),
	z.object({ type: z.literal("disk"), id: Id, req: DiskRequest }),
	z.object({ type: z.literal("archive"), id: Id, req: ArchiveRequest }),
	z.object({
		type: z.literal("stdin"),
		id: Id,
		data: Base64,
		eof: z.boolean(),
	}),
	z.object({
		type: z.literal("resize"),
		id: Id,
		rows: z.number().int().positive(),
		cols: z.number().int().positive(),
	}),
	z.object({ type: z.literal("cancel"), id: Id }),
	/** A job's `job.ack`: output bytes the caller has read. */
	z.object({
		type: z.literal("ack"),
		id: Id,
		bytes: z.number().int().nonnegative(),
	}),
]);
export type AgentRpcRequest = z.input<typeof AgentRpcRequest>;

export const AgentRpcReply = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ping") }),
	z.object({ type: z.literal("output"), stream: OutputStream, data: Base64 }),
	z.object({
		type: z.literal("line"),
		stream: OutputStream,
		line: z.string().max(MAX_LINE_BYTES),
	}),
	z.object({ type: z.literal("exit"), code: z.number().int().nullable() }),
	/** An exec's stdin bytes the process has taken (or, from an older agent, the replica has sent on). */
	z.object({
		type: z.literal("stdinAck"),
		bytes: z.number().int().nonnegative(),
	}),
	z.object({
		type: z.literal("result"),
		exitCode: z.number().int().nullable(),
		bytes: z.number().int().nonnegative(),
		truncated: z.boolean(),
		durationMs: z.number().int().nonnegative(),
	}),
	z.object({ type: z.literal("end") }),
	z.object({
		type: z.literal("disk"),
		usage: DiskUsage,
		report: PruneReport.nullable(),
	}),
	z.object({ type: z.literal("archive"), ...ArchiveResult.shape }),
	z.object({
		type: z.literal("error"),
		code: z.enum(agentRpcErrorCodes),
		message: z.string().max(4096),
	}),
]);
export type AgentRpcReply = z.infer<typeof AgentRpcReply>;
