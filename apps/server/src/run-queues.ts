import { openRunQueues, type RunQueues } from "@logistack/worker/schedulers";

const byUrl = new Map<string, RunQueues>();

// shortcut: one lazily opened set of queues per Redis URL instead of a Deps field (as live.ts does); fold into Deps when Deps next changes.
export function runQueues(redisUrl: string): RunQueues {
	let q = byUrl.get(redisUrl);
	if (!q) {
		q = openRunQueues(redisUrl);
		byUrl.set(redisUrl, q);
	}
	return q;
}

export async function closeRunQueues() {
	const all = [...byUrl.values()];
	byUrl.clear();
	await Promise.all(
		all.flatMap((q) => [
			q.backup.close(),
			q.schedule.close(),
			q.maintenance.close(),
			q.migration.close(),
			q.scan.close(),
		]),
	);
}
