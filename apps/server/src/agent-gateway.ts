import { createHash, timingSafeEqual } from "node:crypto";
import {
	AGENT_NODE_HEADER,
	AGENT_WS_PATH,
	AgentMessage,
	type ArchiveRequest,
	type ArchiveResult,
	type DiskRequest,
	type DiskUsage,
	DRAIN_STATUS_TTL_SEC,
	type DrainsConfig,
	HIGH_WATER_BYTES,
	type JobSpecInput,
	type LogDrainConfigInput,
	MAX_CHUNK_BYTES,
	MAX_QUEUED_MESSAGES,
	type PruneReport,
	parseFrame,
	type RpcErrorCode,
	type ServerMessageInput,
	STALL_TIMEOUT_MS,
	TRAFFIC_STREAM,
	type TrafficConfig,
} from "@logistack/contracts";
import type { RedisClient, ServerWebSocket } from "bun";
import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { type Bus, envelope } from "./events.ts";
import { log } from "./log.ts";

export const NODE_KEY = (nodeId: string) => `ls:nodes:${nodeId}`;
export const NODES_KNOWN = "ls:nodes:known";
export const NODES_DOWN = "ls:nodes:down";
export const METRICS_STREAM = "ls:metrics";
export const DOCKER_EVENTS_STREAM = "ls:docker-events";
/** Hash of node id -> that node's latest `DrainNodeStatus` JSON (plus `hostname`, `at`). */
export const DRAIN_STATUS_KEY = (drainId: string) =>
	`ls:drains:${drainId}:status`;

export type AgentHello = Extract<AgentMessage, { type: "hello" }>;

/** An accepted upgrade request. */
export type AgentAdmission = {
	organizationId: string;
	/** Records the node on its hello; returns a fresh node token when the agent enrolled. */
	hello(hello: AgentHello): Promise<{ nodeToken?: string }>;
};

/** A refused upgrade request, answered as `{ error: { code, message } }` with `status`. */
export type AgentRefusal = {
	status: 401 | 403 | 503;
	code: string;
	message: string;
};

export type AgentGatewayDeps = {
	bus: Pick<Bus, "publishEvent">;
	/** A command connection (not the subscriber). */
	redis: RedisClient;
	/** Decides an upgrade request from its bearer token and AGENT_NODE_HEADER. */
	authenticate(
		token: string,
		nodeId: string,
	): Promise<AgentAdmission | AgentRefusal>;
	/** `ls:nodes:<id>` TTL, and how long a closed node may take to come back before `node.down`. */
	ttlSec?: number;
};

/** One shared token admits any node into `organizationId`; for tests and the RSS soak, which have no database. */
export function staticTokenAuth(expected: string, organizationId: string) {
	const digest = (v: string) => createHash("sha256").update(v).digest();
	const want = digest(expected);
	return async (token: string): Promise<AgentAdmission | AgentRefusal> =>
		timingSafeEqual(digest(token), want)
			? { organizationId, hello: async () => ({}) }
			: { status: 401, code: "invalid_token", message: "invalid node token" };
}

export class AgentError extends Error {
	override name = "AgentError";
	constructor(
		readonly code: RpcErrorCode | "disconnected" | "not_connected",
		message: string,
	) {
		super(message);
	}
}

export type AgentNode = {
	nodeId: string;
	hostname: string;
	version: string;
	capabilities: string[];
	organizationId: string;
	connectedAt: Date;
};

export type OutputChunk = { stream: "stdout" | "stderr"; data: Uint8Array };
export type ExecEvent =
	| ({ type: "output" } & OutputChunk)
	| { type: "exit"; code: number | null };
export type JobEvent =
	| ({ type: "output" } & OutputChunk)
	| {
			type: "result";
			exitCode: number | null;
			bytes: number;
			truncated: boolean;
			durationMs: number;
	  };
export type LogLine = { stream: "stdout" | "stderr"; line: string };
export type ArchiveEvent =
	| { type: "data"; data: Uint8Array }
	| ({ type: "result" } & ArchiveResult);

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Req<T extends ServerMessageInput["type"]> = Without<
	Extract<ServerMessageInput, { type: T }>,
	"type" | "id"
>;

export type ExecHandle = AsyncGenerator<ExecEvent> & {
	/** Resolves once the frames are handed to the socket, waiting while it is backed up. */
	write(data: string | Uint8Array): Promise<void>;
	/** EOF on the process stdin. */
	end(): Promise<void>;
	resize(rows: number, cols: number): void;
	close(): void;
	/**
	 * Calls `cb` with the cumulative stdin bytes the process has taken, while the handle is iterated.
	 * An agent without `stdin-ack` cannot tell, so its bytes count once handed to the socket.
	 */
	onStdinAck(cb: (bytes: number) => void): void;
};

/** `ack` reports output bytes read, for a job with `ackWindowBytes`; agents without `job-ack` ignore it. */
export type JobHandle = AsyncGenerator<JobEvent> & { ack(bytes: number): void };

/** An archive request: a read's content, then its result; a write's tar goes in through `write`/`end`. */
export type ArchiveHandle = AsyncGenerator<ArchiveEvent> &
	Pick<ExecHandle, "write" | "end">;

/** Aborting fails the iterator with code `cancelled` and cancels the request on the agent. */
export type CallOptions = { signal?: AbortSignal };

export type Agents = {
	connected(): AgentNode[];
	/** Called when a node's socket on this replica opens (also on a replacing reconnect) or closes. */
	watch(listener: (nodeId: string, connected: boolean) => void): () => void;
	exec(nodeId: string, req: Req<"exec.start">, opts?: CallOptions): ExecHandle;
	followLogs(
		nodeId: string,
		req: Req<"logs.follow">,
		opts?: CallOptions,
	): AsyncGenerator<LogLine>;
	runJob(nodeId: string, job: JobSpecInput, opts?: CallOptions): JobHandle;
	disk(
		nodeId: string,
		req: DiskRequest,
		opts?: CallOptions,
	): Promise<{ usage: DiskUsage; report: PruneReport | null }>;
	/** Replaces a node's drain setup; false when its agent is gone or predates `log-drains`. */
	pushDrains(nodeId: string, config: DrainsConfig): boolean;
	/** Replaces a node's traffic analytics setup; false when its agent is gone or predates `traffic`. */
	pushTraffic(nodeId: string, config: TrafficConfig): boolean;
	/** Sends one test line through `drain` from that node. */
	testDrain(
		nodeId: string,
		drain: LogDrainConfigInput,
		opts?: CallOptions,
	): Promise<{ ok: boolean; status?: number; error?: string }>;
	/** Throws `bad_request` when the node's agent predates the `archive` capability. */
	archive(
		nodeId: string,
		req: ArchiveRequest,
		opts?: CallOptions,
	): ArchiveHandle;
};

type Inbound = Extract<AgentMessage, { id: string }>;
type Conn = {
	node: AgentNode;
	ws: WSContext<ServerWebSocket<unknown>>;
	calls: Map<string, Call>;
};

const TERMINAL = new Set([
	"exec.exit",
	"job.result",
	"disk.result",
	"archive.result",
	"drains.result",
	"logs.end",
	"rpc.error",
]);

/** One request's replies: a bounded queue drained by an async iterator. */
class Call {
	queue: Inbound[] = [];
	failure: AgentError | undefined;
	wake: (() => void) | undefined;

	push(m: Inbound) {
		if (this.queue.length >= MAX_QUEUED_MESSAGES)
			return this.fail(
				new AgentError(
					"backpressure",
					`more than ${MAX_QUEUED_MESSAGES} unread messages`,
				),
			);
		this.queue.push(m);
		this.wake?.();
	}

	fail(e: AgentError) {
		this.failure ??= e;
		this.wake?.();
	}

	async *messages(): AsyncGenerator<Inbound> {
		for (;;) {
			const m = this.queue.shift();
			if (m) {
				if (m.type === "rpc.error") throw new AgentError(m.code, m.message);
				yield m;
				if (TERMINAL.has(m.type)) return;
				continue;
			}
			if (this.failure) throw this.failure;
			await new Promise<void>((r) => {
				this.wake = r;
			});
			this.wake = undefined;
		}
	}
}

const decode = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/** Mounts `GET /api/agent/ws` on `app` and returns the in-process API that routes requests by node id. */
export function mountAgentGateway(
	// biome-ignore lint/suspicious/noExplicitAny: mounts on any Hono app regardless of its Env.
	app: Hono<any>,
	deps: AgentGatewayDeps,
): Agents {
	const { redis, bus } = deps;
	const ttl = deps.ttlSec ?? 30;
	const nodes = new Map<string, Conn>();
	const watchers = new Set<(nodeId: string, connected: boolean) => void>();
	const notify = (nodeId: string, connected: boolean) => {
		for (const w of watchers) w(nodeId, connected);
	};

	const send = (conn: Conn, m: ServerMessageInput) =>
		conn.ws.send(JSON.stringify(m));

	async function drained(conn: Conn) {
		const deadline = Date.now() + STALL_TIMEOUT_MS;
		while (conn.ws.raw && conn.ws.raw.getBufferedAmount() > HIGH_WATER_BYTES) {
			if (Date.now() > deadline)
				throw new AgentError("backpressure", "agent socket stalled");
			await Bun.sleep(20);
		}
	}

	const publish = (
		type: "node.joined" | "node.down" | "node.recovered",
		node: AgentNode,
	) =>
		bus.publishEvent(
			envelope(
				type,
				node.organizationId,
				{ type: "node", id: node.nodeId },
				{
					hostname: node.hostname,
					version: node.version,
				},
			),
		);

	const touch = (node: AgentNode) =>
		redis.send("SET", [
			NODE_KEY(node.nodeId),
			JSON.stringify({ ...node, lastSeenAt: new Date() }),
			"EX",
			String(ttl),
		]);

	async function onHello(node: AgentNode) {
		await touch(node);
		const isNew = (await redis.sadd(NODES_KNOWN, node.nodeId)) === 1;
		const wasDown = (await redis.srem(NODES_DOWN, node.nodeId)) === 1;
		if (isNew) await publish("node.joined", node);
		else if (wasDown) await publish("node.recovered", node);
	}

	// Redis decides, not this replica: the node may have reconnected to another one and refreshed its key.
	function scheduleDownCheck(node: AgentNode) {
		setTimeout(
			async () => {
				try {
					if (
						nodes.has(node.nodeId) ||
						(await redis.exists(NODE_KEY(node.nodeId)))
					)
						return;
					if ((await redis.sadd(NODES_DOWN, node.nodeId)) === 1)
						await publish("node.down", node);
				} catch (e) {
					log("error", "node down check failed", {
						nodeId: node.nodeId,
						error: String(e),
					});
				}
			},
			(ttl + 1) * 1000,
		).unref();
	}

	async function onMessage(conn: Conn, m: AgentMessage) {
		switch (m.type) {
			case "hello":
				return;
			case "heartbeat":
				send(conn, { type: "heartbeat", at: Date.now() });
				await touch(conn.node);
				return;
			case "metrics":
				// A buffer for a worker outage, not storage: the worker acks within seconds, and
				// entries are ~6 KB, so 2000 (~12 MB) covers hours on one node, minutes on many.
				await redis.send("XADD", [
					METRICS_STREAM,
					"MAXLEN",
					"~",
					"2000",
					"*",
					"node",
					conn.node.nodeId,
					"at",
					String(m.at),
					"data",
					JSON.stringify(m),
				]);
				return;
			case "docker_event":
				await redis.send("XADD", [
					DOCKER_EVENTS_STREAM,
					"MAXLEN",
					"~",
					"10000",
					"*",
					"node",
					conn.node.nodeId,
					"event",
					JSON.stringify(m.event),
				]);
				return;
			case "traffic":
				// Acked only once durable in Redis; the agent keeps (bounded) and resends until then.
				await redis.send("XADD", [
					TRAFFIC_STREAM,
					"MAXLEN",
					"~",
					"20000",
					"*",
					"node",
					conn.node.nodeId,
					"data",
					JSON.stringify(m.minutes),
				]);
				send(conn, { type: "traffic.ack", seq: m.seq });
				return;
			case "drains.status":
				for (const d of m.drains) {
					const key = DRAIN_STATUS_KEY(d.drainId);
					await redis.send("HSET", [
						key,
						conn.node.nodeId,
						JSON.stringify({ ...d, hostname: conn.node.hostname, at: m.at }),
					]);
					await redis.send("EXPIRE", [key, String(DRAIN_STATUS_TTL_SEC)]);
				}
				return;
			default:
				conn.calls.get(m.id)?.push(m);
		}
	}

	app.get(
		AGENT_WS_PATH,
		async (c, next) => {
			const token = c.req
				.header("authorization")
				?.match(/^Bearer\s+(\S+)$/i)?.[1];
			const nodeId = c.req.header(AGENT_NODE_HEADER);
			const result: AgentAdmission | AgentRefusal =
				token && nodeId
					? await deps.authenticate(token, nodeId)
					: {
							status: 401,
							code: "unauthorized",
							message: `a bearer token and ${AGENT_NODE_HEADER} are required`,
						};
			if ("status" in result) {
				log("warn", "agent refused", {
					nodeId,
					status: result.status,
					code: result.code,
				});
				return c.json(
					{ error: { code: result.code, message: result.message } },
					result.status,
				);
			}
			c.set("agentAdmission", { ...result, nodeId });
			await next();
		},
		upgradeWebSocket((c) => {
			const admission = c.get("agentAdmission") as AgentAdmission & {
				nodeId: string;
			};
			// Messages arriving while the hello is being recorded wait for it, in order.
			let ready: Promise<Conn | undefined> | undefined;
			let closed = false;

			async function admit(hello: AgentHello, ws: Conn["ws"]) {
				if (hello.nodeId !== admission.nodeId) {
					ws.close(1008, "hello nodeId differs from the upgrade request");
					return undefined;
				}
				let nodeToken: string | undefined;
				try {
					({ nodeToken } = await admission.hello(hello));
				} catch (e) {
					log("error", "agent admission failed", {
						nodeId: hello.nodeId,
						error: String(e),
					});
					ws.close(1011, "admission failed");
					return undefined;
				}
				if (closed) return undefined;
				const node: AgentNode = {
					nodeId: hello.nodeId,
					hostname: hello.hostname,
					version: hello.version,
					capabilities: hello.capabilities,
					organizationId: admission.organizationId,
					connectedAt: new Date(),
				};
				const previous = nodes.get(node.nodeId);
				const conn: Conn = { node, ws, calls: new Map() };
				nodes.set(node.nodeId, conn);
				previous?.ws.close(4000, "replaced by a newer connection");
				send(conn, { type: "hello.ok", nodeToken });
				log("info", "agent connected", {
					nodeId: node.nodeId,
					hostname: node.hostname,
					enrolled: nodeToken !== undefined,
				});
				notify(node.nodeId, true);
				await onHello(node).catch((e) =>
					log("error", "agent hello bookkeeping failed", {
						error: String(e),
					}),
				);
				return conn;
			}

			return {
				async onMessage(evt, ws) {
					let m: AgentMessage;
					try {
						m = parseFrame(AgentMessage, String(evt.data));
					} catch (e) {
						log("warn", "dropped malformed agent message", {
							error: String(e).slice(0, 200),
						});
						return;
					}
					if (!ready) {
						if (m.type !== "hello") return ws.close(1008, "hello first");
						ready = admit(m, ws as Conn["ws"]);
						return;
					}
					const conn = await ready;
					if (!conn) return;
					await onMessage(conn, m).catch((e) =>
						log("error", "agent message failed", {
							type: m.type,
							error: String(e),
						}),
					);
				},
				async onClose() {
					closed = true;
					const conn = await ready;
					if (!conn) return;
					for (const call of conn.calls.values())
						call.fail(
							new AgentError(
								"disconnected",
								`node ${conn.node.nodeId} disconnected`,
							),
						);
					if (nodes.get(conn.node.nodeId) !== conn) return;
					nodes.delete(conn.node.nodeId);
					notify(conn.node.nodeId, false);
					log("warn", "agent disconnected", { nodeId: conn.node.nodeId });
					scheduleDownCheck(conn.node);
				},
			};
		}),
	);

	/** `exec.stdin` frames for request `id`, chunked and paced by the socket. */
	function stdin(conn: Conn, id: string): Pick<ExecHandle, "write" | "end"> {
		const frames = async (data: Uint8Array, eof: boolean) => {
			let at = 0;
			do {
				await drained(conn);
				const chunk = data.subarray(at, at + MAX_CHUNK_BYTES);
				at += MAX_CHUNK_BYTES;
				send(conn, {
					type: "exec.stdin",
					id,
					data: Buffer.from(chunk).toString("base64"),
					eof: eof && at >= data.length,
				});
			} while (at < data.length);
		};
		return {
			write: (data) =>
				frames(
					typeof data === "string" ? new TextEncoder().encode(data) : data,
					false,
				),
			end: () => frames(new Uint8Array(0), true),
		};
	}

	/** Starts a request; iterating yields its replies, and leaving the loop early cancels it on the agent. */
	function start(
		nodeId: string,
		msg: ServerMessageInput & { id: string },
		cancel: "exec.close" | "logs.stop" | "job.cancel",
		signal: AbortSignal | undefined,
	) {
		const found = nodes.get(nodeId);
		if (!found)
			throw new AgentError("not_connected", `node ${nodeId} is not connected`);
		const conn: Conn = found;
		const call = new Call();
		conn.calls.set(msg.id, call);
		const abort = () =>
			call.fail(new AgentError("cancelled", "request cancelled"));
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });
		send(conn, msg);
		async function* replies(): AsyncGenerator<Inbound> {
			let finished = false;
			try {
				for await (const m of call.messages()) {
					if (TERMINAL.has(m.type)) finished = true;
					yield m;
				}
				finished = true;
			} catch (e) {
				finished = !(
					e instanceof AgentError &&
					(e.code === "backpressure" || e.code === "cancelled")
				);
				throw e;
			} finally {
				signal?.removeEventListener("abort", abort);
				conn.calls.delete(msg.id);
				if (!finished && nodes.get(nodeId) === conn)
					send(conn, { type: cancel, id: msg.id });
			}
		}
		return { conn, replies: replies(), id: msg.id };
	}

	return {
		connected: () => [...nodes.values()].map((c) => c.node),

		watch(listener) {
			watchers.add(listener);
			return () => watchers.delete(listener);
		},

		exec(nodeId, req, opts) {
			const acks = nodes.get(nodeId)?.node.capabilities.includes("stdin-ack");
			const { conn, replies, id } = start(
				nodeId,
				{
					...req,
					...(acks ? { stdinAck: true } : {}),
					type: "exec.start",
					id: crypto.randomUUID(),
				},
				"exec.close",
				opts?.signal,
			);
			let onAck: (bytes: number) => void = () => {};
			async function* events(): AsyncGenerator<ExecEvent> {
				for await (const m of replies) {
					if (m.type === "exec.output")
						yield { type: "output", stream: m.stream, data: decode(m.data) };
					else if (m.type === "exec.exit") yield { type: "exit", code: m.code };
					else if (m.type === "exec.stdin.ack") onAck(m.bytes);
				}
			}
			const input = stdin(conn, id);
			let sent = 0;
			return Object.assign(events(), {
				write: async (data: string | Uint8Array) => {
					await input.write(data);
					sent +=
						typeof data === "string" ? Buffer.byteLength(data) : data.length;
					if (!acks) onAck(sent);
				},
				end: input.end,
				onStdinAck: (cb: (bytes: number) => void) => {
					onAck = cb;
				},
				resize: (rows: number, cols: number) =>
					send(conn, { type: "exec.resize", id, rows, cols }),
				close: () => void replies.return(undefined),
			});
		},

		async *followLogs(nodeId, req, opts) {
			const { replies } = start(
				nodeId,
				{ ...req, type: "logs.follow", id: crypto.randomUUID() },
				"logs.stop",
				opts?.signal,
			);
			for await (const m of replies)
				if (m.type === "logs.line") yield { stream: m.stream, line: m.line };
		},

		runJob(nodeId, job, opts) {
			const { conn, replies, id } = start(
				nodeId,
				{ type: "run.job", id: crypto.randomUUID(), job },
				"job.cancel",
				opts?.signal,
			);
			async function* events(): AsyncGenerator<JobEvent> {
				for await (const m of replies) {
					if (m.type === "job.output")
						yield { type: "output", stream: m.stream, data: decode(m.data) };
					else if (m.type === "job.result") {
						const { type: _, id: __, ...result } = m;
						yield { type: "result", ...result };
					}
				}
			}
			const acks = conn.node.capabilities.includes("job-ack");
			return Object.assign(events(), {
				ack: (bytes: number) => {
					if (acks) send(conn, { type: "job.ack", id, bytes });
				},
			});
		},

		async disk(nodeId, req, opts) {
			const { replies } = start(
				nodeId,
				{ type: "disk.run", id: crypto.randomUUID(), request: req },
				// The agent closes any session by id on a cancel; a disk request has nothing to stop.
				"job.cancel",
				opts?.signal,
			);
			for await (const m of replies)
				if (m.type === "disk.result")
					return { usage: m.usage, report: m.report };
			throw new AgentError("internal", "disk request ended without a result");
		},

		pushDrains(nodeId, config) {
			const conn = nodes.get(nodeId);
			if (!conn?.node.capabilities.includes("log-drains")) return false;
			send(conn, { type: "drains.config", ...config });
			return true;
		},

		pushTraffic(nodeId, config) {
			const conn = nodes.get(nodeId);
			if (!conn?.node.capabilities.includes("traffic")) return false;
			send(conn, { type: "traffic.config", ...config });
			return true;
		},

		async testDrain(nodeId, drain, opts) {
			if (nodes.get(nodeId)?.node.capabilities.includes("log-drains") === false)
				throw new AgentError(
					"bad_request",
					`the agent on node ${nodeId} is too old to ship logs; update LogiStack on it`,
				);
			const { replies } = start(
				nodeId,
				{ type: "drains.test", id: crypto.randomUUID(), drain },
				// Nothing to stop on the agent; it ignores a cancel for an unknown session.
				"job.cancel",
				opts?.signal,
			);
			for await (const m of replies)
				if (m.type === "drains.result")
					return { ok: m.ok, status: m.status, error: m.error };
			throw new AgentError("internal", "drain test ended without a result");
		},

		archive(nodeId, req, opts) {
			if (nodes.get(nodeId)?.node.capabilities.includes("archive") === false)
				throw new AgentError(
					"bad_request",
					`the agent on node ${nodeId} is too old to browse files; update LogiStack on it`,
				);
			if (
				req.op === "host-dirs" &&
				nodes.get(nodeId)?.node.capabilities.includes("host-dirs") === false
			)
				throw new AgentError(
					"bad_request",
					`the agent on node ${nodeId} is too old to browse host folders; update LogiStack on it`,
				);
			const { conn, replies, id } = start(
				nodeId,
				{ type: "archive.start", id: crypto.randomUUID(), request: req },
				// The agent closes any session by id on a cancel.
				"exec.close",
				opts?.signal,
			);
			async function* events(): AsyncGenerator<ArchiveEvent> {
				for await (const m of replies)
					if (m.type === "archive.data")
						yield { type: "data", data: decode(m.data) };
					else if (m.type === "archive.result") {
						const { type: _, id: __, ...result } = m;
						yield { type: "result", ...result };
					}
			}
			return Object.assign(events(), stdin(conn, id));
		},
	};
}
