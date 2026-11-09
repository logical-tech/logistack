import type {
	PmDoc,
	TaskTemplate,
	TemplateAssigneeRef,
	TemplatePayload,
	WorkPriority,
	WorkTaskSource,
} from "@logistack/contracts";
import { addWorkingDays, DEFAULT_WORKING_DAYS } from "./dates.ts";

/** A task ready to insert. `ref` is local to one instantiation ("0", "0.2", "L1:3"). */
export type TaskDraft = {
	ref: string;
	parentRef: string | null;
	/** Index into `payload.lists` (null: the target list). */
	listIndex: number | null;
	title: string;
	description: PmDoc | null;
	priority: WorkPriority;
	startDate: string | null;
	dueDate: string | null;
	isMilestone: boolean;
	estimateMinutes: number | null;
	statusRef: string | null;
	tagRefs: string[];
	/** Target field id → raw value (parse with `parseFieldValue`). */
	fields: Record<string, unknown>;
	assigneeIds: string[];
	checklist: { text: string; assigneeId: string | null }[];
	/** Refs of drafts this one is blocked by. */
	dependsOn: string[];
	attachmentShas: string[];
	source: WorkTaskSource | null;
};

export type TemplateAnchor = {
	/** `start`: the earliest offset lands on `date`; `finish`: the latest lands on it (back-scheduling). */
	date: string;
	mode: "start" | "finish";
	creatorId: string;
	workingDays?: number;
};

const allTasks = (p: TemplatePayload): TaskTemplate[] => {
	const out: TaskTemplate[] = [];
	const walk = (ts: readonly TaskTemplate[]) => {
		for (const t of ts) {
			out.push(t);
			walk(t.subtasks);
		}
	};
	walk(p.tasks ?? []);
	for (const l of p.lists ?? []) walk(l.tasks);
	return out;
};

/**
 * Turn a template into task drafts: working-day offsets become dates from the anchor, field refs map
 * through `fieldMap` (missing ones are dropped with a warning), placeholders through `userMap`.
 */
export function instantiateTemplate(
	payload: TemplatePayload,
	anchor: TemplateAnchor,
	fieldMap: Readonly<Record<string, string>>,
	userMap: Readonly<Record<string, string>>,
): { tasks: TaskDraft[]; warnings: string[] } {
	const wd = anchor.workingDays ?? DEFAULT_WORKING_DAYS;
	const warnings = new Set<string>();
	const offsets = allTasks(payload).flatMap((t) =>
		[t.startOffset, t.dueOffset].filter((o): o is number => o !== undefined),
	);
	const base =
		anchor.mode === "finish" && offsets.length
			? addWorkingDays(anchor.date, -Math.max(...offsets), wd)
			: anchor.mode === "start" && offsets.length
				? addWorkingDays(anchor.date, -Math.min(0, ...offsets), wd)
				: anchor.date;
	const date = (o: number | undefined) =>
		o === undefined ? null : addWorkingDays(base, o, wd);
	const user = (r: TemplateAssigneeRef): string | null => {
		if (r === "creator") return anchor.creatorId;
		if ("userId" in r) return r.userId;
		const id = userMap[r.placeholder];
		if (!id) warnings.add(`Placeholder "${r.placeholder}" left unassigned`);
		return id ?? null;
	};
	const tasks: TaskDraft[] = [];
	const build = (
		ts: readonly TaskTemplate[],
		prefix: string,
		parentRef: string | null,
		listIndex: number | null,
	) => {
		ts.forEach((t, i) => {
			const ref = `${prefix}${i}`;
			const fields: Record<string, unknown> = {};
			for (const fv of t.fieldValues) {
				const id = fieldMap[fv.fieldRef];
				if (id) fields[id] = fv.value;
				else
					warnings.add(
						`Field "${fv.fieldRef}" isn't in the target project: values dropped`,
					);
			}
			const startDate = date(t.startOffset);
			const dueDate = date(t.dueOffset);
			tasks.push({
				ref,
				parentRef,
				listIndex,
				title: t.title,
				description: t.description,
				priority: t.priority,
				startDate: t.isMilestone ? (dueDate ?? startDate) : startDate,
				dueDate: t.isMilestone ? (dueDate ?? startDate) : dueDate,
				isMilestone: t.isMilestone,
				estimateMinutes: t.estimateMinutes,
				statusRef: t.statusRef,
				tagRefs: [...t.tagRefs],
				fields,
				assigneeIds: [
					...new Set(
						t.assigneeRefs.map(user).filter((u): u is string => u !== null),
					),
				],
				checklist: t.checklist.map((c) => ({
					text: c.text,
					assigneeId: c.assigneeRef ? user(c.assigneeRef) : null,
				})),
				dependsOn: t.dependsOn
					.filter((d) => d !== i && d < ts.length)
					.map((d) => `${prefix}${d}`),
				attachmentShas: [...t.attachmentShas],
				source: { kind: "template" },
			});
			build(t.subtasks, `${ref}.`, ref, listIndex);
		});
	};
	build(payload.tasks ?? [], "", null, null);
	(payload.lists ?? []).forEach((l, li) => {
		build(l.tasks, `L${li}:`, null, li);
	});
	return { tasks, warnings: [...warnings] };
}
