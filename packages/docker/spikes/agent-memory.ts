// Spike: agent-shaped workload for RSS measurement. Compile with
//   bun build --compile packages/docker/spikes/agent-memory.ts --outfile <scratch>/agent-memory
// then sample RSS from outside with `ps -o rss= -p <pid>`.
import { createDockerClient } from "../src/index.ts";

const docker = createDockerClient();
const INTERVAL_MS = Number(process.env.STATS_INTERVAL_MS ?? 10_000);
let events = 0;
let polls = 0;
let samples = 0;

(async () => {
	for await (const _ of docker.events()) events++;
})().catch((e) => {
	console.error("events stream failed", e);
	process.exit(1);
});

async function poll() {
	const containers = await docker.containers.list();
	const stats = await Promise.all(
		containers.map((c) => docker.containers.stats(c.Id).catch(() => null)),
	);
	samples += stats.filter(Boolean).length;
	polls++;
	const m = process.memoryUsage();
	console.log(
		JSON.stringify({
			t: new Date().toISOString(),
			polls,
			containers: containers.length,
			samples,
			events,
			rssMB: +(m.rss / 1048576).toFixed(1),
			heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
		}),
	);
}

await poll();
setInterval(() => {
	poll().catch((e) => console.error("poll failed", e));
}, INTERVAL_MS);
