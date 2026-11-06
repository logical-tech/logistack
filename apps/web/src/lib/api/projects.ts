import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { api } from ".";
import type {
	CreateEnvironmentInput,
	EnvironmentId,
	ProjectId,
	UpdateEnvironmentInput,
} from "./types";

export const archivedProjectsQuery = queryOptions({
	queryKey: ["projects", "archived"],
	queryFn: () => api.projects.list({ archived: true }),
});

/** Archiving changes services, lists and the overview: refresh them all. */
export function useSetArchived(projectId: ProjectId) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (archived: boolean) =>
			api.projects.setArchived(projectId, archived),
		onSuccess: () =>
			Promise.all(
				[["projects"], ["services"], ["overview"]].map((queryKey) =>
					qc.invalidateQueries({ queryKey }),
				),
			),
	});
}

export function useUpdateEnvironment() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			...input
		}: UpdateEnvironmentInput & { id: EnvironmentId }) =>
			api.projects.updateEnvironment(id, input),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
	});
}

export const projectsQuery = queryOptions({
	queryKey: ["projects"],
	queryFn: () => api.projects.list(),
});

export const projectQuery = (id: ProjectId) =>
	queryOptions({
		queryKey: ["projects", id],
		queryFn: () => api.projects.get(id),
	});

export const useProjects = () => useQuery(projectsQuery);
export const useProject = (id: ProjectId) => useQuery(projectQuery(id));

export function useCreateEnvironment(projectId: ProjectId) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: CreateEnvironmentInput) =>
			api.projects.createEnvironment(projectId, input),
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: projectQuery(projectId).queryKey }),
	});
}

export function useCreateProject() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.projects.create,
		onSuccess: () =>
			Promise.all([
				qc.invalidateQueries({ queryKey: projectsQuery.queryKey }),
				qc.invalidateQueries({ queryKey: ["overview"] }),
			]),
	});
}
