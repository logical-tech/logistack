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

const a = client.api.instance.sponsor;

export type SponsorStatus = InferResponseType<(typeof a)["$get"], 200>;

export type SponsorApi = {
	status(): Promise<SponsorStatus>;
	activate(key: string): Promise<SponsorStatus>;
	remove(): Promise<SponsorStatus>;
};

const http: SponsorApi = {
	status: () => ok(a.$get()),
	activate: (key) => ok(a.$put({ json: { key } })),
	remove: () => ok(a.$delete()),
};

export const sponsorApi: SponsorApi = isMock
	? (await import("./mock/sponsor")).mockSponsor
	: http;

/** Where people sponsor: the site's section with the amounts and the Stripe links. */
export const SPONSOR_URL = "https://stack.logicaltech.it/#sponsor";

export const sponsorQuery = queryOptions({
	queryKey: ["instance", "sponsor"],
	queryFn: () => sponsorApi.status(),
	staleTime: 5 * 60_000,
});

/** True only once the status loaded and is active, so banners never flash for sponsors. */
export function useIsSponsor() {
	const { data } = useQuery(sponsorQuery);
	return { loaded: !!data, sponsor: data?.state === "active" };
}

export function useActivateSponsor() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: sponsorApi.activate,
		onSuccess: (s) => qc.setQueryData(sponsorQuery.queryKey, s),
	});
}

export function useRemoveSponsor() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: sponsorApi.remove,
		onSuccess: (s) => qc.setQueryData(sponsorQuery.queryKey, s),
	});
}
