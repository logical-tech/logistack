import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";
import type { NodeId } from "./types";

const p = client.api.patching;
const n = client.api.nodes[":id"].patches;

export type NodePatchStatus = InferResponseType<(typeof n)["$get"], 200>;
export type PackageUpdate = NodePatchStatus["updates"][number];
export type PatchRun = InferResponseType<(typeof p.runs)["$post"], 201>;
export type PatchRunNode = PatchRun["nodes"][number];
export type PatchRunInput = InferRequestType<(typeof p.runs)["$post"]>["json"];
export type PatchPolicy = InferResponseType<(typeof p.policy)["$get"], 200>;

export type PatchingApi = {
	fleet(): Promise<NodePatchStatus[]>;
	node(id: NodeId): Promise<NodePatchStatus>;
	scan(id: NodeId): Promise<NodePatchStatus>;
	runs(): Promise<PatchRun[]>;
	start(input: PatchRunInput): Promise<PatchRun>;
	cancel(id: string): Promise<PatchRun>;
	policy(): Promise<PatchPolicy>;
	savePolicy(input: PatchPolicy): Promise<PatchPolicy>;
};

const http: PatchingApi = {
	fleet: () => ok(p.nodes.$get()),
	node: (id) => ok(n.$get({ param: { id } })),
	scan: (id) => ok(n.scan.$post({ param: { id } })),
	runs: () => ok(p.runs.$get()),
	start: (json) => ok(p.runs.$post({ json })),
	cancel: (id) => ok(p.runs[":id"].cancel.$post({ param: { id } })),
	policy: () => ok(p.policy.$get()),
	savePolicy: (json) => ok(p.policy.$put({ json })),
};

export const patchingApi: PatchingApi = isMock
	? (await import("./mock/patching")).mockPatching
	: http;

export const isActive = (r: Pick<PatchRun, "state">) =>
	r.state === "queued" || r.state === "running";

export const patchRunsQuery = queryOptions({
	queryKey: ["patching", "runs"],
	queryFn: () => patchingApi.runs(),
	// Follow a run step by step; otherwise runs only start from here or a window.
	refetchInterval: (q) => (q.state.data?.some(isActive) ? 2_000 : 60_000),
});

export const fleetPatchesQuery = queryOptions({
	queryKey: ["patching", "nodes"],
	queryFn: () => patchingApi.fleet(),
	refetchInterval: 60_000,
});

export const nodePatchesQuery = (id: NodeId) =>
	queryOptions({
		queryKey: ["patching", "nodes", id],
		queryFn: () => patchingApi.node(id),
		refetchInterval: 60_000,
	});

export const patchPolicyQuery = queryOptions({
	queryKey: ["patching", "policy"],
	queryFn: () => patchingApi.policy(),
});

export function useScanNode(id: NodeId) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => patchingApi.scan(id),
		onSuccess: (s) => {
			qc.setQueryData(nodePatchesQuery(id).queryKey, s);
			void qc.invalidateQueries({ queryKey: fleetPatchesQuery.queryKey });
		},
	});
}

export function useStartPatchRun() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: PatchRunInput) => patchingApi.start(input),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["patching"] }),
	});
}

export function useCancelPatchRun() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => patchingApi.cancel(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["patching"] }),
	});
}

export function useSavePatchPolicy() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: PatchPolicy) => patchingApi.savePolicy(input),
		onSuccess: (saved) => qc.setQueryData(patchPolicyQuery.queryKey, saved),
	});
}
