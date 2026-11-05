/*
 * DNS providers, domains, certificates and notifications: wire types inferred from the
 * server's routes, the adapter slice both implementations fill, and the query hooks.
 */
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import type { StatusCode } from "hono/utils/http-status";
import { api } from ".";
import { client, setupHeader } from "./client";
import { done, ok } from "./http";

type Api = typeof client.api;
type Res<F, S extends StatusCode = 200> = InferResponseType<F, S>;
type Body<F> = InferRequestType<F> extends { json: infer J } ? J : never;

export type IntegrationSchemas = Res<Api["integrations"]["schemas"]["$get"]>;
export type DnsProvider = Res<Api["dns-providers"]["$get"]>[number];
export type DnsKind = DnsProvider["kind"];
export type DnsZone = DnsProvider["zones"][number];
export type DnsMatch = Res<Api["services"][":id"]["dns-match"]["$get"]>;
export type DnsRecord = Res<Api["services"][":id"]["dns-records"]["$post"]>;
export type RecordInput = Body<Api["services"][":id"]["dns-records"]["$post"]>;
export type Propagation = Res<
	Api["services"][":id"]["dns-propagation"]["$post"]
>;
export type CreateDnsProvider = Body<Api["dns-providers"]["$post"]>;
type RecordsApi = Api["dns-providers"][":id"]["zones"][":zoneId"]["records"];
export type ZoneRecords = Res<RecordsApi["$get"]>;
export type DnsRecordSet = ZoneRecords["records"][number];
export type RecordSetBody = Body<RecordsApi["$post"]>;
export type UpdateDnsProvider = Body<Api["dns-providers"][":id"]["$patch"]>;

export type DomainListItem = Res<Api["domains"]["$get"]>[number];
export type DomainBody = Body<Api["services"][":id"]["domains"]["$post"]>;
export type TlsMode = DomainListItem["tls"];

export type Certificates = Res<Api["certificates"]["$get"]>;
export type CustomCertificate = Certificates["custom"][number];
export type ManagedCertificate = Certificates["managed"][number];
export type ParsedCertificate = Res<Api["certificates"]["inspect"]["$post"]>;
export type UploadCertificate = Body<Api["certificates"]["$post"]>;
export type AcmeDirectory = Res<
	Api["certificates"]["issuer"]["$get"]
>["directory"];

export type Channel = Res<Api["notification-channels"]["$get"]>[number];
export type ChannelKind = Channel["kind"];
export type CreateChannel = Body<Api["notification-channels"]["$post"]>;
export type Rule = Res<Api["notification-rules"]["$get"]>[number];
export type RuleInput = Body<Api["notification-rules"]["$post"]>;
export type EventType = Rule["events"][number];

export type SetupDnsCheck = Body<Api["setup"]["dns-provider-check"]["$post"]>;

export type NetworkingApi = {
	schemas(): Promise<IntegrationSchemas>;
	dns: {
		list(): Promise<DnsProvider[]>;
		test(
			kind: DnsKind,
			credentials: Record<string, unknown>,
		): Promise<{ zones: DnsZone[] }>;
		create(input: CreateDnsProvider): Promise<DnsProvider>;
		update(id: string, patch: UpdateDnsProvider): Promise<DnsProvider>;
		remove(id: string): Promise<void>;
		zones(id: string): Promise<{ zones: DnsZone[] }>;
		records(id: string, zoneId: string): Promise<ZoneRecords>;
		createRecord(
			id: string,
			zoneId: string,
			body: RecordSetBody,
		): Promise<DnsRecordSet>;
		updateRecord(
			id: string,
			zoneId: string,
			recordId: string,
			body: RecordSetBody,
		): Promise<DnsRecordSet>;
		removeRecord(id: string, zoneId: string, recordId: string): Promise<void>;
		match(serviceId: string, hostname: string): Promise<DnsMatch>;
		upsertRecord(serviceId: string, input: RecordInput): Promise<DnsRecord>;
		propagation(
			serviceId: string,
			input: Omit<RecordInput, "proxied" | "dnsProviderId">,
		): Promise<Propagation>;
		setupCheck(
			input: SetupDnsCheck,
			setupToken: string,
		): Promise<{ zone: DnsZone }>;
	};
	domains: {
		list(): Promise<DomainListItem[]>;
		create(serviceId: string, body: DomainBody): Promise<{ id: string }>;
		update(id: string, body: DomainBody): Promise<{ id: string }>;
		remove(id: string): Promise<void>;
	};
	certificates: {
		list(): Promise<Certificates>;
		inspect(certPem: string, privateKey: string): Promise<ParsedCertificate>;
		create(input: UploadCertificate): Promise<CustomCertificate>;
		remove(id: string): Promise<void>;
		issuer(): Promise<{ directory: AcmeDirectory }>;
		setIssuer(directory: AcmeDirectory): Promise<{ directory: AcmeDirectory }>;
	};
	notifications: {
		channels(): Promise<Channel[]>;
		testConfig(
			kind: ChannelKind,
			config: Record<string, unknown>,
		): Promise<void>;
		createChannel(input: CreateChannel): Promise<Channel>;
		testChannel(id: string): Promise<void>;
		removeChannel(id: string): Promise<void>;
		rules(): Promise<Rule[]>;
		createRule(input: RuleInput): Promise<Rule>;
		updateRule(id: string, input: RuleInput): Promise<Rule>;
		removeRule(id: string): Promise<void>;
	};
};

const a = () => client.api;

const id = (v: string) => ({ param: { id: v } });

export const networkingHttp: NetworkingApi = {
	schemas: () => ok(a().integrations.schemas.$get()),
	dns: {
		list: () => ok(a()["dns-providers"].$get()),
		test: (kind, credentials) =>
			ok(a()["dns-providers"].test.$post({ json: { kind, credentials } })),
		create: (json) => ok(a()["dns-providers"].$post({ json })),
		update: (v, json) =>
			ok(a()["dns-providers"][":id"].$patch({ ...id(v), json })),
		remove: (v) => done(a()["dns-providers"][":id"].$delete(id(v))),
		zones: (v) => ok(a()["dns-providers"][":id"].zones.$get(id(v))),
		records: (v, zoneId) =>
			ok(
				a()["dns-providers"][":id"].zones[":zoneId"].records.$get({
					param: { id: v, zoneId },
				}),
			),
		createRecord: (v, zoneId, json) =>
			ok(
				a()["dns-providers"][":id"].zones[":zoneId"].records.$post({
					param: { id: v, zoneId },
					json,
				}),
			),
		// The client splices params in raw; Route 53 and Hetzner ids carry a slash.
		updateRecord: (v, zoneId, recordId, json) =>
			ok(
				a()["dns-providers"][":id"].zones[":zoneId"].records[":recordId"].$put({
					param: { id: v, zoneId, recordId: encodeURIComponent(recordId) },
					json,
				}),
			),
		removeRecord: (v, zoneId, recordId) =>
			done(
				a()["dns-providers"][":id"].zones[":zoneId"].records[
					":recordId"
				].$delete({
					param: { id: v, zoneId, recordId: encodeURIComponent(recordId) },
				}),
			),
		match: (serviceId, hostname) =>
			ok(
				a().services[":id"]["dns-match"].$get({
					...id(serviceId),
					query: { hostname },
				}),
			),
		upsertRecord: (serviceId, json) =>
			ok(a().services[":id"]["dns-records"].$post({ ...id(serviceId), json })),
		propagation: (serviceId, json) =>
			ok(
				a().services[":id"]["dns-propagation"].$post({
					...id(serviceId),
					json,
				}),
			),
		setupCheck: (json, setupToken) =>
			ok(
				a().setup["dns-provider-check"].$post({
					json,
					header: setupHeader(setupToken),
				}),
			),
	},
	domains: {
		list: () => ok(a().domains.$get()),
		create: (serviceId, json) =>
			ok(a().services[":id"].domains.$post({ ...id(serviceId), json })),
		update: (v, json) => ok(a().domains[":id"].$put({ ...id(v), json })),
		remove: (v) => done(a().domains[":id"].$delete(id(v))),
	},
	certificates: {
		list: () => ok(a().certificates.$get()),
		inspect: (certPem, privateKey) =>
			ok(a().certificates.inspect.$post({ json: { certPem, privateKey } })),
		create: (json) => ok(a().certificates.$post({ json })),
		remove: (v) => done(a().certificates[":id"].$delete(id(v))),
		issuer: () => ok(a().certificates.issuer.$get()),
		setIssuer: (directory) =>
			ok(a().certificates.issuer.$put({ json: { directory } })),
	},
	notifications: {
		channels: () => ok(a()["notification-channels"].$get()),
		testConfig: async (kind, config) => {
			await ok(
				a()["notification-channels"].test.$post({ json: { kind, config } }),
			);
		},
		createChannel: (json) => ok(a()["notification-channels"].$post({ json })),
		testChannel: async (v) => {
			await ok(a()["notification-channels"][":id"].test.$post(id(v)));
		},
		removeChannel: (v) =>
			done(a()["notification-channels"][":id"].$delete(id(v))),
		rules: () => ok(a()["notification-rules"].$get()),
		createRule: (json) => ok(a()["notification-rules"].$post({ json })),
		updateRule: (v, json) =>
			ok(a()["notification-rules"][":id"].$put({ ...id(v), json })),
		removeRule: (v) => done(a()["notification-rules"][":id"].$delete(id(v))),
	},
};

// Queries

export const schemasQuery = queryOptions({
	queryKey: ["integrations", "schemas"],
	queryFn: () => api.networking.schemas(),
	staleTime: Number.POSITIVE_INFINITY,
});

export const dnsProvidersQuery = queryOptions({
	queryKey: ["dns-providers"],
	queryFn: () => api.networking.dns.list(),
});

export const zoneRecordsQuery = (id: string, zoneId: string) =>
	queryOptions({
		queryKey: ["dns-providers", id, "zones", zoneId, "records"],
		queryFn: () => api.networking.dns.records(id, zoneId),
	});

export const domainsQuery = queryOptions({
	queryKey: ["domains"],
	queryFn: () => api.networking.domains.list(),
	// Status flips pending → active when the worker's sync lands; keep it fresh.
	refetchInterval: 5_000,
});

export const certificatesQuery = queryOptions({
	queryKey: ["certificates"],
	queryFn: () => api.networking.certificates.list(),
});

export const issuerQuery = queryOptions({
	queryKey: ["certificates", "issuer"],
	queryFn: () => api.networking.certificates.issuer(),
});

export const channelsQuery = queryOptions({
	queryKey: ["notification-channels"],
	queryFn: () => api.networking.notifications.channels(),
	refetchInterval: 15_000,
});

export const rulesQuery = queryOptions({
	queryKey: ["notification-rules"],
	queryFn: () => api.networking.notifications.rules(),
});

/** A mutation that refreshes the listed query keys once it lands. */
export function useInvalidating<A, R>(
	fn: (args: A) => Promise<R>,
	keys: string[][],
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () =>
			Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))),
	});
}
