/* Home DNS (Technitium, instance-wide): `/network/dns/*`; `mock/home-dns.ts` serves it for VITE_API_MOCK=1. */
import type {
	HomeDns,
	HomeDnsBlocking,
	HomeDnsConsole,
	HomeDnsEnableInput,
	HomeDnsLogPage,
	HomeDnsLogQuery,
	HomeDnsRecord,
	HomeDnsRecordInput,
	HomeDnsStats,
	HomeDnsStatsRange,
	HomeDnsTestResult,
	HomeDnsUpdateInput,
	HomeDnsZone,
} from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { z } from "zod";
import { isMock } from ".";
import { useMe } from "./access";
import { client } from "./client";
import { done, ok } from "./http";

export type HomeDnsLogFilter = Partial<HomeDnsLogQuery>;
export type HomeDnsLogEntry = HomeDnsLogPage["entries"][number];
export type HomeDnsConsoleAccess = z.infer<typeof HomeDnsConsole>;
export type DomainList = "allowed" | "blocked";

export type HomeDnsApi = {
	get(): Promise<HomeDns>;
	enable(input: HomeDnsEnableInput): Promise<HomeDns>;
	update(input: HomeDnsUpdateInput): Promise<HomeDns>;
	disable(): Promise<void>;
	test(name: string): Promise<HomeDnsTestResult>;
	console(): Promise<HomeDnsConsoleAccess>;
	stats(range: HomeDnsStatsRange): Promise<HomeDnsStats>;
	logs(q: HomeDnsLogFilter): Promise<HomeDnsLogPage>;
	setBlocking(b: HomeDnsBlocking): Promise<HomeDnsBlocking>;
	refreshLists(): Promise<void>;
	list(kind: DomainList): Promise<string[]>;
	add(kind: DomainList, domain: string): Promise<void>;
	remove(kind: DomainList, domain: string): Promise<void>;
	zones(): Promise<HomeDnsZone[]>;
	createZone(name: string): Promise<HomeDnsZone>;
	deleteZone(name: string): Promise<void>;
	records(zone: string): Promise<HomeDnsRecord[]>;
	addRecord(zone: string, r: HomeDnsRecordInput): Promise<void>;
	updateRecord(zone: string, id: string, r: HomeDnsRecordInput): Promise<void>;
	deleteRecord(zone: string, id: string): Promise<void>;
};

const d = client.api.network.dns;
const lists = { allowed: d.allowed, blocked: d.blocked };

const http: HomeDnsApi = {
	get: () => ok(d.$get()),
	enable: (json) => ok(d.$post({ json })),
	update: (json) => ok(d.$patch({ json })),
	// The server always deletes the data volume now; no `purge` flag.
	disable: () => done(d.$delete({ query: {} })),
	test: (name) => ok(d.test.$post({ json: { name } })),
	console: () => ok(d.console.$post()),
	stats: (range) => ok(d.stats.$get({ query: { range } })),
	logs: (q) =>
		ok(
			d.logs.$get({
				query: Object.fromEntries(
					Object.entries(q)
						.filter(([, v]) => v !== undefined && v !== "")
						.map(([k, v]) => [k, String(v)]),
				),
			}),
		),
	setBlocking: (json) => ok(d.blocking.$put({ json })),
	refreshLists: () => done(d.blocking.refresh.$post()),
	list: (kind) => ok(lists[kind].$get()),
	add: (kind, domain) => done(lists[kind].$post({ json: { domain } })),
	remove: (kind, domain) =>
		done(lists[kind][":domain"].$delete({ param: { domain } })),
	zones: () => ok(d.zones.$get()),
	createZone: (name) => ok(d.zones.$post({ json: { name } })),
	deleteZone: (zone) => done(d.zones[":zone"].$delete({ param: { zone } })),
	records: (zone) =>
		ok(d.zones[":zone"].records.$get({ param: { zone } })) as Promise<
			HomeDnsRecord[]
		>,
	addRecord: (zone, json) =>
		done(d.zones[":zone"].records.$post({ param: { zone }, json })),
	updateRecord: (zone, id, json) =>
		done(d.zones[":zone"].records[":id"].$put({ param: { zone, id }, json })),
	deleteRecord: (zone, id) =>
		done(d.zones[":zone"].records[":id"].$delete({ param: { zone, id } })),
};

export const homeDnsApi: HomeDnsApi = isMock
	? (await import("./mock/home-dns")).mockHomeDns
	: http;

const KEY = ["home-dns"];

/** Settled states poll slowly for health; the worker's transitions poll fast. */
const settled = (h: HomeDns | undefined) =>
	!h?.enabled ||
	((h.status === "ready" || h.status === "error" || h.status === "stopped") &&
		!h.statusMessage);

export const homeDnsQuery = queryOptions({
	queryKey: KEY,
	queryFn: () => homeDnsApi.get(),
	refetchInterval: (q) => (settled(q.state.data) ? 30_000 : 2_000),
});

/** Whether the Network group and pages exist: home DNS on and an instance admin looking. */
export function useHomeDns() {
	const { data: me } = useMe();
	const admin = me?.instanceAdmin === true;
	const q = useQuery({ ...homeDnsQuery, enabled: admin });
	return { ...q, admin, me, on: admin && q.data?.enabled === true };
}

export const homeDnsStatsQuery = (range: HomeDnsStatsRange) =>
	queryOptions({
		queryKey: [...KEY, "stats", range],
		queryFn: () => homeDnsApi.stats(range),
		refetchInterval: 60_000,
	});

export const homeDnsLogsQuery = (q: HomeDnsLogFilter, live: boolean) =>
	queryOptions({
		queryKey: [...KEY, "logs", q],
		queryFn: () => homeDnsApi.logs(q),
		// While the extension installs the route answers 409; polling picks up the moment it's in.
		refetchInterval: (query) =>
			live ? 3_000 : query.state.status === "error" ? 5_000 : false,
		retry: false,
	});

export const homeDnsListQuery = (kind: DomainList) =>
	queryOptions({
		queryKey: [...KEY, "list", kind],
		queryFn: () => homeDnsApi.list(kind),
	});

export const homeDnsZonesQuery = queryOptions({
	queryKey: [...KEY, "zones"],
	queryFn: () => homeDnsApi.zones(),
});

export const homeDnsRecordsQuery = (zone: string) =>
	queryOptions({
		queryKey: [...KEY, "zones", zone, "records"],
		queryFn: () => homeDnsApi.records(zone),
	});

/** Any change refreshes everything home DNS shows; the reads are cheap. */
export function useHomeDnsMutation<A, R>(fn: (args: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
	});
}
