import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import {
	AGENT_NODE_HEADER,
	AGENT_PROTOCOL_VERSION,
	AGENT_WS_PATH,
	type ContainerMetrics,
	type HostMetrics,
	parseFrame,
	ServerMessage,
} from "@logistack/contracts";
import { createDockerClient } from "@logistack/docker";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { type CpuPrev, collectContainers, shouldForward } from "./docker.ts";
import { type CpuSample, readHost } from "./host.ts";
import { Link } from "./link.ts";
import { renderPrometheus } from "./prometheus.ts";
import { createSessions } from "./sessions.ts";

const Config = z.object({
	LOGISTACK_API_URL: z.url(),
	/** The installer's enrollment token, used until the server issues a node token. */
	LOGISTACK_AGENT_TOKEN: z.string().min(1),
	/** Where the issued node token is kept (a per-node volume in the stack). */
	LOGISTACK_AGENT_TOKEN_PATH: z
		.string()
		.default("/var/lib/logistack-agent/node-token"),
	LOGISTACK_NODE_ID: z.string().min(1),
	LOGISTACK_NODE_HOSTNAME: z.string().min(1).default(hostname()),
	HOST_PROC: z.string().default("/proc"),
	HOST_SYS: z.string().default("/sys"),
	HOST_ROOT: z.string().default("/"),
	/** Prometheus `/metrics` on 127.0.0.1; 0 turns it off. */
	LOGISTACK_AGENT_METRICS_PORT: z.coerce
		.number()
		.int()
		.min(0)
		.max(65535)
		.default(9469),
	/** Heartbeat and metrics period. */
	LOGISTACK_AGENT_INTERVAL_MS: z.coerce.number().int().min(100).default(10_000),
});
type Config = z.infer<typeof Config>;

/** Every key also accepts `<KEY>_FILE` (Docker secrets); the file wins. */
function loadConfig(env = process.env): Config {
	const raw: Record<string, string | undefined> = {};
	for (const key of Object.keys(Config.shape)) {
		const file = env[`${key}_FILE`];
		raw[key] = file ? readFileSync(file, "utf8").trim() : env[key];
	}
	return Config.parse(raw);
}

const log = (
	level: "info" | "warn" | "error",
	msg: string,
	fields: Record<string, unknown> = {},
) =>
	console.log(
		JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields }),
	);

/** Full-jitter exponential backoff: uniform in [0, min(30 s, 500 ms * 2^attempt)]. */
export function backoffMs(attempt: number, random = Math.random): number {
	return Math.floor(random() * Math.min(30_000, 500 * 2 ** attempt));
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ConnectFailure = {
	status?: number;
	code?: string;
	closeCode?: number;
	error?: string;
};

/** Logs every failed attempt, except a repeat of the previous failure within `windowMs`, which is counted and reported with the next line. */
export function failureLogger(
	emit: (fields: Record<string, unknown>) => void,
	windowMs = 30_000,
	now = Date.now,
) {
	let last: { key: string; at: number } | undefined;
	let suppressed = 0;
	return (f: ConnectFailure, attempt: number, backoff: number) => {
		const key = JSON.stringify(f);
		if (last?.key === key && now() - last.at < windowMs) {
			suppressed++;
			return;
		}
		emit({ ...f, attempt, backoffMs: backoff, suppressed });
		last = { key, at: now() };
		suppressed = 0;
	};
}

function readToken(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Atomic: a crash mid-write leaves the old token, never half a new one. */
function writeToken(path: string, token: string) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(`${path}.tmp`, token, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

async function main() {
	const cfg = loadConfig();
	const docker = createDockerClient();
	const wsUrl = new URL(
		AGENT_WS_PATH,
		cfg.LOGISTACK_API_URL.replace(/^http/, "ws"),
	);
	const paths = { proc: cfg.HOST_PROC, sys: cfg.HOST_SYS, root: cfg.HOST_ROOT };

	let link: Link | undefined;
	let sessions: ReturnType<typeof createSessions> | undefined;
	const latest: { host: HostMetrics | null; containers: ContainerMetrics[] } = {
		host: null,
		containers: [],
	};

	// Metrics are collected whether or not the server is reachable, so /metrics stays live.
	let cpu: CpuSample | undefined;
	const cpuPrev = new Map<string, CpuPrev>();
	async function collect() {
		const h = readHost(paths, cpu);
		cpu = h?.cpu;
		latest.host = h?.host ?? null;
		latest.containers = await collectContainers(docker, cpuPrev);
	}
	await collect().catch((e) =>
		log("warn", "metrics failed", { error: errMsg(e) }),
	);
	setInterval(async () => {
		try {
			await collect();
			link?.send({ type: "metrics", at: Date.now(), ...latest });
		} catch (e) {
			log("warn", "metrics failed", { error: errMsg(e) });
		}
	}, cfg.LOGISTACK_AGENT_INTERVAL_MS);

	void (async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				for await (const e of docker.events()) {
					attempt = 0;
					if (shouldForward(e))
						link?.send({
							type: "docker_event",
							event: {
								Type: e.Type,
								Action: e.Action,
								Actor: e.Actor,
								scope: e.scope,
								time: e.time,
								timeNano: e.timeNano,
							},
						});
				}
			} catch (e) {
				log("warn", "docker events stream ended", { error: errMsg(e) });
			}
			await Bun.sleep(backoffMs(attempt));
		}
	})();

	if (cfg.LOGISTACK_AGENT_METRICS_PORT)
		Bun.serve({
			hostname: "127.0.0.1",
			port: cfg.LOGISTACK_AGENT_METRICS_PORT,
			fetch: (req) =>
				new URL(req.url).pathname === "/metrics"
					? new Response(
							renderPrometheus({
								...latest,
								connected: link?.open ?? false,
								droppedMessages: Link.dropped,
								sessions: sessions?.size ?? 0,
							}),
							{ headers: { "content-type": "text/plain; version=0.0.4" } },
						)
					: new Response("not found", { status: 404 }),
		});

	let nodeToken = readToken(cfg.LOGISTACK_AGENT_TOKEN_PATH);
	const headers = () => ({
		Authorization: `Bearer ${nodeToken ?? cfg.LOGISTACK_AGENT_TOKEN}`,
		[AGENT_NODE_HEADER]: cfg.LOGISTACK_NODE_ID,
	});

	async function swarmRole() {
		const info = await docker.info().catch(() => undefined);
		if (info?.Swarm.LocalNodeState !== "active") return {};
		return {
			role: info.Swarm.ControlAvailable ? "manager" : "worker",
			address: info.Swarm.NodeAddr || undefined,
		} as const;
	}

	/** One connection attempt; resolves when it closes, with whether the server admitted it. */
	async function connectOnce(): Promise<
		{ admitted: true } | { admitted: false; closeCode: number; reason: string }
	> {
		const swarm = await swarmRole();
		return new Promise((resolve) => {
			const ws = new WebSocket(wsUrl, { headers: headers() });
			let admitted = false;
			let lastHeard = Date.now();
			let heartbeat: Timer | undefined;
			ws.onopen = () => {
				link = new Link(ws);
				sessions = createSessions(docker, link);
				link.send({
					type: "hello",
					protocol: AGENT_PROTOCOL_VERSION,
					nodeId: cfg.LOGISTACK_NODE_ID,
					hostname: cfg.LOGISTACK_NODE_HOSTNAME,
					version: pkg.version,
					capabilities: ["exec", "logs", "jobs", "metrics", "events"],
					...swarm,
				});
				link.send({ type: "metrics", at: Date.now(), ...latest });
				heartbeat = setInterval(() => {
					// The server answers every heartbeat; silence means a half-dead TCP connection.
					if (Date.now() - lastHeard > 3 * cfg.LOGISTACK_AGENT_INTERVAL_MS)
						return ws.close(4001, "server silent");
					link?.send({ type: "heartbeat", at: Date.now() });
				}, cfg.LOGISTACK_AGENT_INTERVAL_MS);
			};
			ws.onmessage = (ev) => {
				lastHeard = Date.now();
				let m: ServerMessage;
				try {
					m = parseFrame(ServerMessage, String(ev.data));
				} catch (e) {
					log("warn", "bad server message", { error: errMsg(e) });
					return;
				}
				if (m.type !== "hello.ok") return sessions?.handle(m);
				admitted = true;
				if (m.nodeToken) {
					nodeToken = m.nodeToken;
					try {
						writeToken(cfg.LOGISTACK_AGENT_TOKEN_PATH, m.nodeToken);
					} catch (e) {
						log(
							"warn",
							"could not persist the node token; keeping it in memory",
							{
								path: cfg.LOGISTACK_AGENT_TOKEN_PATH,
								error: errMsg(e),
							},
						);
					}
				}
				log("info", "connected", {
					url: wsUrl.href,
					enrolled: m.nodeToken !== undefined,
				});
			};
			ws.onclose = (ev) => {
				clearInterval(heartbeat);
				sessions?.closeAll();
				link = sessions = undefined;
				if (admitted) {
					log("warn", "disconnected", { code: ev.code, reason: ev.reason });
					resolve({ admitted });
				} else resolve({ admitted, closeCode: ev.code, reason: ev.reason });
			};
		});
	}

	/** A refused upgrade only surfaces as close 1002 "Expected 101"; the same request without upgrade headers shows why. */
	async function whyRefused(): Promise<ConnectFailure> {
		try {
			const res = await fetch(wsUrl.href.replace(/^ws/, "http"), {
				headers: headers(),
			});
			const body = (await res.json().catch(() => undefined)) as
				| { error?: { code?: string } }
				| undefined;
			return { status: res.status, code: body?.error?.code };
		} catch (e) {
			return { error: errMsg(e) };
		}
	}

	const logFailure = failureLogger((fields) =>
		log("warn", "connection failed", { url: wsUrl.href, ...fields }),
	);
	for (let attempt = 0; ; ) {
		const r = await connectOnce();
		attempt = r.admitted ? 0 : attempt + 1;
		const backoff = backoffMs(attempt);
		if (!r.admitted) {
			const failure: ConnectFailure =
				r.closeCode === 1002
					? await whyRefused()
					: { closeCode: r.closeCode, error: r.reason || undefined };
			logFailure(failure, attempt, backoff);
			if (failure.status === 401 && nodeToken) {
				// Revoked, or a fresh database: enroll again; a revoked node is refused there too.
				nodeToken = undefined;
				log("warn", "node token rejected; retrying with the enrollment token");
			}
		}
		await Bun.sleep(backoff);
	}
}

if (import.meta.main) await main();
