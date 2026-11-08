import {
	keepPreviousData,
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { authClient } from "@/lib/auth";
import { api, isMock } from ".";
import { subscribe } from "./live";
import type {
	ClusterNode,
	MetricRange,
	NodeId,
	NodeUpdate,
	ProjectId,
	PruneInput,
	ServiceId,
	ServiceThresholdsInput,
	UsageRange,
} from "./types";

// Polling is the floor: the agent gateway may push nothing, and the views must still move.
const POLL = 10_000;

export const nodesQuery = queryOptions({
	queryKey: ["nodes"],
	queryFn: () => api.nodes.list(),
	refetchInterval: POLL,
});

export const nodeQuery = (id: NodeId) =>
	queryOptions({
		queryKey: ["nodes", id],
		queryFn: () => api.nodes.get(id),
		refetchInterval: POLL,
	});

/** No polling: a df walks every volume on the node. */
export const hostDirsQuery = (id: NodeId, path: string) =>
	queryOptions({
		queryKey: ["nodes", id, "host-dirs", path],
		queryFn: () => api.nodes.hostDirs(id, path),
		retry: false,
	});

export const diskQuery = (id: NodeId) =>
	queryOptions({
		queryKey: ["nodes", id, "disk"],
		queryFn: () => api.nodes.disk(id),
		staleTime: 60_000,
		retry: false,
	});

export function usePruneNode(id: NodeId) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: PruneInput) => api.nodes.prune(id, input),
		onSuccess: (r) => {
			qc.setQueryData(diskQuery(id).queryKey, r.usage);
			void qc.invalidateQueries({ queryKey: ["metrics"] });
		},
	});
}

export const hostMetricsQuery = (q: {
	range: MetricRange;
	nodeId?: NodeId;
	perNode?: boolean;
}) =>
	queryOptions({
		queryKey: ["metrics", "hosts", q],
		queryFn: () => api.metrics.hosts(q),
		refetchInterval: POLL,
		placeholderData: keepPreviousData,
	});

export const serviceMetricsQuery = (id: ServiceId, range: MetricRange) =>
	queryOptions({
		queryKey: ["metrics", "services", id, range],
		queryFn: () => api.metrics.service(id, range),
		refetchInterval: POLL,
		placeholderData: keepPreviousData,
	});

/** No polling: the volume column asks every node's agent for a df. */
export const usageQuery = (range: UsageRange) =>
	queryOptions({
		queryKey: ["metrics", "usage", range],
		queryFn: () => api.metrics.usage(range),
		staleTime: 60_000,
		placeholderData: keepPreviousData,
	});

export const projectUsageQuery = (id: ProjectId, range: UsageRange) =>
	queryOptions({
		queryKey: ["metrics", "usage", "projects", id, range],
		queryFn: () => api.metrics.projectUsage(id, range),
		staleTime: 60_000,
		placeholderData: keepPreviousData,
	});

export const monitoringSettingsQuery = queryOptions({
	queryKey: ["monitoring", "settings"],
	queryFn: () => api.monitoring.settings(),
});

function useInvalidateNodes() {
	const qc = useQueryClient();
	return () =>
		Promise.all(
			[["nodes"], ["metrics"]].map((queryKey) =>
				qc.invalidateQueries({ queryKey }),
			),
		);
}

export function useUpdateNode(id: NodeId) {
	const invalidate = useInvalidateNodes();
	return useMutation({
		mutationFn: (input: NodeUpdate) => api.nodes.update(id, input),
		onSuccess: invalidate,
	});
}

export function useRemoveNode(id: NodeId) {
	const invalidate = useInvalidateNodes();
	return useMutation({
		mutationFn: () => api.nodes.remove(id),
		onSuccess: invalidate,
	});
}

export function useSaveMonitoring() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.monitoring.save,
		onSuccess: (saved) => {
			qc.setQueryData(monitoringSettingsQuery.queryKey, saved);
			void qc.invalidateQueries({ queryKey: ["monitoring", "services"] });
		},
	});
}

export const serviceThresholdsQuery = (id: ServiceId) =>
	queryOptions({
		queryKey: ["monitoring", "services", id, "thresholds"],
		queryFn: () => api.monitoring.serviceThresholds(id),
	});

export function useSaveServiceThresholds(id: ServiceId) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: ServiceThresholdsInput) =>
			api.monitoring.saveServiceThresholds(id, input),
		onSuccess: (saved) => {
			qc.setQueryData(serviceThresholdsQuery(id).queryKey, saved);
			// The monitoring settings list every service's thresholds.
			void qc.invalidateQueries({ queryKey: monitoringSettingsQuery.queryKey });
		},
	});
}

export const useActiveOrgId = isMock
	? () => undefined
	: () =>
			authClient.useSession().data?.session.activeOrganizationId ?? undefined;

/** Writes `org:<id>:metrics` host samples into the node views as they arrive. */
export function useLiveHostSamples() {
	const qc = useQueryClient();
	const orgId = useActiveOrgId();
	useEffect(() => {
		if (!orgId) return;
		return subscribe(`org:${orgId}:metrics`, (data) => {
			if (data.kind !== "host") return;
			const { sample } = data;
			const patch = (n: ClusterNode): ClusterNode =>
				n.id === sample.nodeId
					? {
							...n,
							live: sample,
							lastSeenAt: new Date(sample.at).toISOString(),
						}
					: n;
			qc.setQueryData(nodesQuery.queryKey, (list) => list?.map(patch));
			qc.setQueryData(nodeQuery(sample.nodeId).queryKey, (n) =>
				n ? patch(n) : n,
			);
		});
	}, [orgId, qc]);
}
