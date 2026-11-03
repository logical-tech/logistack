import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from ".";

export const overviewQuery = queryOptions({
	queryKey: ["overview"],
	queryFn: () => api.overview.get(),
	// shortcut: polling until the /ws org events channel exists; then invalidate on events.
	refetchInterval: 15_000,
});

export const useOverview = () => useQuery(overviewQuery);
