import type { AutoscaleFixId, AutoscaleInput } from "@logistack/contracts";
import {
	keepPreviousData,
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

const a = client.api.services[":id"].autoscale;

export type AutoscaleView = InferResponseType<(typeof a)["$get"], 200>;
export type AutoscalePreview = InferResponseType<
	(typeof a.preview)["$get"],
	200
>;
export type AutoscaleFixResult = InferResponseType<
	(typeof a.fixes)[":fixId"]["$post"],
	200
>;
export type AutoscaleFixProbe = InferResponseType<
	(typeof a.fixes.add_healthcheck.probe)["$post"],
	200
>;
export type PreviewQuery = Pick<
	AutoscaleInput,
	"minReplicas" | "maxReplicas" | "behavior" | "targetCpu"
>;

export type AutoscaleApi = {
	get(id: ServiceId): Promise<AutoscaleView>;
	save(id: ServiceId, input: AutoscaleInput): Promise<AutoscaleView>;
	preview(id: ServiceId, q: PreviewQuery): Promise<AutoscalePreview>;
	fix(id: ServiceId, fixId: AutoscaleFixId): Promise<AutoscaleFixResult>;
	probeHealthcheck(id: ServiceId): Promise<AutoscaleFixProbe>;
};

const http: AutoscaleApi = {
	get: (id) => ok(a.$get({ param: { id } })),
	save: (id, json) => ok(a.$put({ param: { id }, json })),
	fix: (id, fixId) => ok(a.fixes[":fixId"].$post({ param: { id, fixId } })),
	probeHealthcheck: (id) =>
		ok(a.fixes.add_healthcheck.probe.$post({ param: { id } })),
	preview: (id, q) =>
		ok(
			a.preview.$get({
				param: { id },
				query: {
					minReplicas: String(q.minReplicas),
					maxReplicas: String(q.maxReplicas),
					behavior: q.behavior,
					...(q.targetCpu !== undefined && { targetCpu: String(q.targetCpu) }),
				},
			}),
		),
};

export const autoscaleApi: AutoscaleApi = isMock
	? (await import("./mock/autoscale")).mockAutoscale
	: http;

export const autoscaleQuery = (id: ServiceId) =>
	queryOptions({
		queryKey: [...serviceKey(id), "autoscale"],
		queryFn: () => autoscaleApi.get(id),
		// The autoscaler changes the count on its own; keep the card current.
		refetchInterval: 30_000,
	});

export const autoscalePreviewQuery = (id: ServiceId, q: PreviewQuery) =>
	queryOptions({
		queryKey: [...serviceKey(id), "autoscale", "preview", q],
		queryFn: () => autoscaleApi.preview(id, q),
		placeholderData: keepPreviousData,
		staleTime: 60_000,
	});

export function useSaveAutoscale(id: ServiceId) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: AutoscaleInput) => autoscaleApi.save(id, input),
		onSuccess: (saved) => {
			qc.setQueryData(autoscaleQuery(id).queryKey, saved);
			void qc.invalidateQueries({ queryKey: serviceKey(id) });
		},
	});
}

/** Applies a check's AutoFix; the server recomputes it and queues a deployment. */
export function useApplyAutoscaleFix(id: ServiceId) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (fixId: AutoscaleFixId) => autoscaleApi.fix(id, fixId),
		onSuccess: ({ view }) => {
			qc.setQueryData(autoscaleQuery(id).queryKey, view);
			void qc.invalidateQueries({ queryKey: serviceKey(id) });
		},
	});
}
