/* People and devices of the home network: `/network/people`, `/network/devices`; `mock/network-people.ts` serves them for VITE_API_MOCK=1. */
import type {
	NetworkBlocking,
	NetworkDevice,
	NetworkPerson,
} from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { isMock } from ".";
import { client } from "./client";
import { useHomeDns } from "./home-dns";
import { done, ok } from "./http";

export type PersonDraft = { name: string; blocking: NetworkBlocking };
export type DeviceDraft = {
	name: string;
	address: string;
	personId: string | null;
	blocking: NetworkBlocking;
};

export type NetworkPeopleApi = {
	people(): Promise<NetworkPerson[]>;
	addPerson(p: PersonDraft): Promise<NetworkPerson>;
	updatePerson(id: string, p: Partial<PersonDraft>): Promise<NetworkPerson>;
	deletePerson(id: string): Promise<void>;
	devices(): Promise<NetworkDevice[]>;
	addDevice(d: DeviceDraft): Promise<NetworkDevice>;
	updateDevice(id: string, d: Partial<DeviceDraft>): Promise<NetworkDevice>;
	deleteDevice(id: string): Promise<void>;
};

const n = client.api.network;

const http: NetworkPeopleApi = {
	people: () => ok(n.people.$get()),
	addPerson: (json) => ok(n.people.$post({ json })),
	updatePerson: (id, json) =>
		ok(n.people[":id"].$patch({ param: { id }, json })),
	deletePerson: (id) => done(n.people[":id"].$delete({ param: { id } })),
	devices: () => ok(n.devices.$get()),
	addDevice: (json) => ok(n.devices.$post({ json })),
	updateDevice: (id, json) =>
		ok(n.devices[":id"].$patch({ param: { id }, json })),
	deleteDevice: (id) => done(n.devices[":id"].$delete({ param: { id } })),
};

export const networkPeopleApi: NetworkPeopleApi = isMock
	? (await import("./mock/network-people")).mockNetworkPeople
	: http;

const KEY = ["network-people"];

export const peopleQuery = queryOptions({
	queryKey: [...KEY, "people"],
	queryFn: () => networkPeopleApi.people(),
});

export const devicesQuery = queryOptions({
	queryKey: [...KEY, "devices"],
	queryFn: () => networkPeopleApi.devices(),
});

/** Known devices by address, for naming client IPs in stats and logs; empty while home DNS is off. */
export function useDeviceNames() {
	const { on } = useHomeDns();
	const { data } = useQuery({ ...devicesQuery, enabled: on });
	return useMemo(
		() => new Map((data ?? []).map((d) => [d.address, d])),
		[data],
	);
}

/** People and devices refresh together: a person's device count and a device's person name depend on both. */
export function useNetworkPeopleMutation<A, R>(fn: (args: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
	});
}

export { effectiveBlocking, hasBlocking } from "../network-blocking";
