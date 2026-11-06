/*
 * Variables shared above a service: organization, project and environment scope. The
 * server edits them one at a time; `replace` turns an editor's full set into those calls.
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
import type { ServiceVarInput } from "./service-ops";
import { planReplace } from "./variables-plan";

type Api = typeof client.api;
export type ScopedVar = InferResponseType<Api["env-vars"]["$get"], 200>[number];
export type SharedScope = Exclude<ScopedVar["scope"], "service">;

export type VariablesApi = {
	list(scope: SharedScope, scopeId: string): Promise<ScopedVar[]>;
	/** Makes the set at one scope this one: missing keys are deleted, an entry without `value` keeps its stored one. */
	replace(
		scope: SharedScope,
		scopeId: string,
		variables: ServiceVarInput[],
	): Promise<void>;
};

const e = () => client.api["env-vars"];

export const variablesHttp: VariablesApi = {
	list: (scope, scopeId) => ok(e().$get({ query: { scope, scopeId } })),
	// shortcut: one call per variable, not atomic; add a bulk PUT /env-vars if partial saves bite.
	replace: async (scope, scopeId, variables) => {
		const plan = planReplace(
			await variablesHttp.list(scope, scopeId),
			variables,
		);
		for (const id of plan.remove)
			await done(e()[":id"].$delete({ param: { id } }));
		for (const { value, ...v } of plan.create)
			await ok(
				e().$post({ json: { scope, scopeId, ...v, value: value ?? "" } }),
			);
		for (const { id, key: _, ...json } of plan.update)
			await ok(e()[":id"].$patch({ param: { id }, json }));
	},
};

export const variablesQuery = (scope: SharedScope, scopeId: string) =>
	queryOptions({
		queryKey: ["env-vars", scope, scopeId],
		queryFn: () => api.variables.list(scope, scopeId),
	});

/** Saving a shared scope changes what every service below it inherits. */
export function useReplaceVariables(scope: SharedScope, scopeId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (variables: ServiceVarInput[]) =>
			api.variables.replace(scope, scopeId, variables),
		onSuccess: () =>
			Promise.all([
				qc.invalidateQueries({ queryKey: ["env-vars"] }),
				qc.invalidateQueries({ queryKey: ["service"] }),
			]),
	});
}
