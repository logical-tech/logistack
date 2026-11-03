import type { BackupRetention } from "@logistack/contracts";

const DAY_MS = 86_400_000;

/**
 * Objects to delete under `policy`. An object survives if any rule keeps it: it is among the
 * newest `count`, or younger than `days`. The newest object always survives, so a stretch of
 * failing backups never empties the destination. No rules set deletes nothing.
 */
export function selectForDeletion<T extends { lastModified: Date }>(
	objects: readonly T[],
	policy: BackupRetention,
	now: Date,
): T[] {
	if (policy.count === undefined && policy.days === undefined) return [];
	const newestFirst = [...objects].sort(
		(a, b) => b.lastModified.getTime() - a.lastModified.getTime(),
	);
	const keepCount = Math.max(policy.count ?? 0, 1);
	const cutoff =
		policy.days === undefined ? Infinity : now.getTime() - policy.days * DAY_MS;
	return newestFirst.filter(
		(o, i) => i >= keepCount && o.lastModified.getTime() < cutoff,
	);
}
