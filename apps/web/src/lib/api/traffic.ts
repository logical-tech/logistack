import type {
	MetricRange,
	TrafficOverview,
	TrafficReport,
} from "@logistack/contracts";
import {
	keepPreviousData,
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";
import type { ServiceId } from "./types";

export type TrafficApi = {
	report(
		id: ServiceId,
		range: MetricRange,
		domainId?: string,
	): Promise<TrafficReport>;
	overview(range: MetricRange): Promise<TrafficOverview>;
	setWebAnalytics(
		domainId: string,
		enabled: boolean,
	): Promise<{ id: string; webAnalytics: boolean }>;
};

const http: TrafficApi = {
	report: (id, range, domainId) =>
		ok(
			client.api.services[":id"].traffic.$get({
				param: { id },
				query: { range, ...(domainId ? { domainId } : {}) },
			}),
		),
	overview: (range) => ok(client.api.traffic.$get({ query: { range } })),
	setWebAnalytics: (id, enabled) =>
		ok(
			client.api.domains[":id"]["web-analytics"].$put({
				param: { id },
				json: { enabled },
			}),
		),
};

export const trafficApi: TrafficApi = isMock
	? (await import("./mock/traffic")).mockTraffic
	: http;

/** Minutes close on the agent within ~70 s; polling faster shows nothing new. */
const POLL = 30_000;

export const trafficQuery = (
	id: ServiceId,
	range: MetricRange,
	domainId?: string,
) =>
	queryOptions({
		queryKey: ["traffic", "services", id, range, domainId ?? null],
		queryFn: () => trafficApi.report(id, range, domainId),
		refetchInterval: POLL,
		placeholderData: keepPreviousData,
	});

export const trafficOverviewQuery = (range: MetricRange) =>
	queryOptions({
		queryKey: ["traffic", "overview", range],
		queryFn: () => trafficApi.overview(range),
		refetchInterval: POLL,
		placeholderData: keepPreviousData,
	});

export function useSetWebAnalytics() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { domainId: string; enabled: boolean }) =>
			trafficApi.setWebAnalytics(v.domainId, v.enabled),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["traffic"] }),
	});
}
