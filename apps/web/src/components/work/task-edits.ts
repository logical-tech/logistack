/*
 * Every per-field edit a table cell, the bulk bar or the task sheet makes, optimistic and rolled
 * back with a toast on error. PATCH-able fields go through `usePatchWorkTask` (which also carries
 * the concurrency token when the caller passes one); assignees, tags and custom fields have their
 * own routes, so their optimistic copy is written here.
 */
import type {
	WorkTaskListItem,
	WorkTaskMove,
	WorkTaskPatch,
} from "@logistack/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
	patchCachedTask,
	useMoveWorkTask,
	usePatchWorkTask,
	workKeys,
} from "@/lib/api/work-queries";

const failed = (what: string) => (e: unknown) =>
	toast.error(`${what} wasn't saved`, {
		description: e instanceof Error ? e.message : undefined,
	});

export function useTaskEdits() {
	const qc = useQueryClient();
	const patch = usePatchWorkTask();
	const move = useMoveWorkTask();

	const settle = (id: string) =>
		Promise.all(
			[
				workKeys.task(id),
				workKeys.tasks(),
				workKeys.me(),
				workKeys.taskPart(id, "activity"),
			].map((queryKey) => qc.invalidateQueries({ queryKey })),
		);

	async function optimistic(
		id: string,
		edit: <T extends WorkTaskListItem>(t: T) => T,
		run: () => Promise<unknown>,
		what: string,
	) {
		const rollback = patchCachedTask(qc, id, edit);
		try {
			await run();
		} catch (e) {
			rollback();
			failed(what)(e);
		} finally {
			void settle(id);
		}
	}

	return {
		patch: (task: Pick<WorkTaskListItem, "id" | "key">, p: WorkTaskPatch) =>
			patch
				.mutateAsync({ id: task.id, patch: p })
				.catch((e) => failed(task.key)(e)),

		/** List, status, parent or position (drag or ⌘↑/⌘↓). */
		move: (task: Pick<WorkTaskListItem, "id" | "key">, m: WorkTaskMove) =>
			move
				.mutateAsync({ id: task.id, move: m })
				.catch((e) => failed(task.key)(e)),

		setAssignees: (task: WorkTaskListItem, ids: string[]) => {
			const before = task.assigneeIds ?? [];
			const add = ids.filter((u) => !before.includes(u));
			const remove = before.filter((u) => !ids.includes(u));
			return optimistic(
				task.id,
				(t) => ({ ...t, assigneeIds: ids }),
				() =>
					Promise.all([
						...add.map((u) => api.work.tasks.addAssignee(task.id, u)),
						...remove.map((u) => api.work.tasks.removeAssignee(task.id, u)),
					]),
				`Assignees of ${task.key}`,
			);
		},

		setTags: (task: WorkTaskListItem, ids: string[]) => {
			const before = task.tagIds ?? [];
			const add = ids.filter((u) => !before.includes(u));
			const remove = before.filter((u) => !ids.includes(u));
			return optimistic(
				task.id,
				(t) => ({ ...t, tagIds: ids }),
				() =>
					Promise.all([
						...add.map((t) => api.work.tasks.addTag(task.id, t)),
						...remove.map((t) => api.work.tasks.removeTag(task.id, t)),
					]),
				`Tags of ${task.key}`,
			);
		},

		setField: (task: WorkTaskListItem, fieldId: string, value: unknown) =>
			optimistic(
				task.id,
				(t) => {
					const fields = { ...(t.fields ?? {}) };
					if (value === null || value === undefined) delete fields[fieldId];
					else fields[fieldId] = value;
					return { ...t, fields };
				},
				() =>
					value === null || value === undefined
						? api.work.tasks.clearField(task.id, fieldId)
						: api.work.tasks.setField(task.id, fieldId, value),
				`A field of ${task.key}`,
			),
	};
}
