/*
 * SSO providers: wire types inferred from the server's routes, the adapter slice both
 * implementations fill, and the query hooks.
 */
import { queryOptions } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api } from ".";
import { client } from "./client";
import { ok } from "./http";

type Api = typeof client.api.sso;
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;

export type SsoProvider = InferResponseType<
	Api["providers"]["$get"],
	200
>[number];
export type OidcDiscovery = InferResponseType<Api["discovery"]["$get"], 200>;
export type ServiceProvider = InferResponseType<
	Api["service-provider"]["$get"],
	200
>;
export type CreateOidcProvider = Body<Api["providers"]["oidc"]["$post"]>;
export type CreateSamlProvider = Body<Api["providers"]["saml"]["$post"]>;

export type SsoApi = {
	status(): Promise<{ enabled: boolean }>;
	list(): Promise<SsoProvider[]>;
	discover(issuer: string): Promise<OidcDiscovery>;
	serviceProvider(providerId: string): Promise<ServiceProvider>;
	createOidc(input: CreateOidcProvider): Promise<SsoProvider>;
	createSaml(input: CreateSamlProvider): Promise<SsoProvider>;
	remove(providerId: string): Promise<void>;
	/** The IdP URL that starts a sign-in through `providerId`, ending at `callbackURL`. */
	signInUrl(providerId: string, callbackURL: string): Promise<string>;
};

const s = () => client.api.sso;

export const ssoHttp: SsoApi = {
	status: () => ok(s().status.$get()),
	list: () => ok(s().providers.$get()),
	discover: (issuer) => ok(s().discovery.$get({ query: { issuer } })),
	serviceProvider: (providerId) =>
		ok(s()["service-provider"].$get({ query: { providerId } })),
	createOidc: (json) => ok(s().providers.oidc.$post({ json })),
	createSaml: (json) => ok(s().providers.saml.$post({ json })),
	remove: async (providerId) => {
		const res = await s().providers[":providerId"].$delete({
			param: { providerId },
		});
		if (!res.ok) await ok(Promise.resolve(res) as never);
	},
	// Plain fetch: better-auth's client would redirect this window, not the popup.
	signInUrl: async (providerId, callbackURL) => {
		const res = await fetch("/api/auth/sign-in/sso", {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				providerId,
				callbackURL,
				errorCallbackURL: callbackURL,
			}),
		});
		const body = (await res.json().catch(() => null)) as {
			url?: string;
			message?: string;
		} | null;
		if (!res.ok || !body?.url)
			throw new Error(body?.message ?? `sign-in failed with ${res.status}`);
		return body.url;
	},
};

export const ssoStatusQuery = queryOptions({
	queryKey: ["sso", "status"],
	queryFn: () => api.sso.status(),
	staleTime: 60_000,
});

export const ssoProvidersQuery = queryOptions({
	queryKey: ["sso", "providers"],
	queryFn: () => api.sso.list(),
});

export const serviceProviderQuery = (providerId: string) =>
	queryOptions({
		queryKey: ["sso", "service-provider", providerId],
		queryFn: () => api.sso.serviceProvider(providerId),
		staleTime: Number.POSITIVE_INFINITY,
	});
