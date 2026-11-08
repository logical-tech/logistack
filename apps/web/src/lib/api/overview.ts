import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from ".";

export const overviewQuery = queryOptions({
	queryKey: ["overview"],
	queryFn: () => api.overview.get(),
	// Refreshed by org events on /ws (`useOrgEventRefresh`), not polled.
});

export const useOverview = () => useQuery(overviewQuery);
