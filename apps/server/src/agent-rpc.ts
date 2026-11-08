import {
	AGENT_RPC_PING_MS,
	type AgentRpcErrorCode,
	type AgentRpcReply,
	AgentRpcRequest,
	agentRpcChannel,
	agentRpcReplyChannel,
	parseFrame,
} from "@logistack/contracts";
import { RedisClient } from "bun";
import {
	AgentError,
	type Agents,
	type ExecHandle,
	NODE_KEY,
} from "./agent-gateway.ts";
import { log } from "./log.ts";

type Active = {
	abort: AbortController;
	/** Where `stdin` and `resize` go: an exec, or an archive write. */
	exec?: Pick<ExecHandle, "write" | "end"> &
		Partial<Pick<ExecHandle, "resize">>;
	/** Serializes stdin writes, which wait for the agent socket to drain. */
	chain: Promise<void>;
	ack?: (bytes: number) => void;
};

const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

/**
 * Executes agent RPC requests (contracts/agent-rpc.ts) for the nodes whose sockets this replica
 * holds: it subscribes to a node's channel while the node is connected here. With several api
 * replicas a node that reconnected elsewhere can leave a half-open socket behind; `ls:nodes:<id>`
 * names the replica of the newest socket, and only that one answers.
 */
export async function serveAgentRpc(
	agents: Agents,
	redisUrl: string,
	opts: { pingMs?: number } = {},
) {
	const pub = new RedisClient(redisUrl);
	const sub = new RedisClient(redisUrl);
	const subscribed = new Set<string>();
	const active = new Map<string, Active>();
	/** False when the node's newest socket is on another replica. */
	const owns = async (nodeId: string) => {
		try {
			const raw = await pub.get(NODE_KEY(nodeId));
			const replica = raw
				? (JSON.parse(raw) as { replica?: string }).replica
				: undefined;
			// No record (expired) or one from a replica predating owner keys: this socket answers.
			return replica === undefined || replica === agents.replicaId;
		} catch (e) {
			log("warn", "agent rpc owner check failed", { nodeId, error: String(e) });
			return true;
		}
	};
	const reply = (id: string, m: AgentRpcReply) =>
		pub
			.publish(agentRpcReplyChannel(id), JSON.stringify(m))
			.catch((e) =>
				log("error", "agent rpc reply failed", { id, error: String(e) }),
			);

	async function run(
		nodeId: string,
		m: Extract<
			AgentRpcRequest,
			{ type: "job" | "exec" | "logs" | "disk" | "archive" | "drain-test" }
		>,
		a: Active,
	) {
		const ping = setInterval(
			() => reply(m.id, { type: "ping" }),
			opts.pingMs ?? AGENT_RPC_PING_MS,
		);
		const signal = a.abort.signal;
		try {
			if (m.type === "job") {
				const h = agents.runJob(nodeId, m.job, { signal });
				a.ack = h.ack;
				for await (const e of h)
					await reply(
						m.id,
						e.type === "output"
							? { type: "output", stream: e.stream, data: b64(e.data) }
							: { ...e, type: "result" },
					);
			} else if (m.type === "disk") {
				await reply(m.id, {
					type: "disk",
					...(await agents.disk(nodeId, m.req, { signal })),
				});
			} else if (m.type === "drain-test") {
				await reply(m.id, {
					type: "drain",
					...(await agents.testDrain(nodeId, m.drain, { signal })),
				});
			} else if (m.type === "archive") {
				const h = agents.archive(nodeId, m.req, { signal });
				a.exec = h;
				for await (const e of h)
					await reply(
						m.id,
						e.type === "data"
							? { type: "output", stream: "stdout", data: b64(e.data) }
							: { ...e, type: "archive" },
					);
			} else if (m.type === "logs") {
				for await (const l of agents.followLogs(nodeId, m.req, { signal }))
					await reply(m.id, { type: "line", ...l });
				await reply(m.id, { type: "end" });
			} else {
				const h = agents.exec(nodeId, m.req, { signal });
				a.exec = h;
				h.onStdinAck((bytes) => void reply(m.id, { type: "stdinAck", bytes }));
				for await (const e of h)
					await reply(
						m.id,
						e.type === "output"
							? { type: "output", stream: e.stream, data: b64(e.data) }
							: e,
					);
			}
		} catch (e) {
			const code: AgentRpcErrorCode =
				e instanceof AgentError
					? e.code === "not_connected"
						? "offline"
						: e.code
					: "internal";
			await reply(m.id, {
				type: "error",
				code,
				message: (e instanceof Error ? e.message : String(e)).slice(0, 4096),
			});
		} finally {
			clearInterval(ping);
			active.delete(m.id);
		}
	}

	function onRequest(nodeId: string, raw: string) {
		let m: AgentRpcRequest;
		try {
			m = parseFrame(AgentRpcRequest, raw);
		} catch (e) {
			log("warn", "dropped malformed agent rpc request", {
				nodeId,
				error: String(e).slice(0, 200),
			});
			return;
		}
		if (
			m.type === "job" ||
			m.type === "exec" ||
			m.type === "logs" ||
			m.type === "disk" ||
			m.type === "archive" ||
			m.type === "drain-test"
		) {
			if (active.has(m.id)) return;
			const a: Active = {
				abort: new AbortController(),
				chain: Promise.resolve(),
			};
			active.set(m.id, a);
			const mine = owns(nodeId);
			void mine.then((yes) => {
				if (yes) void run(nodeId, m, a);
				else active.delete(m.id);
			});
			// Frames that arrive during the owner check wait for it (and for `run` to set `exec`).
			a.chain = mine.then(() => {});
			return;
		}
		const a = active.get(m.id);
		if (!a) return;
		if (m.type === "cancel") return a.abort.abort();
		const later = (fn: () => unknown) => {
			a.chain = a.chain
				.then(async () => {
					await fn();
				})
				.catch((e) =>
					log("warn", "agent rpc stdin failed", { id: m.id, error: String(e) }),
				);
		};
		if (m.type === "ack") return later(() => a.ack?.(m.bytes));
		if (m.type === "resize")
			return later(() => a.exec?.resize?.(m.rows, m.cols));
		const data = Buffer.from(m.data, "base64");
		const eof = m.eof;
		later(async () => {
			const exec = a.exec;
			if (!exec) return;
			if (data.length) await exec.write(data);
			if (eof) await exec.end();
		});
	}

	async function track(nodeId: string, connected: boolean) {
		try {
			if (connected && !subscribed.has(nodeId)) {
				subscribed.add(nodeId);
				await sub.subscribe(agentRpcChannel(nodeId), (raw) =>
					onRequest(nodeId, raw),
				);
			} else if (!connected && subscribed.delete(nodeId))
				await sub.unsubscribe(agentRpcChannel(nodeId));
		} catch (e) {
			log("error", "agent rpc subscription failed", {
				nodeId,
				connected,
				error: String(e),
			});
		}
	}

	const unwatch = agents.watch((nodeId, connected) => {
		void track(nodeId, connected);
	});
	await Promise.all(agents.connected().map((n) => track(n.nodeId, true)));

	return {
		close() {
			unwatch();
			for (const a of active.values()) a.abort.abort();
			sub.close();
			pub.close();
		},
	};
}
