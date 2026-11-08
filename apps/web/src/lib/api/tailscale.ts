/* Tailscale: straight to the API; mock mode shows it turned off. */
import { queryOptions } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

type Api = typeof client.api;
export type Tailscale = InferResponseType<Api["tailscale"]["$get"], 200>;
export type TailscalePublication = Tailscale["publications"][number];
export type CreatePublication = InferRequestType<
	Api["tailscale"]["publications"]["$post"]
>["json"];

const off: Tailscale = {
	enabled: false,
	nodesRunning: false,
	statusMessage: null,
	publications: [],
};

export const tailscaleQuery = queryOptions({
	queryKey: ["tailscale"],
	queryFn: (): Promise<Tailscale> =>
		isMock ? Promise.resolve(off) : ok(client.api.tailscale.$get()),
	// The worker starts tailscaled and the publishers a few seconds after a change.
	refetchInterval: 5_000,
});

export const tailscaleApi = {
	enable: (authKey: string) =>
		ok(client.api.tailscale.$put({ json: { authKey } })),
	disable: () => done(client.api.tailscale.$delete()),
	publish: (json: CreatePublication) =>
		ok(client.api.tailscale.publications.$post({ json })),
	unpublish: (id: string) =>
		done(client.api.tailscale.publications[":id"].$delete({ param: { id } })),
	test: (publicationId?: string) =>
		ok(client.api.tailscale.test.$post({ json: { publicationId } })),
};
