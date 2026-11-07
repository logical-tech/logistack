/*
 * Managed secrets: metadata lists, reveal (audited), versions, usages, and the
 * organization's key rotation. Values never travel except through `reveal`.
 */
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api } from ".";
import { client } from "./client";
import { done, ok } from "./http";

type Api = typeof client.api;
type One = Api["secrets"][":id"];
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;

export type SecretMeta = InferResponseType<Api["secrets"]["$get"], 200>[number];
export type SecretScope = SecretMeta["scope"];
export type AvailableSecret = InferResponseType<
	Api["secrets"]["available"]["$get"],
	200
>[number];
export type SecretInput = Body<Api["secrets"]["$post"]>;
export type SecretPatch = Body<One["$patch"]>;
export type SecretVersion = InferResponseType<
	One["versions"]["$get"],
	200
>[number];
export type SecretUsage = InferResponseType<One["usages"]["$get"], 200>[number];
export type SecretReveal = InferResponseType<One["reveal"]["$post"], 200>;
export type KeyRotation = InferResponseType<
	Api["organization"]["secret-keys"]["rotate"]["$post"],
	200
>;

export type SecretsApi = {
	list(scope: SecretScope, scopeId: string): Promise<SecretMeta[]>;
	/** Secrets on a service's chain, with where each is defined and whether a closer one shadows it. */
	available(serviceId: string): Promise<AvailableSecret[]>;
	create(input: SecretInput): Promise<SecretMeta>;
	/** A new value becomes a new version. */
	update(id: string, patch: SecretPatch): Promise<SecretMeta>;
	/** Audited; needs `read:secrets` on the defining scope. */
	reveal(id: string, version?: number): Promise<SecretReveal>;
	versions(id: string): Promise<SecretVersion[]>;
	/** Copies `version`'s value as a new version. */
	rollback(id: string, version: number): Promise<SecretMeta>;
	usages(id: string): Promise<SecretUsage[]>;
	/** 409 with `details.usages` while a service references it. */
	remove(id: string): Promise<void>;
	/** Re-encrypts every version under a new data key; values do not change. */
	rotateKey(): Promise<KeyRotation>;
};

const s = () => client.api.secrets;
const id = (v: string) => ({ param: { id: v } });

export const secretsHttp: SecretsApi = {
	list: (scope, scopeId) => ok(s().$get({ query: { scope, scopeId } })),
	available: (serviceId) => ok(s().available.$get({ query: { serviceId } })),
	create: (json) => ok(s().$post({ json })),
	update: (v, json) => ok(s()[":id"].$patch({ ...id(v), json })),
	reveal: (v, version) =>
		ok(s()[":id"].reveal.$post({ ...id(v), json: { version } })),
	versions: (v) => ok(s()[":id"].versions.$get(id(v))),
	rollback: (v, version) =>
		ok(s()[":id"].rollback.$post({ ...id(v), json: { version } })),
	usages: (v) => ok(s()[":id"].usages.$get(id(v))),
	remove: (v) => done(s()[":id"].$delete(id(v))),
	rotateKey: () => ok(client.api.organization["secret-keys"].rotate.$post()),
};

export const secretsQuery = (scope: SecretScope, scopeId: string) =>
	queryOptions({
		queryKey: ["secrets", scope, scopeId],
		queryFn: () => api.secrets.list(scope, scopeId),
	});

export const availableSecretsQuery = (serviceId: string) =>
	queryOptions({
		// Under the service's key: saving its variables can add service secrets.
		queryKey: ["service", serviceId, "available-secrets"],
		queryFn: () => api.secrets.available(serviceId),
	});

export const secretVersionsQuery = (id: string) =>
	queryOptions({
		queryKey: ["secrets", "versions", id],
		queryFn: () => api.secrets.versions(id),
	});

export const secretUsagesQuery = (id: string) =>
	queryOptions({
		queryKey: ["secrets", "usages", id],
		queryFn: () => api.secrets.usages(id),
	});

/** Any secret change can alter lists, versions, usages and what services see. */
export function useSecretMutation<A, R>(fn: (args: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () =>
			Promise.all(
				[["secrets"], ["service"]].map((queryKey) =>
					qc.invalidateQueries({ queryKey }),
				),
			),
	});
}

/** The default for a typed value: sensitive-looking names start as secrets. */
export const looksSecret = (key: string) =>
	/password|secret|token|key|credential|private/i.test(key);

export const SCOPE_LABEL: Record<SecretScope, string> = {
	organization: "Organization",
	folder: "Folder",
	project: "Project",
	environment: "Environment",
	service: "Service",
};
export const SCOPE_RANK: Record<SecretScope, number> = {
	organization: 0,
	folder: 1,
	project: 2,
	environment: 3,
	service: 4,
};
