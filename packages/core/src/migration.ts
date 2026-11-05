import type { MigrationItemStatus } from "@logistack/contracts";

/**
 * One item of a migration: `planned → imported → cut_over`. A failed import can be retried; a
 * failed cutover rolls back to the source and can be tried again. Skipping is the user's call and
 * can be undone until the item is cut over.
 */
export type MigrationItemEvent =
	| { type: "imported" }
	| { type: "import_failed" }
	| { type: "cut_over" }
	| { type: "rolled_back" }
	| { type: "skip" }
	| { type: "unskip" };

const transitions: Record<
	MigrationItemStatus,
	Partial<Record<MigrationItemEvent["type"], MigrationItemStatus>>
> = {
	planned: { imported: "imported", import_failed: "failed", skip: "skipped" },
	failed: { imported: "imported", import_failed: "failed", skip: "skipped" },
	imported: {
		cut_over: "cut_over",
		rolled_back: "rolled_back",
		skip: "skipped",
	},
	rolled_back: {
		cut_over: "cut_over",
		rolled_back: "rolled_back",
		skip: "skipped",
	},
	cut_over: { rolled_back: "rolled_back" },
	skipped: { unskip: "planned" },
};

export function migrationItemTransition(
	from: MigrationItemStatus,
	event: MigrationItemEvent,
):
	| { ok: true; state: MigrationItemStatus }
	| {
			ok: false;
			error: {
				code: "illegal_transition";
				from: MigrationItemStatus;
				event: MigrationItemEvent["type"];
			};
	  } {
	const state = transitions[from][event.type];
	return state
		? { ok: true, state }
		: {
				ok: false,
				error: { code: "illegal_transition", from, event: event.type },
			};
}

/** Statuses the import still has to work on. */
export const importable = (s: MigrationItemStatus) =>
	s === "planned" || s === "failed";

/** Why a decommission must not run yet, or undefined when it may. */
export function decommissionBlocker(
	items: { status: string }[],
	proxySwitched: boolean,
): string | undefined {
	const open = items.filter(
		(i) => i.status !== "cut_over" && i.status !== "skipped",
	).length;
	if (open)
		return `${open} item(s) are neither on LogiStack nor left on Dokploy`;
	if (!proxySwitched) return "traffic still goes through Dokploy's Traefik";
	return undefined;
}
