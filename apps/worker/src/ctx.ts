import type { Db } from "@logistack/db";
import type { DockerClient } from "@logistack/docker";
import type { Bus } from "./bus.ts";
import type { Config } from "./config.ts";
import type { NodeRunner } from "./node-runner.ts";
import type { Queues } from "./queues.ts";

/** Everything a job needs; built once at boot (or per test). */
export type Ctx = {
	cfg: Config;
	db: Db;
	docker: DockerClient;
	bus: Bus;
	masterKey: CryptoKey;
	/** Wraps per-organization data keys of managed secrets (HKDF of the master key). */
	secretsKek: CryptoKey;
	queues: Queues;
	/** Jobs, execs and log follows on a node, through its agent. */
	nodes: NodeRunner;
};

export const scope = (ctx: Pick<Ctx, "cfg">) => ({
	namePrefix: ctx.cfg.LS_NAME_PREFIX,
	labels: ctx.cfg.LS_SCOPE_LABELS,
});
