/* Managed LSDC instances: `/lsdc/instances` and provisioning; `mock/lsdc.ts` serves them for VITE_API_MOCK=1. */
import type {
	LsdcInstance,
	LsdcInstanceUpdate,
	LsdcProvisionInput,
	LsdcProvisionResult,
	LsdcUsage,
} from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { z } from "zod";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";

export type LsdcProvision = z.infer<typeof LsdcProvisionResult>;

export type LsdcApi = {
	list(): Promise<LsdcInstance[]>;
	/** Asks the instance itself; can take seconds, and says why when it does not answer. */
	usage(id: string): Promise<LsdcUsage>;
	/** 409 when the customer's slug is already taken in the environment. */
	provision(
		environmentId: string,
		input: LsdcProvisionInput,
	): Promise<LsdcProvision>;
	/** New limits redeploy the instance. */
	update(id: string, input: LsdcInstanceUpdate): Promise<LsdcInstance>;
};

const i = client.api.lsdc.instances;

const http: LsdcApi = {
	list: () => ok(i.$get()),
	usage: (id) => ok(i[":id"].usage.$get({ param: { id } })),
	provision: (id, json) =>
		ok(client.api.environments[":id"].lsdc.$post({ param: { id }, json })),
	update: (id, json) => ok(i[":id"].$patch({ param: { id }, json })),
};

export const lsdcApi: LsdcApi = isMock
	? (await import("./mock/lsdc")).mockLsdc
	: http;

const KEY = ["lsdc"];

export const lsdcInstancesQuery = queryOptions({
	queryKey: [...KEY, "instances"],
	queryFn: () => lsdcApi.list(),
});

export const lsdcUsageQuery = (id: string) =>
	queryOptions({
		queryKey: [...KEY, "usage", id],
		queryFn: () => lsdcApi.usage(id),
		refetchInterval: 30_000,
		staleTime: 15_000,
	});

/** Instances and their usage refresh after a change; a provision also adds a stack to its project. */
export function useLsdcMutation<A, R>(fn: (args: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => {
			for (const queryKey of [["projects"], ["services"], [...KEY, "usage"]])
				void qc.invalidateQueries({ queryKey });
			// Only the list is awaited: usage asks each instance and can take seconds.
			return qc.invalidateQueries({ queryKey: lsdcInstancesQuery.queryKey });
		},
	});
}
