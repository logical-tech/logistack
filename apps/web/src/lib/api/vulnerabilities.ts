import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";
import { serviceKey } from "./service-ops";
import type { ServiceId } from "./types";

const v = client.api.services[":id"].vulnerabilities;

export type VulnerabilitiesView = InferResponseType<(typeof v)["$get"], 200>;
export type Finding = VulnerabilitiesView["findings"][number];

export type VulnerabilitiesApi = {
	get(id: ServiceId): Promise<VulnerabilitiesView>;
	scan(id: ServiceId): Promise<VulnerabilitiesView>;
};

const http: VulnerabilitiesApi = {
	get: (id) => ok(v.$get({ param: { id } })),
	scan: (id) => ok(v.scan.$post({ param: { id } })),
};

export const vulnerabilitiesApi: VulnerabilitiesApi = isMock
	? (await import("./mock/vulnerabilities")).mockVulnerabilities
	: http;

export const vulnerabilitiesQuery = (id: ServiceId) =>
	queryOptions({
		queryKey: [...serviceKey(id), "vulnerabilities"],
		queryFn: () => vulnerabilitiesApi.get(id),
		// Follow a scan while it runs; otherwise results change at most daily.
		refetchInterval: (q) =>
			q.state.data?.status === "running" ? 3_000 : 5 * 60_000,
	});

export function useRescan(id: ServiceId) {
	const qc = useQueryClient();
	const key = vulnerabilitiesQuery(id).queryKey;
	return useMutation({
		mutationFn: () => vulnerabilitiesApi.scan(id),
		onSuccess: (before) => {
			// The worker picks it up within seconds; show it as running until the next poll says otherwise.
			qc.setQueryData(key, { ...before, status: "running" as const });
		},
	});
}
