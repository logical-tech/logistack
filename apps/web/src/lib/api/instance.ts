import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { api } from ".";
import type { SetupInput } from "./types";

export const instanceStatusQuery = queryOptions({
	queryKey: ["instance", "status"],
	queryFn: () => api.instance.status(),
	staleTime: 60_000,
});

export const versionQuery = queryOptions({
	queryKey: ["instance", "version"],
	queryFn: () => api.instance.version(),
	staleTime: Number.POSITIVE_INFINITY,
});

export function useCompleteSetup() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { input: SetupInput; setupToken: string }) =>
			api.instance.completeSetup(v.input, v.setupToken),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["instance"] }),
	});
}

export const checkDns = (
	hostname: string,
	setupToken: string,
	expected?: string,
) => api.instance.checkDns(hostname, setupToken, expected);
