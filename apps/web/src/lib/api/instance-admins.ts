import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";

const a = client.api.instance.admins;

export type InstanceAdmin = InferResponseType<(typeof a)["$get"], 200>[number];

export type InstanceAdminsApi = {
	list(): Promise<InstanceAdmin[]>;
	add(email: string): Promise<InstanceAdmin[]>;
	remove(id: string): Promise<InstanceAdmin[]>;
};

const http: InstanceAdminsApi = {
	list: () => ok(a.$get()),
	add: (email) => ok(a.$post({ json: { email } })),
	remove: (id) => ok(a[":id"].$delete({ param: { id } })),
};

export const instanceAdminsApi: InstanceAdminsApi = isMock
	? (await import("./mock/instance-admins")).mockInstanceAdmins
	: http;

export const instanceAdminsQuery = queryOptions({
	queryKey: ["instance", "admins"],
	queryFn: () => instanceAdminsApi.list(),
});

export const useInstanceAdmins = (enabled = true) =>
	useQuery({ ...instanceAdminsQuery, enabled });

function useAdminsMutation<T>(fn: (v: T) => Promise<InstanceAdmin[]>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: (list) => {
			qc.setQueryData(instanceAdminsQuery.queryKey, list);
			void qc.invalidateQueries({ queryKey: ["me"] });
		},
	});
}

export const useAddInstanceAdmin = () =>
	useAdminsMutation(instanceAdminsApi.add);
export const useRemoveInstanceAdmin = () =>
	useAdminsMutation(instanceAdminsApi.remove);
