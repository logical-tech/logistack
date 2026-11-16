import {
	type NetworkDevice,
	NetworkDeviceInput,
	NetworkDeviceUpdateInput,
	type NetworkPerson,
	NetworkPersonInput,
	NetworkPersonUpdateInput,
} from "@logistack/contracts";
import type { z } from "zod";
import { ApiError } from "../adapter";
import type { NetworkPeopleApi } from "../network-people";

/*
 * The house from the home DNS mock: its clients (192.168.1.x) as devices, three of them still
 * unnamed in the stats, and Luca's devices under a stricter list and a couple of domains.
 */

const delay = <T>(v: T, ms = 160 + Math.random() * 200) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

const ago = (days: number) =>
	new Date(Date.now() - days * 86_400_000).toISOString();

type Person = Omit<NetworkPerson, "devices">;
type Device = Omit<NetworkDevice, "personName">;

const none = () => ({ listUrls: [], blocked: [] });

let people: Person[] = [
	{ id: "np_anna", name: "Anna", blocking: none(), createdAt: ago(20) },
	{ id: "np_giulia", name: "Giulia", blocking: none(), createdAt: ago(20) },
	{
		id: "np_luca",
		name: "Luca (kids)",
		blocking: {
			listUrls: [
				"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/nsfw-onlydomains.txt",
			],
			blocked: ["tiktok.com", "roblox.com"],
		},
		createdAt: ago(18),
	},
];

let devices: Device[] = [
	{
		id: "nd_tv",
		name: "Living room TV",
		address: "192.168.1.21",
		personId: null,
		blocking: { listUrls: [], blocked: ["samsungads.com"] },
		createdAt: ago(19),
	},
	{
		id: "nd_giulia_phone",
		name: "Giulia's iPhone",
		address: "192.168.1.35",
		personId: "np_giulia",
		blocking: none(),
		createdAt: ago(19),
	},
	{
		id: "nd_macbook",
		name: "MacBook Pro",
		address: "192.168.1.40",
		personId: "np_anna",
		blocking: none(),
		createdAt: ago(19),
	},
	{
		id: "nd_ipad",
		name: "iPad",
		address: "192.168.1.52",
		personId: "np_luca",
		blocking: none(),
		createdAt: ago(18),
	},
	{
		id: "nd_ps5",
		name: "PlayStation",
		address: "192.168.1.60",
		personId: "np_luca",
		blocking: { listUrls: [], blocked: ["twitch.tv"] },
		createdAt: ago(18),
	},
	{
		id: "nd_echo",
		name: "Echo in the kitchen",
		address: "192.168.1.61",
		personId: null,
		blocking: none(),
		createdAt: ago(10),
	},
];

let seq = 0;

function parse<S extends z.ZodType>(schema: S, v: unknown): z.output<S> {
	const r = schema.safeParse(v);
	if (!r.success)
		throw new ApiError(
			422,
			r.error.issues[0]?.message ?? "invalid input",
			"validation_failed",
		);
	return r.data;
}

const personView = (p: Person): NetworkPerson => ({
	...p,
	devices: devices.filter((d) => d.personId === p.id).length,
});

const deviceView = (d: Device): NetworkDevice => ({
	...d,
	personName: people.find((p) => p.id === d.personId)?.name ?? null,
});

const byName = <T extends { name: string }>(a: T, b: T) =>
	a.name.localeCompare(b.name);

function checkDevice(
	v: { address?: string; personId?: string | null },
	id?: string,
) {
	if (v.address && devices.some((d) => d.address === v.address && d.id !== id))
		throw new ApiError(409, `a device already has ${v.address}`, "conflict");
	if (v.personId && !people.some((p) => p.id === v.personId))
		throw new ApiError(404, "person not found", "not_found");
}

export const mockNetworkPeople: NetworkPeopleApi = {
	people: () => delay([...people].sort(byName).map(personView)),
	addPerson: async (input) => {
		const v = parse(NetworkPersonInput, input);
		const p = { id: `np_${++seq}`, ...v, createdAt: new Date().toISOString() };
		people = [...people, p];
		return delay(personView(p));
	},
	updatePerson: async (id, input) => {
		const v = parse(NetworkPersonUpdateInput, input);
		const before = people.find((p) => p.id === id);
		if (!before) throw new ApiError(404, "person not found", "not_found");
		const p = { ...before, ...v };
		people = people.map((x) => (x.id === id ? p : x));
		return delay(personView(p));
	},
	deletePerson: async (id) => {
		people = people.filter((p) => p.id !== id);
		devices = devices.map((d) =>
			d.personId === id ? { ...d, personId: null } : d,
		);
		return delay(undefined);
	},
	devices: () => delay([...devices].sort(byName).map(deviceView)),
	addDevice: async (input) => {
		const v = parse(NetworkDeviceInput, input);
		checkDevice(v);
		const d = { id: `nd_${++seq}`, ...v, createdAt: new Date().toISOString() };
		devices = [...devices, d];
		return delay(deviceView(d));
	},
	updateDevice: async (id, input) => {
		const v = parse(NetworkDeviceUpdateInput, input);
		const before = devices.find((d) => d.id === id);
		if (!before) throw new ApiError(404, "device not found", "not_found");
		checkDevice(v, id);
		const d = { ...before, ...v };
		devices = devices.map((x) => (x.id === id ? d : x));
		return delay(deviceView(d));
	},
	deleteDevice: async (id) => {
		devices = devices.filter((d) => d.id !== id);
		return delay(undefined);
	},
};
