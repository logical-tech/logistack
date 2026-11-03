import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { api } from ".";

export const foldersQuery = queryOptions({
	queryKey: ["folders"],
	queryFn: () => api.folders.list(),
});

export const useFolders = () => useQuery(foldersQuery);

export function useCreateFolder() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.folders.create,
		onSuccess: () => qc.invalidateQueries({ queryKey: foldersQuery.queryKey }),
	});
}
