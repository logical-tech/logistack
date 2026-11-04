import {
	AGENT_RPC_PING_MS,
	type AgentRpcErrorCode,
	AgentRpcReply,
	type AgentRpcRequest,
	agentRpcChannel,
	agentRpcReplyChannel,
	type DiskRequest,
	type DiskUsage,
	type ExecStartInput,
	type JobSpecInput,
	type LogsFollowInput,
	MAX_CHUNK_BYTES,
	type PruneReport,
	parseFrame,
} from "@logistack/contracts";
import { RedisClient } from "bun";

// Worker side of the agent RPC bridge (protocol in packages/contracts/src/agent-rpc.ts). The api
// imports it too, so routes reach a node the same way whichever replica holds its socket.

export class NodeRunnerError extends Error {
	override name = "NodeRunnerError";
	constructor(
		readonly code: AgentRpcErrorCode,
		message: string,
	) {
		super(message);
	}
}

export type OutputChunk = { stream: "stdout" | "stderr"; data: Uint8Array };
export type LogLine = { stream: "stdout" | "stderr"; line: string };
export type JobResult = {
	exitCode: number | null;
	bytes: number;
	truncated: boolean;
	durationMs: number;
};

export type RunOptions = {
	/** Aborting cancels the request on the agent and fails it with code `cancelled`. */
	signal?: AbortSignal;
	/** Fails with code `timeout` and cancels. Default: none, or the job's timeoutSec plus a minute. */
	timeoutMs?: number;
};

/** Iterate for the output; `result` settles at the end whether or not anything iterates. Leaving the loop early cancels. */
export type NodeStream<T, R> = AsyncIterableIterator<T> & {
	result: Promise<R>;
};

export type NodeExec = NodeStream<OutputChunk, { code: number | null }> & {
	write(data: string | Uint8Array): Promise<void>;
	/** EOF on the process stdin. */
	end(): Promise<void>;
	resize(rows: number, cols: number): Promise<void>;
	/** Same as aborting: cancels the exec. */
	close(): void;
};

/** The last `n` characters, marked as cut. */
export const tail = (s: string, n = 2000) =>
	s.length > n ? `…${s.slice(-n)}` : s;

/** A fed exec exited non-zero; `stderr` is its tail. */
export class ExecFailed extends Error {
	override name = "ExecFailed";
	constructor(
		readonly code: number | null,
		readonly stderr: string,
	) {
		super(`exit ${code}: ${tail(stderr, 600)}`);
	}
}

/** Streams `source` into the exec's stdin, then waits for its exit; throws `ExecFailed` on a non-zero one. */
export async function feed(
	exec: NodeExec,
	source: AsyncIterable<Uint8Array>,
	onBytes: (n: number) => void = () => {},
): Promise<void> {
	let err = "";
	const dec = new TextDecoder();
	const drain = (async () => {
		for await (const c of exec)
			if (c.stream === "stderr")
				err = tail(err + dec.decode(c.data, { stream: true }), 4000);
	})();
	let bytes = 0;
	try {
		for await (const chunk of source) {
			await exec.write(chunk);
			bytes += chunk.byteLength;
			onBytes(bytes);
		}
		await exec.end();
	} catch (e) {
		exec.close();
		throw e;
	}
	await drain.catch(() => {});
	const { code } = await exec.result;
	if (code !== 0) throw new ExecFailed(code, err.trim());
}

export type NodeRunner = {
	/** `nodeId` is the Swarm node id. A job runs to completion even if nobody iterates its output. */
	runJob(
		nodeId: string,
		job: JobSpecInput,
		opts?: RunOptions,
	): NodeStream<OutputChunk, JobResult>;
	exec(nodeId: string, req: ExecStartInput, opts?: RunOptions): NodeExec;
	followLogs(
		nodeId: string,
		req: LogsFollowInput,
		opts?: RunOptions,
	): NodeStream<LogLine, void>;
	/** Disk breakdown of the node, after a prune when `req.op` is `prune`. */
	disk(
		nodeId: string,
		req: DiskRequest,
		opts?: RunOptions,
	): Promise<DiskResult>;
	close(): void;
};

export type DiskResult = { usage: DiskUsage; report: PruneReport | null };

type Start = Extract<
	AgentRpcRequest,
	{ type: "job" | "exec" | "logs" | "disk" }
>;
type Step<T, R> = { item: T } | { done: R } | undefined;

const decode = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

export async function createNodeRunner(
	redisUrl: string,
	opts: {
		/** Fails a request with `timeout` when its replica sends nothing for this long. */
		idleTimeoutMs?: number;
	} = {},
): Promise<NodeRunner> {
	const pub = new RedisClient(redisUrl);
	// A subscribed connection cannot publish, hence a second one.
	const sub = new RedisClient(redisUrl);
	await Promise.all([pub.connect(), sub.connect()]);
	const idleMs = opts.idleTimeoutMs ?? 3 * AGENT_RPC_PING_MS;

	function open<T, R>(
		nodeId: string,
		start: Start,
		map: (m: AgentRpcReply) => Step<T, R>,
		run: RunOptions,
	) {
		const { id } = start;
		const publish = (m: AgentRpcRequest) =>
			pub.publish(agentRpcChannel(nodeId), JSON.stringify(m));
		// stdin, resize and cancel must reach the replica after the start request.
		let started: Promise<void> = Promise.resolve();
		const control = async (m: AgentRpcRequest) => {
			await started;
			if (!outcome || m.type === "cancel") await publish(m);
		};
		const items: T[] = [];
		let wake: (() => void) | undefined;
		let outcome:
			| { ok: true; value: R }
			| { ok: false; error: Error }
			| undefined;
		let settle!: { resolve(v: R): void; reject(e: Error): void };
		const result = new Promise<R>((resolve, reject) => {
			settle = { resolve, reject };
		});
		// The caller may only iterate; its failure then surfaces there, not as an unhandled rejection.
		result.catch(() => {});

		let idle: Timer | undefined;
		let deadline: Timer | undefined;
		const touch = () => {
			clearTimeout(idle);
			idle = setTimeout(
				() =>
					fail(
						new NodeRunnerError(
							"timeout",
							`no reply from the replica holding node ${nodeId} for ${idleMs} ms`,
						),
						true,
					),
				idleMs,
			);
		};

		function finish(o: NonNullable<typeof outcome>) {
			if (outcome) return;
			outcome = o;
			clearTimeout(idle);
			clearTimeout(deadline);
			run.signal?.removeEventListener("abort", onAbort);
			void sub.unsubscribe(agentRpcReplyChannel(id)).catch(() => {});
			if (o.ok) settle.resolve(o.value);
			else settle.reject(o.error);
			wake?.();
		}
		function fail(error: Error, cancel: boolean) {
			if (outcome) return;
			if (cancel) void control({ type: "cancel", id }).catch(() => {});
			finish({ ok: false, error });
		}
		const onAbort = () =>
			fail(new NodeRunnerError("cancelled", "request cancelled"), true);

		function onReply(raw: string) {
			if (outcome) return;
			touch();
			let m: AgentRpcReply;
			try {
				m = parseFrame(AgentRpcReply, raw);
			} catch (e) {
				return fail(
					new NodeRunnerError("internal", `bad reply: ${String(e)}`),
					true,
				);
			}
			if (m.type === "ping") return;
			if (m.type === "error")
				return fail(new NodeRunnerError(m.code, m.message), false);
			const step = map(m);
			if (!step) return;
			if ("done" in step) return finish({ ok: true, value: step.done });
			items.push(step.item);
			wake?.();
		}

		started = (async () => {
			if (run.signal?.aborted) return onAbort();
			run.signal?.addEventListener("abort", onAbort, { once: true });
			if (run.timeoutMs !== undefined)
				deadline = setTimeout(
					() =>
						fail(
							new NodeRunnerError(
								"timeout",
								`request exceeded ${run.timeoutMs} ms`,
							),
							true,
						),
					run.timeoutMs,
				);
			try {
				await sub.subscribe(agentRpcReplyChannel(id), onReply);
				if (outcome) return;
				touch();
				if ((await publish(start)) === 0)
					fail(
						new NodeRunnerError(
							"offline",
							`node ${nodeId} is offline: no api replica holds its agent connection`,
						),
						false,
					);
			} catch (e) {
				fail(new NodeRunnerError("internal", `redis: ${String(e)}`), false);
			}
		})();

		const iterator: NodeStream<T, R> = {
			result,
			[Symbol.asyncIterator]() {
				return this;
			},
			async next(): Promise<IteratorResult<T>> {
				for (;;) {
					const item = items.shift();
					if (item !== undefined) return { value: item, done: false };
					if (outcome) {
						if (outcome.ok) return { value: undefined, done: true };
						throw outcome.error;
					}
					await new Promise<void>((r) => {
						wake = r;
					});
					wake = undefined;
				}
			},
			async return(): Promise<IteratorResult<T>> {
				fail(new NodeRunnerError("cancelled", "iteration stopped"), true);
				return { value: undefined, done: true };
			},
		};
		return { iterator, control, fail };
	}

	return {
		runJob(nodeId, job, run = {}) {
			return open<OutputChunk, JobResult>(
				nodeId,
				{ type: "job", id: crypto.randomUUID(), job },
				(m) =>
					m.type === "output"
						? { item: { stream: m.stream, data: decode(m.data) } }
						: m.type === "result"
							? {
									done: {
										exitCode: m.exitCode,
										bytes: m.bytes,
										truncated: m.truncated,
										durationMs: m.durationMs,
									},
								}
							: undefined,
				{ timeoutMs: (job.timeoutSec + 60) * 1000, ...run },
			).iterator;
		},

		disk(nodeId, req, run = {}) {
			return open<never, DiskResult>(
				nodeId,
				{ type: "disk", id: crypto.randomUUID(), req },
				(m) =>
					m.type === "disk"
						? { done: { usage: m.usage, report: m.report } }
						: undefined,
				// A df walks every volume and a prune can delete gigabytes.
				{ timeoutMs: 10 * 60_000, ...run },
			).iterator.result;
		},

		exec(nodeId, req, run = {}) {
			const id = crypto.randomUUID();
			const { iterator, control, fail } = open<
				OutputChunk,
				{ code: number | null }
			>(
				nodeId,
				{ type: "exec", id, req },
				(m) =>
					m.type === "output"
						? { item: { stream: m.stream, data: decode(m.data) } }
						: m.type === "exit"
							? { done: { code: m.code } }
							: undefined,
				run,
			);
			const stdin = async (data: Uint8Array, eof: boolean) => {
				let at = 0;
				do {
					const chunk = data.subarray(at, at + MAX_CHUNK_BYTES);
					at += MAX_CHUNK_BYTES;
					await control({
						type: "stdin",
						id,
						data: Buffer.from(chunk).toString("base64"),
						eof: eof && at >= data.length,
					});
				} while (at < data.length);
			};
			return Object.assign(iterator, {
				write: (data: string | Uint8Array) =>
					stdin(
						typeof data === "string" ? new TextEncoder().encode(data) : data,
						false,
					),
				end: () => stdin(new Uint8Array(0), true),
				resize: async (rows: number, cols: number) => {
					await control({ type: "resize", id, rows, cols });
				},
				close: () =>
					fail(new NodeRunnerError("cancelled", "exec closed"), true),
			});
		},

		followLogs(nodeId, req, run = {}) {
			return open<LogLine, void>(
				nodeId,
				{ type: "logs", id: crypto.randomUUID(), req },
				(m) =>
					m.type === "line"
						? { item: { stream: m.stream, line: m.line } }
						: m.type === "end"
							? { done: undefined }
							: undefined,
				run,
			).iterator;
		},

		close() {
			sub.close();
			pub.close();
		},
	};
}
