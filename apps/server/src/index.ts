import { importMasterKey } from "@logistack/core";
import { createDb, runMigrations } from "@logistack/db";
import { createNodeRunner } from "@logistack/worker/node-runner";
import { mountAgentGateway } from "./agent-gateway.ts";
import { serveAgentRpc } from "./agent-rpc.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { type Config, loadConfig } from "./config.ts";
import type { Deps } from "./env.ts";
import { createBus } from "./events.ts";
import { log, setLogLevel } from "./log.ts";
import { nodeTokenAuth } from "./node-tokens.ts";
import { closeRedis, redisFor } from "./redis.ts";
import { closeRunQueues } from "./run-queues.ts";
import { websocket } from "./ws.ts";

export type { Actor } from "./actor.ts";
export type { AppType } from "./app.ts";
export { createApp } from "./app.ts";
export { envelope } from "./events.ts";

export async function createDeps(config: Config): Promise<Deps> {
	const db = createDb(config.DATABASE_URL);
	return {
		config,
		db,
		auth: createAuth(config, db),
		masterKey: await importMasterKey(config.LOGISTACK_MASTER_KEY),
		bus: await createBus(config.REDIS_URL),
		nodes: await createNodeRunner(config.REDIS_URL),
	};
}

export async function closeDeps(deps: Deps) {
	deps.nodes.close();
	closeRedis(deps.config.REDIS_URL);
	await closeRunQueues();
	deps.bus.close();
	await deps.db.$client.end();
}

/** The HTTP app plus the agent gateway and its RPC executor, listening on `config.PORT` (0 picks a free port). */
export async function startServer(config: Config) {
	const deps = await createDeps(config);
	const app = createApp(deps);
	const agents = mountAgentGateway(app, {
		bus: deps.bus,
		redis: redisFor(config.REDIS_URL),
		authenticate: nodeTokenAuth(deps.db, config.LOGISTACK_AGENT_TOKEN),
	});
	const rpc = await serveAgentRpc(agents, config.REDIS_URL);
	const server = Bun.serve({ port: config.PORT, fetch: app.fetch, websocket });
	return {
		server,
		deps,
		agents,
		async stop() {
			await server.stop(true);
			rpc.close();
			await closeDeps(deps);
		},
	};
}

if (import.meta.main) {
	const config = loadConfig();
	setLogLevel(config.LOG_LEVEL);
	await runMigrations(config.DATABASE_URL);
	const running = await startServer(config);
	log("info", "listening", { url: running.server.url.href });
	const stop = async () => {
		await running.stop();
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
