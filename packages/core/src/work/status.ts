import type { WorkFieldConfig, WorkStatusCategory } from "@logistack/contracts";
import { parseFieldValue } from "./fields.ts";

type StatusLike = { id: string; category: WorkStatusCategory };

/** `completedAt` after a status change: set entering `done`, kept within `done`, cleared leaving it. */
export function applyStatusChange(
	task: { completedAt: Date | null },
	from: { category: WorkStatusCategory },
	to: { category: WorkStatusCategory },
	now: Date,
): { completedAt: Date | null } {
	if (to.category !== "done") return { completedAt: null };
	if (from.category === "done") return { completedAt: task.completedAt ?? now };
	return { completedAt: now };
}

/** At least one `backlog` and one `done` status must remain. */
export function canDeleteStatus(
	statuses: readonly StatusLike[],
	id: string,
): { ok: true } | { ok: false; reason: string } {
	const target = statuses.find((s) => s.id === id);
	if (!target) return { ok: false, reason: "status not found" };
	if (target.category === "backlog" || target.category === "done") {
		const left = statuses.filter(
			(s) => s.id !== id && s.category === target.category,
		);
		if (left.length === 0)
			return {
				ok: false,
				reason: `the project needs at least one ${target.category} status`,
			};
	}
	return { ok: true };
}

type FieldLike = {
	id: string;
	name: string;
	listId: string | null;
	required: boolean;
	config: WorkFieldConfig;
};

/**
 * Required fields still empty. Checked on create (`toStatus` null) and when moving into `done`;
 * other moves return nothing. Fields scoped to another list don't apply.
 */
export function requiredFieldsMissing(
	task: { listId: string; fields: Readonly<Record<string, unknown>> },
	fields: readonly FieldLike[],
	toStatus: { category: WorkStatusCategory } | null,
): FieldLike[] {
	if (toStatus && toStatus.category !== "done") return [];
	return fields.filter((f) => {
		if (!f.required || (f.listId !== null && f.listId !== task.listId))
			return false;
		const p = parseFieldValue(f, task.fields[f.id]);
		return !p.ok || p.value === null;
	});
}
