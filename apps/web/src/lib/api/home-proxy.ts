/* Local proxy (instance-wide HTTPS names for LAN devices): `/network/proxy/*`; `mock/home-proxy.ts` serves it for VITE_API_MOCK=1. */
import type {
	HomeProxy,
	HomeProxyEnableInput,
	HomeProxyRoute,
	HomeProxyTestResult,
	HomeProxyUpdateInput,
} from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { isMock } from ".";
import { useMe } from "./access";
import { client } from "./client";
import { done, ok } from "./http";

/** What the forms send: the API parses the upstream text (URL or host:port) itself. */
export type HomeProxyRouteDraft = {
	name: string;
	upstream: string;
	insecure: boolean;
};

export type HomeProxyApi = {
	get(): Promise<HomeProxy>;
	enable(input: HomeProxyEnableInput): Promise<HomeProxy>;
	update(input: HomeProxyUpdateInput): Promise<HomeProxy>;
	disable(): Promise<void>;
	test(upstream: string, insecure: boolean): Promise<HomeProxyTestResult>;
	routes(): Promise<HomeProxyRoute[]>;
	addRoute(r: HomeProxyRouteDraft): Promise<HomeProxyRoute>;
	updateRoute(
		id: string,
		r: Partial<HomeProxyRouteDraft>,
	): Promise<HomeProxyRoute>;
	deleteRoute(id: string): Promise<void>;
};

const p = client.api.network.proxy;

const http: HomeProxyApi = {
	get: () => ok(p.$get()),
	enable: (json) => ok(p.$post({ json })),
	update: (json) => ok(p.$patch({ json })),
	disable: () => done(p.$delete()),
	test: (upstream, insecure) =>
		ok(p.test.$post({ json: { upstream, insecure } })),
	routes: () => ok(p.routes.$get()),
	addRoute: (json) => ok(p.routes.$post({ json })),
	updateRoute: (id, json) =>
		ok(p.routes[":id"].$patch({ param: { id }, json })),
	deleteRoute: (id) => done(p.routes[":id"].$delete({ param: { id } })),
};

export const homeProxyApi: HomeProxyApi = isMock
	? (await import("./mock/home-proxy")).mockHomeProxy
	: http;

const KEY = ["home-proxy"];

export const homeProxyQuery = queryOptions({
	queryKey: KEY,
	queryFn: () => homeProxyApi.get(),
	// The worker fills in the internal CA root a moment after it is chosen.
	refetchInterval: (q) =>
		q.state.data?.tls === "internal" && !q.state.data.caRootPem
			? 3_000
			: 30_000,
});

export const homeProxyRoutesQuery = queryOptions({
	queryKey: [...KEY, "routes"],
	queryFn: () => homeProxyApi.routes(),
});

/** The local proxy as an instance admin sees it; `on` drives the nav and the settings card. */
export function useHomeProxy() {
	const { data: me } = useMe();
	const admin = me?.instanceAdmin === true;
	const q = useQuery({ ...homeProxyQuery, enabled: admin });
	return { ...q, admin, me, on: admin && q.data?.enabled === true };
}

/** Any change refreshes the proxy and its routes. */
export function useHomeProxyMutation<A, R>(fn: (args: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
	});
}
