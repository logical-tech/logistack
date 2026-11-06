/**
 * The one-shot updater task: `bun apps/worker/src/update-runner.ts <updateId>`, started by the
 * worker as a Swarm job (instance-update.ts). It drains the job queues, migrates, replaces the
 * stack's images in order, and writes every step to the run's row and to `instance-update:<id>`
 * on /ws. It runs the code of the release being left, so a change here takes effect one update later.
 */
import {
	LIVE_CHANNEL,
	type LiveMessage,
	type UpdateState,
	type UpdateSteps,
	updateChannel,
} from "@logistack/contracts";
import { createDb, instanceSettings, instanceUpdate } from "@logistack/db";
import { createDockerClient } from "@logistack/docker";
import { eq, sql } from "drizzle-orm";
import { createBus, log } from "./bus.ts";
import { loadConfig } from "./config.ts";
import { drain, resume } from "./drain.ts";
import { migrate, notifyOutcome, stackTargets } from "./instance-update.ts";
import { createQueues, redisConnection } from "./queues.ts";
import { runUpdate, type UpdateReport } from "./update.ts";

const id = process.argv[2] ?? "";
const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL, { max: 1, onnotice: () => {} });
const bus = await createBus(cfg.REDIS_URL);
const docker = createDockerClient({ socketPath: cfg.DOCKER_SOCKET });
const queues = createQueues(redisConnection(cfg.REDIS_URL));

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
			await bus.redis.publish(LIVE_CHANNEL, JSON.stringify(m));
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
const result = await runUpdate(
	docker,
	targets,
	report,
	{
		local: cfg.LS_UPDATE_REGISTRY === "localhost",
		timeoutMs: cfg.LS_UPDATE_TIMEOUT_MS,
		pollMs: 2_000,
	},
	{
		drain: (r) =>
			drain(queues, r, {
				timeoutMs: cfg.LS_UPDATE_DRAIN_TIMEOUT_MS,
				pollMs: 5_000,
			}),
		resume: () => resume(queues),
		migrate: (image, r) => migrate({ cfg }, docker, id, image, r),
	},
).catch((e: unknown) => ({ ok: false as const, error: String(e) }));

await (result.ok
	? push({ state: "succeeded" }, "succeeded", `Updated to ${row.toVersion}`)
	: push({ state: "failed", error: result.error }, "failed", result.error));
const [settings] = await db
	.select({ url: instanceSettings.publicUrl })
	.from(instanceSettings);
await notifyOutcome(db, bus, row, result, settings?.url ?? null).catch((e) =>
	log("warn", "update outcome not notified", { error: String(e) }),
);
await Promise.all(Object.values(queues).map((q) => q.close()));
bus.close();
await db.$client.end();
process.exit(result.ok ? 0 : 1);
