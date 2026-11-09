import type { WorkStatusCategory } from "@logistack/contracts";
import { createNextOccurrence } from "@logistack/worker/work-recurrence";

type Tx = Parameters<typeof createNextOccurrence>[0];

/**
 * The `on_complete` recurrence hook (12.2). Call it inside the transaction that changes a task's
 * status (PATCH, move, bulk), after the status update. When the task enters a `done` status and
 * carries an `on_complete` rule, inserts the next occurrence (dates shifted from the previous
 * *scheduled* dates) and moves the rule onto it. Returns the new task id (publish it after commit),
 * or null. Safe under concurrent completions: the first one moves the rule, later ones find none.
 */
export async function applyRecurrenceOnComplete(
	tx: Tx,
	task: {
		id: string;
		recurrence: { mode: "on_complete" | "on_schedule" } | null;
	},
	prevStatus: { category: WorkStatusCategory },
	nextStatus: { category: WorkStatusCategory },
	actorId: string | null = null,
): Promise<string | null> {
	if (task.recurrence?.mode !== "on_complete") return null;
	if (prevStatus.category === "done" || nextStatus.category !== "done")
		return null;
	return createNextOccurrence(tx, task.id, actorId);
}
