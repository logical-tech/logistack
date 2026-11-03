/**
 * The one-shot updater task: `bun apps/worker/src/update-runner.ts <updateId>`, started by the
 * worker as a Swarm job (instance-update.ts). It replaces the stack's images in order and writes
 * every step to the run's row and to `instance-update:<id>` on /ws.
 */
import {
	LIVE_CHANNEL,
	type LiveMessage,
	type UpdateState,
	type UpdateSteps,
	updateChannel,
} from "@logistack/contracts";
import { createDb, instanceUpdate } from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { RedisClient } from "bun";
import { eq, sql } from "drizzle-orm";
import { log } from "./bus.ts";
import { loadConfig } from "./config.ts";
import { stackTargets } from "./instance-update.ts";
import { runUpdate, type UpdateReport } from "./update.ts";

const id = process.argv[2] ?? "";
const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL, { max: 1, onnotice: () => {} });
const redis = new RedisClient(cfg.REDIS_URL);
const docker = createDockerClient({ socketPath: cfg.DOCKER_SOCKET });

const [row] = await db
	.select()
	.from(instanceUpdate)
	.where(eq(instanceUpdate.id, id));
if (row?.state !== "running") {
	log("warn", "nothing to run", { id, state: row?.state });
	process.exit(0);
}

const steps: UpdateSteps = { ...row.steps };
const channel = updateChannel(id);
// Writes go out in order even though the update does not wait for each one.
let tail = Promise.resolve();
const push = (set: Partial<typeof row>, state: UpdateState, line?: string) => {
	tail = tail
		.then(async () => {
			await db
				.update(instanceUpdate)
				.set({
					...set,
					steps,
					...(line
						? {
								log: sql`${instanceUpdate.log} || ${JSON.stringify([line])}::jsonb`,
							}
						: {}),
				})
				.where(eq(instanceUpdate.id, id));
			const m: LiveMessage = { kind: "update", channel, state, steps, line };
			await redis.publish(LIVE_CHANNEL, JSON.stringify(m));
		})
		.catch((e) =>
			log("warn", "update progress not written", { error: String(e) }),
		);
	return tail;
};

const report: UpdateReport = {
	step: (step, state) => {
		steps[step] = state;
		return push({}, "running");
	},
	line: (text) => {
		log("info", text, { id });
		return push({}, "running", text);
	},
};

const targets = stackTargets(cfg, row.toVersion);
const result = await runUpdate(docker, targets, report, {
	local: cfg.LS_UPDATE_REGISTRY === "localhost",
	timeoutMs: cfg.LS_UPDATE_TIMEOUT_MS,
	pollMs: 2_000,
}).catch((e: unknown) => ({ ok: false as const, error: String(e) }));

await (result.ok
	? push({ state: "succeeded" }, "succeeded", `Updated to ${row.toVersion}`)
	: push({ state: "failed", error: result.error }, "failed", result.error));
await db.$client.end();
redis.close();
process.exit(result.ok ? 0 : 1);
