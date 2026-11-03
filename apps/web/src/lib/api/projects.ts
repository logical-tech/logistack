import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { api } from ".";
import type { ProjectId } from "./types";

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
