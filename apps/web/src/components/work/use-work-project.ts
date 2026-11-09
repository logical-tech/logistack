import type { WorkTask } from "@logistack/contracts";
import { useMemo } from "react";
import { useMe } from "@/lib/api/access";
import {
	useCreateWorkTask,
	useWorkFields,
	useWorkLists,
	useWorkPeople,
	useWorkProject,
	useWorkStatuses,
	useWorkTags,
} from "@/lib/api/work-queries";
import type { NewTaskInput, WorkProjectContext } from "./views/types";

const ADMIN = new Set(["owner", "admin", "manager"]);
const EDIT = new Set([...ADMIN, "developer"]);

/**
 * What the actor may do in Work, from its role names. shortcut: custom roles count as `work`
 * (the server still refuses what they lack); swap for per-project actions if `/api/me` grows them.
 */
export function useWorkAbility() {
	const { data: me } = useMe();
	return useMemo(() => {
		const roles = (me?.grants ?? []).map((g) =>
			typeof g.role === "string" ? g.role : "custom",
		);
		const builtin = (r: string) =>
			ADMIN.has(r) || EDIT.has(r) || r === "viewer" || r === "guest";
		return {
			canAdmin: roles.some((r) => ADMIN.has(r)),
			canEdit: roles.some((r) => EDIT.has(r) || !builtin(r)),
			isGuest: roles.length > 0 && roles.every((r) => r === "guest"),
		};
	}, [me]);
}

/** Loads a project's Work structure; `data` is undefined until every part is there. */
export function useWorkProjectContext(projectId: string): {
	data: WorkProjectContext | undefined;
	error: unknown;
} {
	const project = useWorkProject(projectId);
	const statuses = useWorkStatuses(projectId);
	const lists = useWorkLists(projectId);
	const fields = useWorkFields(projectId);
	const tags = useWorkTags(projectId);
	const people = useWorkPeople(projectId);
	const ability = useWorkAbility();
	const error =
		project.error ??
		statuses.error ??
		lists.error ??
		fields.error ??
		tags.error ??
		people.error;
	const data = useMemo(() => {
		if (
			!project.data ||
			!statuses.data ||
			!lists.data ||
			!fields.data ||
			!tags.data ||
			!people.data
		)
			return undefined;
		return {
			id: projectId,
			key: project.data.key,
			name: project.data.name,
			settings: project.data,
			statuses: statuses.data,
			lists: lists.data.filter((l) => !l.archivedAt),
			fields: fields.data,
			tags: tags.data,
			people: people.data,
			canEdit: ability.canEdit && !project.data.archived,
			canAdmin: ability.canAdmin && !project.data.archived,
		};
	}, [
		projectId,
		project.data,
		statuses.data,
		lists.data,
		fields.data,
		tags.data,
		people.data,
		ability,
	]);
	return { data, error };
}

/** Quick add with the list defaulted: `listId`, else the given fallback, else the project's default list. */
export function useQuickCreate(
	project: WorkProjectContext | undefined,
	fallbackListId?: string | null,
) {
	const create = useCreateWorkTask();
	return (input: NewTaskInput): Promise<WorkTask> => {
		const listId =
			input.listId ??
			fallbackListId ??
			project?.settings.defaultListId ??
			project?.lists[0]?.id;
		if (!listId) return Promise.reject(new Error("This project has no list"));
		return create.mutateAsync({ ...input, listId });
	};
}
