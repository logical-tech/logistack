import { type LiveMessage, updateChannel } from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { useEffect } from "react";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";
import { subscribe } from "./live";

type UpdateApi = typeof client.api.instance.update;

export type UpdateStatus = InferResponseType<UpdateApi["$get"], 200>;
export type UpdateRun = NonNullable<UpdateStatus["run"]>;
export type UpdateStepId = keyof UpdateRun["steps"];

export type UpdatesApi = {
	/** `refresh` asks GitHub again unless it was asked in the last minute. */
	status(refresh?: boolean): Promise<UpdateStatus>;
	start(version: string): Promise<UpdateRun>;
	setAutoCheck(enabled: boolean): Promise<{ enabled: boolean }>;
	/** Live `data` frames for a /ws channel; the mock simulates them. */
	live(channel: string, fn: (data: LiveMessage) => void): () => void;
};

const a = client.api.instance.update;
const http: UpdatesApi = {
	status: (refresh) =>
		ok(a.$get({ query: refresh ? { refresh: "true" } : {} })),
	start: (version) => ok(a.$post({ json: { version } })),
	setAutoCheck: (enabled) => ok(a["auto-check"].$put({ json: { enabled } })),
	live: subscribe,
};

export const updatesApi: UpdatesApi = isMock
	? (await import("./mock/updates")).mockUpdates
	: http;

export const isActive = (run: UpdateRun | null | undefined) =>
	run?.state === "queued" || run?.state === "running";

export const updateStatusQuery = queryOptions({
	queryKey: ["instance", "update"],
	queryFn: () => updatesApi.status(),
	staleTime: 30_000,
	// The api itself restarts mid-update and drops /ws; polling carries the page across.
	refetchInterval: (q) => (isActive(q.state.data?.run) ? 2_000 : false),
});

/** The status, with the running update's steps and log lines folded in as they stream. */
export function useUpdateStatus() {
	const qc = useQueryClient();
	const query = useQuery(updateStatusQuery);
	const run = query.data?.run;
	const liveId = isActive(run) ? run?.id : undefined;
	useEffect(() => {
		if (!liveId) return;
		return updatesApi.live(updateChannel(liveId), (m) => {
			if (m.kind !== "update") return;
			qc.setQueryData(updateStatusQuery.queryKey, (s) =>
				s?.run?.id === liveId
					? {
							...s,
							run: {
								...s.run,
								state: m.state,
								steps: m.steps,
								log: m.line ? [...s.run.log, m.line] : s.run.log,
							},
						}
					: s,
			);
			// The new version shows once the api that reports it is the one answering.
			if (m.state === "succeeded" || m.state === "failed")
				void qc.invalidateQueries({ queryKey: ["instance"] });
		});
	}, [liveId, qc]);
	return query;
}

export function useCheckNow() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => updatesApi.status(true),
		onSuccess: (s) => qc.setQueryData(updateStatusQuery.queryKey, s),
	});
}

export function useStartUpdate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updatesApi.start,
		onSuccess: (run) =>
			qc.setQueryData(updateStatusQuery.queryKey, (s) =>
				s ? { ...s, run } : s,
			),
	});
}

export function useSetAutoCheck() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updatesApi.setAutoCheck,
		onSuccess: ({ enabled }) =>
			qc.setQueryData(updateStatusQuery.queryKey, (s) =>
				s ? { ...s, autoCheck: enabled } : s,
			),
	});
}
