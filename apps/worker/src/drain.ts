import type { Queues } from "./queues.ts";
import type { UpdateReport, UpdateResult } from "./update.ts";

/**
 * The queues an update drains: their jobs run on the worker it replaces. Pausing a BullMQ queue
 * is global and kept in Redis, so no worker takes a new job while running ones carry on.
 */
const DRAINED = [
	{ queue: "deploy", one: "deployment", many: "deployments" },
	{ queue: "backup", one: "backup", many: "backups" },
	{ queue: "migration", one: "migration step", many: "migration steps" },
] as const;

export type DrainQueues = Pick<Queues, (typeof DRAINED)[number]["queue"]>;

/** "Waiting for 2 deployments and 1 backup", in DRAINED order; null when nothing runs. */
export function waitingFor(active: readonly number[]): string | null {
	const parts = DRAINED.flatMap((d, i) => {
		const n = active[i] ?? 0;
		return n ? [`${n} ${n === 1 ? d.one : d.many}`] : [];
	});
	if (!parts.length) return null;
	const last = parts.pop();
	return `Waiting for ${parts.length ? `${parts.join(", ")} and ${last}` : last}`;
}

export type DrainOptions = {
	timeoutMs: number;
	pollMs: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

/**
 * Pauses the drained queues, then waits until none has an active job. Jobs queued meanwhile wait
 * for `resume`. Gives up after `timeoutMs`, leaving the queues paused for the caller to resume.
 */
export async function drain(
	queues: DrainQueues,
	report: UpdateReport,
	o: DrainOptions,
): Promise<UpdateResult> {
	const now = o.now ?? Date.now;
	const sleep = o.sleep ?? Bun.sleep;
	for (const d of DRAINED) await queues[d.queue].pause();
	await report.line("Paused new deployments, backups and migration steps");
	const deadline = now() + o.timeoutMs;
	let shown: string | null = null;
	for (;;) {
		const waiting = waitingFor(
			await Promise.all(DRAINED.map((d) => queues[d.queue].getActiveCount())),
		);
		if (!waiting) {
			await report.line("Nothing is running");
			return { ok: true };
		}
		if (now() >= deadline)
			return {
				ok: false,
				error: `Gave up after ${Math.round(o.timeoutMs / 60_000)} min: ${waiting.charAt(0).toLowerCase()}${waiting.slice(1)}. No service was changed.`,
			};
		// The same line again only refreshes the run, so a long build never reads as a dead updater.
		if (waiting !== shown) await report.line(waiting);
		else await report.step("drain", "running");
		shown = waiting;
		await sleep(o.pollMs);
	}
}

/** Lets the drained queues take jobs again. Idempotent. */
export async function resume(queues: DrainQueues): Promise<void> {
	for (const d of DRAINED) await queues[d.queue].resume();
}
