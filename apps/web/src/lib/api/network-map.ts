/* The network map: one org-wide graph from `/network-map`; `mock/network-map.ts` fills it for VITE_API_MOCK=1. */
import type { NetworkMap } from "@logistack/contracts";
import { queryOptions } from "@tanstack/react-query";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";

const get: () => Promise<NetworkMap> = isMock
	? (await import("./mock/network-map")).mockNetworkMap
	: () => ok(client.api["network-map"].$get()) as Promise<NetworkMap>;

export const networkMapQuery = queryOptions({
	queryKey: ["network-map"],
	queryFn: get,
	// Refreshed by org events on /ws (`useOrgEventRefresh`), not polled.
});
