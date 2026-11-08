import type { WorkStatusCategory } from "@logistack/contracts";
import {
	addWorkingDays,
	DEFAULT_WORKING_DAYS,
	daysBetween,
	workingDaysBetween,
} from "./dates.ts";

/** `taskId` is blocked by `blockedById` (finish-to-start), starting `lagDays` working days after it. */
export type DepEdge = { taskId: string; blockedById: string; lagDays?: number };
export type DatedTask = {
	id: string;
	startDate: string | null;
	dueDate: string | null;
};

/**
 * Would adding "`from` blocked by `to`" close a loop? Returns the loop
 * (`from`, `to`, …, `from`) for the error message, or null.
 */
export function wouldCycle(
	edges: readonly DepEdge[],
	from: string,
	to: string,
): string[] | null {
	if (from === to) return [from, from];
	const blockers = new Map<string, string[]>();
	for (const e of edges)
		blockers.set(e.taskId, [...(blockers.get(e.taskId) ?? []), e.blockedById]);
	// Follow `to`'s blockers; reaching `from` means `to` already depends on `from`.
	const prev = new Map<string, string>();
	const queue = [to];
	const seen = new Set([to]);
	while (queue.length) {
		const id = queue.shift() as string;
		for (const b of blockers.get(id) ?? []) {
			if (seen.has(b)) continue;
			seen.add(b);
			prev.set(b, id);
			if (b === from) {
				const path = [from];
				let cur = from;
				while (cur !== to) {
					cur = prev.get(cur) as string;
					path.push(cur);
				}
				return [from, ...path.reverse()];
			}
			queue.push(b);
		}
	}
	return null;
}

/** Task ids with every blocker before what it blocks. Throws on a cycle. */
export function topoOrder(edges: readonly DepEdge[]): string[] {
	const ids = new Set<string>();
	const indegree = new Map<string, number>();
	const out = new Map<string, string[]>();
	for (const e of edges) {
		ids.add(e.taskId).add(e.blockedById);
		indegree.set(e.taskId, (indegree.get(e.taskId) ?? 0) + 1);
		out.set(e.blockedById, [...(out.get(e.blockedById) ?? []), e.taskId]);
	}
	const queue = [...ids].filter((id) => !indegree.get(id));
	const order: string[] = [];
	while (queue.length) {
		const id = queue.shift() as string;
		order.push(id);
		for (const t of out.get(id) ?? []) {
			const d = (indegree.get(t) ?? 0) - 1;
			indegree.set(t, d);
			if (d === 0) queue.push(t);
		}
	}
	if (order.length !== ids.size) throw new Error("dependency cycle");
	return order;
}

/**
 * Shift `movedId` by `deltaDays` working days, then push dependants whose start would come
 * before their blocker's due date plus lag. Dependants are never moved earlier.
 * Returns only tasks whose dates change, the moved one first.
 */
export function shiftDependants(
	tasks: readonly DatedTask[],
	edges: readonly DepEdge[],
	movedId: string,
	deltaDays: number,
	workingDays = DEFAULT_WORKING_DAYS,
): DatedTask[] {
	const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
	const moved = byId.get(movedId);
	if (!moved) return [];
	const shift = (d: string | null, n: number) =>
		d === null ? null : addWorkingDays(d, n, workingDays);
	moved.startDate = shift(moved.startDate, deltaDays);
	moved.dueDate = shift(moved.dueDate, deltaDays);
	const changed = new Set(deltaDays ? [movedId] : []);
	for (const id of topoOrder(edges)) {
		const t = byId.get(id);
		if (!t || id === movedId) continue;
		const anchor = t.startDate ?? t.dueDate;
		if (!anchor) continue;
		let earliest: string | null = null;
		for (const e of edges) {
			if (e.taskId !== id) continue;
			const b = byId.get(e.blockedById);
			const end = b?.dueDate ?? b?.startDate;
			if (!end) continue;
			const req = addWorkingDays(end, 1 + (e.lagDays ?? 0), workingDays);
			if (!earliest || req > earliest) earliest = req;
		}
		if (!earliest || anchor >= earliest) continue;
		const n = workingDaysBetween(anchor, earliest, workingDays);
		const startDate = t.startDate ? earliest : null;
		const dueDate =
			t.dueDate && t.startDate
				? addWorkingDays(
						earliest,
						workingDaysBetween(t.startDate, t.dueDate, workingDays),
						workingDays,
					)
				: shift(t.dueDate, n);
		t.startDate = startDate;
		t.dueDate = dueDate;
		changed.add(id);
	}
	return [...changed].map((id) => byId.get(id) as DatedTask);
}

/** Open blockers of `taskId` (blockers not done or cancelled). */
export function blockedState(
	taskId: string,
	edges: readonly DepEdge[],
	statusOf: Readonly<Record<string, WorkStatusCategory>>,
): { blocked: boolean; blockers: string[] } {
	const blockers = edges
		.filter((e) => e.taskId === taskId)
		.map((e) => e.blockedById)
		.filter((b) => {
			const c = statusOf[b];
			return c !== "done" && c !== "cancelled";
		});
	return { blocked: blockers.length > 0, blockers };
}

/** Dependencies whose dependant starts before its blocker allows (red arrows on the timeline). */
export function violatedEdges(
	tasks: readonly DatedTask[],
	edges: readonly DepEdge[],
	workingDays = DEFAULT_WORKING_DAYS,
): DepEdge[] {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	return edges.filter((e) => {
		const t = byId.get(e.taskId);
		const b = byId.get(e.blockedById);
		const start = t?.startDate ?? t?.dueDate;
		const end = b?.dueDate ?? b?.startDate;
		if (!start || !end) return false;
		return (
			daysBetween(
				addWorkingDays(end, 1 + (e.lagDays ?? 0), workingDays),
				start,
			) < 0
		);
	});
}
