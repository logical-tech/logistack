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
import { AgentError, type Agents, type ExecHandle } from "./agent-gateway.ts";
import { log } from "./log.ts";

type Active = {
	abort: AbortController;
	exec?: ExecHandle;
	/** Serializes stdin writes, which wait for the agent socket to drain. */
	chain: Promise<void>;
};

const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

/**
 * Executes agent RPC requests (contracts/agent-rpc.ts) for the nodes whose sockets this replica
 * holds: it subscribes to a node's channel while the node is connected here.
 * shortcut: with several api replicas, a half-open socket on another replica could also answer; add an owner key if the api scales out.
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
	const reply = (id: string, m: AgentRpcReply) =>
		pub
			.publish(agentRpcReplyChannel(id), JSON.stringify(m))
			.catch((e) =>
				log("error", "agent rpc reply failed", { id, error: String(e) }),
			);

	async function run(
		nodeId: string,
		m: Extract<AgentRpcRequest, { type: "job" | "exec" | "logs" | "disk" }>,
		a: Active,
	) {
		const ping = setInterval(
			() => reply(m.id, { type: "ping" }),
			opts.pingMs ?? AGENT_RPC_PING_MS,
		);
		const signal = a.abort.signal;
		try {
			if (m.type === "job") {
				for await (const e of agents.runJob(nodeId, m.job, { signal }))
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
			} else if (m.type === "logs") {
				for await (const l of agents.followLogs(nodeId, m.req, { signal }))
					await reply(m.id, { type: "line", ...l });
				await reply(m.id, { type: "end" });
			} else {
				a.exec = agents.exec(nodeId, m.req, { signal });
				for await (const e of a.exec)
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
			m.type === "disk"
		) {
			if (active.has(m.id)) return;
			const a: Active = {
				abort: new AbortController(),
				chain: Promise.resolve(),
			};
			active.set(m.id, a);
			void run(nodeId, m, a);
			return;
		}
		const a = active.get(m.id);
		if (!a) return;
		if (m.type === "cancel") return a.abort.abort();
		const exec = a.exec;
		if (!exec) return;
		if (m.type === "resize") return exec.resize(m.rows, m.cols);
		const data = Buffer.from(m.data, "base64");
		const eof = m.eof;
		a.chain = a.chain
			.then(async () => {
				if (data.length) await exec.write(data);
				if (eof) await exec.end();
			})
			.catch((e) =>
				log("warn", "agent rpc stdin failed", { id: m.id, error: String(e) }),
			);
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
