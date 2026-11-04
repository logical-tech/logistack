/* Cloudflare Tunnels: straight to the API; the mock adapter has none, so mock mode lists nothing. */
import { queryOptions } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

type Api = typeof client.api;
export type Tunnel = InferResponseType<Api["tunnels"]["$get"], 200>[number];
export type CreateTunnel = InferRequestType<Api["tunnels"]["$post"]>["json"];

export const tunnelsQuery = queryOptions({
	queryKey: ["tunnels"],
	queryFn: (): Promise<Tunnel[]> =>
		isMock ? Promise.resolve([]) : ok(client.api.tunnels.$get()),
	// The connector reports in a few seconds after the worker starts it.
	refetchInterval: 15_000,
});

export const cloudflareAccountsQuery = (dnsProviderId: string) =>
	queryOptions({
		queryKey: ["cloudflare-accounts", dnsProviderId],
		queryFn: () =>
			ok(
				client.api["dns-providers"][":id"]["cloudflare-accounts"].$get({
					param: { id: dnsProviderId },
				}),
			),
		enabled: Boolean(dnsProviderId),
		staleTime: 60_000,
	});

export const tunnelsApi = {
	create: (json: CreateTunnel) => ok(client.api.tunnels.$post({ json })),
	remove: (id: string) =>
		done(client.api.tunnels[":id"].$delete({ param: { id } })),
};
