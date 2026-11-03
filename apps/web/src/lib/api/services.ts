import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { api } from ".";
import type { EnvironmentId, GitSource, ImageSource } from "./types";

export const servicesQuery = (environmentId: EnvironmentId) =>
	queryOptions({
		queryKey: ["services", { environmentId }],
		queryFn: () => api.services.listByEnvironment(environmentId),
		refetchInterval: 10_000,
	});

export const useServices = (environmentId: EnvironmentId) =>
	useQuery(servicesQuery(environmentId));

export function useCreateService() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.services.create,
		onSuccess: () =>
			Promise.all(
				[["services"], ["projects"], ["overview"]].map((queryKey) =>
					qc.invalidateQueries({ queryKey }),
				),
			),
	});
}

export const checkSource = (source: GitSource | ImageSource) =>
	api.services.checkSource(source);
