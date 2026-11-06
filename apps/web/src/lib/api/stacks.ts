/*
 * Stacks: services created together from one template or compose file. Wire types inferred
 * from the server's routes, the adapter slice both implementations fill, and the query hooks.
 */
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from ".";
import { client } from "./client";
import { done, ok } from "./http";
import type { EnvironmentId, Service } from "./types";

type Api = typeof client.api;

export type Stack = InferResponseType<
	Api["environments"][":id"]["stacks"]["$get"],
	200
>[number];
export type StackId = Stack["id"];
export type StackDetail = InferResponseType<Api["stacks"][":id"]["$get"], 200>;
export type StackCreated = InferResponseType<
	Api["environments"][":id"]["stacks"]["$post"],
	201
>;

export type StackChanges = InferResponseType<
	Api["stacks"][":id"]["compose"]["preview"]["$post"],
	200
>;
export type StackChange = StackChanges["changes"][number];
export type StackUpdated = InferResponseType<
	Api["stacks"][":id"]["compose"]["$put"],
	200
>;

export type StacksApi = {
	list(environmentId: EnvironmentId): Promise<Stack[]>;
	get(id: StackId): Promise<StackDetail>;
	/** 400 `validation_failed` lists every compose part LogiStack cannot run; 409 on taken names. */
	createFromCompose(
		environmentId: EnvironmentId,
		input: { name: string; composeYaml: string },
	): Promise<StackCreated>;
	/** What applying `composeYaml` would create, change or remove; writes nothing. */
	previewCompose(id: StackId, composeYaml: string): Promise<StackChanges>;
	/** Converges the stack's services to `composeYaml` and redeploys the ones that changed. */
	applyCompose(id: StackId, composeYaml: string): Promise<StackUpdated>;
	/** Deletes the stack and every service in it. */
	remove(id: StackId): Promise<void>;
};

export const stacksHttp: StacksApi = {
	list: (id) =>
		ok(client.api.environments[":id"].stacks.$get({ param: { id } })),
	get: (id) => ok(client.api.stacks[":id"].$get({ param: { id } })),
	createFromCompose: (id, json) =>
		ok(client.api.environments[":id"].stacks.$post({ param: { id }, json })),
	previewCompose: (id, composeYaml) =>
		ok(
			client.api.stacks[":id"].compose.preview.$post({
				param: { id },
				json: { composeYaml },
			}),
		),
	applyCompose: (id, composeYaml) =>
		ok(
			client.api.stacks[":id"].compose.$put({
				param: { id },
				json: { composeYaml },
			}),
		),
	remove: (id) => done(client.api.stacks[":id"].$delete({ param: { id } })),
};

export const stacksQuery = (environmentId: EnvironmentId) =>
	queryOptions({
		queryKey: ["stacks", { environmentId }],
		queryFn: () => api.stacks.list(environmentId),
		refetchInterval: 10_000,
	});

export const stackQuery = (id: StackId) =>
	queryOptions({
		queryKey: ["stacks", id],
		queryFn: () => api.stacks.get(id),
		refetchInterval: 5_000,
	});

const invalidated = [["stacks"], ["services"], ["projects"], ["overview"]];

export function useCreateComposeStack() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			environmentId,
			...input
		}: {
			environmentId: EnvironmentId;
			name: string;
			composeYaml: string;
		}) => api.stacks.createFromCompose(environmentId, input),
		onSuccess: () =>
			Promise.all(
				invalidated.map((queryKey) => qc.invalidateQueries({ queryKey })),
			),
	});
}

export function useApplyStackCompose(id: StackId) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (composeYaml: string) =>
			api.stacks.applyCompose(id, composeYaml),
		onSuccess: () =>
			Promise.all(
				invalidated.map((queryKey) => qc.invalidateQueries({ queryKey })),
			),
	});
}

export function useDeleteStack() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: StackId) => api.stacks.remove(id),
		onSuccess: () =>
			Promise.all(
				invalidated.map((queryKey) => qc.invalidateQueries({ queryKey })),
			),
	});
}

/**
 * The service a stack is known by: the first with a public domain, else the first
 * application, else the first. Its domain and icon stand for the stack.
 */
export function primaryOf<S extends Pick<Service, "kind" | "domains">>(
	services: S[],
): S | undefined {
	return (
		services.find((s) => s.kind === "application" && s.domains.length) ??
		services.find((s) => s.kind === "application") ??
		services[0]
	);
}
