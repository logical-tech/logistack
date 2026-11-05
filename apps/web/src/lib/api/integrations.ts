import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { ok } from "./http";
import type { ServiceId } from "./types";

type Api = typeof client.api;
type Ok<F> = InferResponseType<F, 200>;
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;
type GitApi = Api["git-providers"];
type RegistryApi = Api["registries"];

export type GitProvider = Ok<GitApi["$get"]>[number];
export type GitProviderKind = GitProvider["kind"];
export type GitConnect = Body<GitApi["test"]["$post"]>;
export type GitCheck = Ok<GitApi["test"]["$post"]>;
export type GitRepo = Ok<GitApi[":id"]["repos"]["$get"]>[number];
export type GitHubManifest = InferResponseType<
	GitApi["github"]["manifest"]["$post"],
	201
>;
export type WebhookOutcome = Ok<GitApi[":id"]["webhooks"]["$post"]>;
export type GitTrigger = Ok<Api["services"][":id"]["git-trigger"]["$get"]>;
export type SshKey = Ok<Api["ssh-keys"]["$get"]>[number];
export type Registries = Ok<RegistryApi["$get"]>;
export type Registry = Registries["registries"][number];
export type RegistryInput = Body<RegistryApi["$post"]>;
export type RegistryCredentials = Ok<RegistryApi[":id"]["credentials"]["$get"]>;

export type IntegrationsApi = {
	git: {
		list(): Promise<GitProvider[]>;
		test(provider: GitConnect): Promise<GitCheck>;
		create(input: { name: string; provider: GitConnect }): Promise<{
			id: string;
		}>;
		githubManifest(input: {
			name: string;
			organization?: string;
		}): Promise<GitHubManifest>;
		githubInstallation(id: string): Promise<{ installationId: string }>;
		testSaved(id: string): Promise<GitCheck>;
		repos(id: string): Promise<GitRepo[]>;
		branches(id: string, repo: string): Promise<string[]>;
		check(
			id: string,
			source: { repository: string; branch: string },
		): Promise<GitCheck>;
		webhook(id: string, repository: string): Promise<WebhookOutcome>;
		remove(id: string): Promise<void>;
	};
	sshKeys: {
		list(): Promise<SshKey[]>;
		create(name: string): Promise<SshKey>;
	};
	watchPaths: {
		get(serviceId: ServiceId): Promise<{ paths: string[] }>;
		put(serviceId: ServiceId, paths: string[]): Promise<{ paths: string[] }>;
	};
	gitTrigger: {
		get(serviceId: ServiceId): Promise<GitTrigger>;
		put(serviceId: ServiceId, rules: GitTrigger): Promise<GitTrigger>;
	};
	registries: {
		list(): Promise<Registries>;
		test(input: {
			url: string;
			username?: string;
			password?: string;
		}): Promise<GitCheck>;
		create(input: RegistryInput): Promise<{ id: string }>;
		update(
			id: string,
			patch: { isDefault?: boolean; keepTags?: number },
		): Promise<void>;
		remove(id: string): Promise<void>;
		setLocal(input: {
			enabled: boolean;
			purge?: boolean;
		}): Promise<{ enabled: boolean; url: string | null }>;
		credentials(id: string): Promise<RegistryCredentials>;
	};
};

/** 204 responses carry no body; failures still go through `ok` for the server's error shape. */
async function done(pending: Promise<{ ok: boolean }>) {
	const res = await pending;
	if (!res.ok) await ok(Promise.resolve(res as never));
}

const param = (id: string) => ({ param: { id } });

const http: IntegrationsApi = {
	git: {
		list: () => ok(client.api["git-providers"].$get()),
		test: (json) => ok(client.api["git-providers"].test.$post({ json })),
		create: (json) => ok(client.api["git-providers"].$post({ json })),
		githubManifest: (json) =>
			ok(client.api["git-providers"].github.manifest.$post({ json })),
		githubInstallation: (id) =>
			ok(
				client.api["git-providers"][":id"].github.installation.$post(param(id)),
			),
		testSaved: (id) =>
			ok(client.api["git-providers"][":id"].test.$post(param(id))),
		repos: (id) => ok(client.api["git-providers"][":id"].repos.$get(param(id))),
		branches: (id, repo) =>
			ok(
				client.api["git-providers"][":id"].branches.$get({
					...param(id),
					query: { repo },
				}),
			),
		check: (id, json) =>
			ok(
				client.api["git-providers"][":id"].check.$post({ ...param(id), json }),
			),
		webhook: (id, repository) =>
			ok(
				client.api["git-providers"][":id"].webhooks.$post({
					...param(id),
					json: { repository },
				}),
			),
		remove: (id) => done(client.api["git-providers"][":id"].$delete(param(id))),
	},
	sshKeys: {
		list: () => ok(client.api["ssh-keys"].$get()),
		create: (name) => ok(client.api["ssh-keys"].$post({ json: { name } })),
	},
	watchPaths: {
		get: (id) => ok(client.api.services[":id"]["watch-paths"].$get(param(id))),
		put: (id, paths) =>
			ok(
				client.api.services[":id"]["watch-paths"].$put({
					...param(id),
					json: { paths },
				}),
			),
	},
	gitTrigger: {
		get: (id) => ok(client.api.services[":id"]["git-trigger"].$get(param(id))),
		put: (id, json) =>
			ok(
				client.api.services[":id"]["git-trigger"].$put({ ...param(id), json }),
			),
	},
	registries: {
		list: () => ok(client.api.registries.$get()),
		test: (json) => ok(client.api.registries.test.$post({ json })),
		create: (json) => ok(client.api.registries.$post({ json })),
		update: (id, json) =>
			done(client.api.registries[":id"].$patch({ ...param(id), json })),
		remove: (id) => done(client.api.registries[":id"].$delete(param(id))),
		setLocal: (json) =>
			ok(
				client.api.registries.local.$put({
					json: { purge: false, ...json },
				}),
			),
		credentials: (id) =>
			ok(client.api.registries[":id"].credentials.$get(param(id))),
	},
};

export const integrations: IntegrationsApi = isMock
	? (await import("./mock/integrations")).mockIntegrations
	: http;

export const gitProvidersQuery = queryOptions({
	queryKey: ["git-providers"],
	queryFn: () => integrations.git.list(),
});

export const reposQuery = (providerId: string) =>
	queryOptions({
		queryKey: ["git-providers", providerId, "repos"],
		queryFn: () => integrations.git.repos(providerId),
		staleTime: 60_000,
	});

export const branchesQuery = (providerId: string, repo: string) =>
	queryOptions({
		queryKey: ["git-providers", providerId, "branches", repo],
		queryFn: () => integrations.git.branches(providerId, repo),
		enabled: repo !== "",
		staleTime: 60_000,
	});

export const sshKeysQuery = queryOptions({
	queryKey: ["ssh-keys"],
	queryFn: () => integrations.sshKeys.list(),
});

export const registriesQuery = queryOptions({
	queryKey: ["registries"],
	queryFn: () => integrations.registries.list(),
});

/** A mutation that refreshes the given lists once it settles. */
function useInvalidating<A, R>(
	fn: (args: A) => Promise<R>,
	...keys: string[][]
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () =>
			Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))),
	});
}

export const useDeleteGitProvider = () =>
	useInvalidating(integrations.git.remove, ["git-providers"]);

export const useCreateGitProvider = () =>
	useInvalidating(integrations.git.create, ["git-providers"]);

export const usePickUpInstallation = () =>
	useInvalidating(integrations.git.githubInstallation, ["git-providers"]);

export const useCreateSshKey = () =>
	useInvalidating(integrations.sshKeys.create, ["ssh-keys"]);

export const useCreateRegistry = () =>
	useInvalidating(integrations.registries.create, ["registries"]);

export const useUpdateRegistry = () =>
	useInvalidating(
		({
			id,
			...patch
		}: {
			id: string;
			isDefault?: boolean;
			keepTags?: number;
		}) => integrations.registries.update(id, patch),
		["registries"],
	);

export const useDeleteRegistry = () =>
	useInvalidating(integrations.registries.remove, ["registries"]);

export const useSetLocalRegistry = () =>
	useInvalidating(integrations.registries.setLocal, ["registries"]);
