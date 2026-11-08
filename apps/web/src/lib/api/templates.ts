/*
 * The template catalog and its one-request deploy: wire types inferred from the server's
 * routes, the adapter slice both implementations fill, and the query hooks.
 */
import type {
	Template,
	TemplateDeployInput,
	TemplateSummary,
} from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { DEPLOYMENT_STATUS } from "../status";
import { api } from ".";
import { client } from "./client";
import { ok } from "./http";
import type { EnvironmentId } from "./types";

type Api = typeof client.api;

export type TemplateDeployResult = InferResponseType<
	Api["environments"][":id"]["templates"][":templateId"]["$post"],
	201
>;
export type DeployedService = TemplateDeployResult["services"][number];
export type CommunityIndex = InferResponseType<
	Api["templates"]["community"]["$get"],
	200
>;
export type DeploymentRecord = InferResponseType<
	Api["deployments"][":id"]["$get"],
	200
>;

export type TemplatesApi = {
	list(): Promise<TemplateSummary[]>;
	get(id: string): Promise<Template>;
	/** Only for a summary that has `logo`; the rest render a monogram. */
	logoUrl(id: string): string;
	/** 409 `conflict` when service names are taken, 400 `validation_failed` for bad inputs. */
	deploy(
		environmentId: EnvironmentId,
		templateId: string,
		input: TemplateDeployInput,
	): Promise<TemplateDeployResult>;
	deployment(id: string): Promise<DeploymentRecord>;
	/** Where community templates come from and when they were last fetched. */
	communityIndex(): Promise<CommunityIndex>;
	/** Fetches and verifies the signed index again; 400 when it does not verify. */
	refreshCommunity(): Promise<CommunityIndex>;
};

const t = () => client.api.templates;

export const templatesHttp: TemplatesApi = {
	list: () => ok(t().$get({ query: {} })),
	get: async (id) => (await ok(t()[":id"].$get({ param: { id } }))) as Template,
	logoUrl: (id) => `/api/templates/${encodeURIComponent(id)}/logo`,
	deploy: (id, templateId, json) =>
		ok(
			client.api.environments[":id"].templates[":templateId"].$post({
				param: { id, templateId },
				json,
			}),
		),
	deployment: (id) => ok(client.api.deployments[":id"].$get({ param: { id } })),
	communityIndex: () => ok(t().community.$get()),
	refreshCommunity: () => ok(t().community.refresh.$post()),
};

// The catalog only changes with a release or a community Refresh, so it is fetched once per session.
export const templatesQuery = queryOptions({
	queryKey: ["templates"],
	queryFn: () => api.templates.list(),
	staleTime: Number.POSITIVE_INFINITY,
});

export const templateQuery = (id: string) =>
	queryOptions({
		queryKey: ["templates", id],
		queryFn: () => api.templates.get(id),
		staleTime: Number.POSITIVE_INFINITY,
	});

export const communityIndexQuery = queryOptions({
	queryKey: ["templates-community"],
	queryFn: () => api.templates.communityIndex(),
});

export function useRefreshCommunity() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.templates.refreshCommunity(),
		onSuccess: (index) => {
			qc.setQueryData(communityIndexQuery.queryKey, index);
			return qc.invalidateQueries({ queryKey: ["templates"] });
		},
	});
}

export const deploymentQuery = (id: string) =>
	queryOptions({
		queryKey: ["deployment", id],
		queryFn: () => api.templates.deployment(id),
		refetchInterval: (q) =>
			q.state.data && !DEPLOYMENT_STATUS[q.state.data.status].live
				? false
				: 1_500,
	});

export function useDeployTemplate(environmentId: EnvironmentId) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { templateId: string; input: TemplateDeployInput }) =>
			api.templates.deploy(environmentId, v.templateId, v.input),
		onSuccess: () =>
			Promise.all(
				[["services"], ["projects"], ["overview"]].map((queryKey) =>
					qc.invalidateQueries({ queryKey }),
				),
			),
	});
}
