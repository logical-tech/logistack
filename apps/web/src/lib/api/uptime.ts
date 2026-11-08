/* Uptime monitors, incidents, maintenance windows and status pages: straight to the API.
 * Mock mode serves the fixtures in ./mock/uptime.ts so the pages and docs screenshots have content. */
import { queryOptions } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

type Api = typeof client.api;
type Monitors = Api["monitors"];
type Incidents = Api["incidents"];
type Windows = Api["maintenance-windows"];
type Pages = Api["status-pages"];

export type Monitor = InferResponseType<Monitors["$get"], 200>[number];
export type MonitorDetail = InferResponseType<Monitors[":id"]["$get"], 200>;
export type MonitorCreated = InferResponseType<Monitors["$post"], 201>;
export type MonitorInput = InferRequestType<Monitors["$post"]>["json"];
export type MonitorPatch = InferRequestType<Monitors[":id"]["$patch"]>["json"];
export type MonitorConfig = MonitorInput["config"];
export type MonitorKind = MonitorConfig["kind"];
export type MonitorStatus = Monitor["status"];
export type Suggestion = InferResponseType<
	Monitors["suggestions"]["$get"],
	200
>[number];
export type CheckTest = InferResponseType<Monitors["test"]["$post"], 200>;
export type Incident = InferResponseType<Incidents["$get"], 200>[number];
export type IncidentInput = InferRequestType<Incidents["$post"]>["json"];
export type IncidentStatus = Incident["status"];
export type IncidentImpact = Incident["impact"];
export type IncidentUpdateInput = InferRequestType<
	Incidents[":id"]["updates"]["$post"]
>["json"];
export type MaintenanceWindow = InferResponseType<Windows["$get"], 200>[number];
export type MaintenanceInput = InferRequestType<Windows["$post"]>["json"];
export type StatusPage = InferResponseType<Pages["$get"], 200>[number];
export type StatusPageInput = InferRequestType<Pages["$post"]>["json"];
export type StatusPagePatch = InferRequestType<Pages[":id"]["$patch"]>["json"];
export type UptimeDay = MonitorDetail["bars"][number];

const mock = () => import("./mock/uptime");

// Monitors move every check; a minute-old list is wrong about the one that just went down.
const POLL = 15_000;

export const monitorsQuery = queryOptions({
	queryKey: ["monitors"],
	queryFn: async (): Promise<Monitor[]> =>
		isMock ? (await mock()).monitors : ok(client.api.monitors.$get()),
	refetchInterval: POLL,
});

export const monitorQuery = (id: string) =>
	queryOptions({
		queryKey: ["monitors", id],
		queryFn: async (): Promise<MonitorDetail> =>
			isMock
				? (await mock()).monitorDetail(id)
				: ok(client.api.monitors[":id"].$get({ param: { id } })),
		refetchInterval: POLL,
	});

export const suggestionsQuery = queryOptions({
	queryKey: ["monitors", "suggestions"],
	queryFn: async (): Promise<Suggestion[]> =>
		isMock
			? (await mock()).suggestions
			: ok(client.api.monitors.suggestions.$get()),
});

export const incidentsQuery = queryOptions({
	queryKey: ["incidents"],
	queryFn: async (): Promise<Incident[]> =>
		isMock ? (await mock()).incidents : ok(client.api.incidents.$get()),
	refetchInterval: 30_000,
});

export const maintenanceQuery = queryOptions({
	queryKey: ["maintenance-windows"],
	queryFn: async (): Promise<MaintenanceWindow[]> =>
		isMock
			? (await mock()).windows
			: ok(client.api["maintenance-windows"].$get()),
});

export const statusPagesQuery = queryOptions({
	queryKey: ["status-pages"],
	queryFn: async (): Promise<StatusPage[]> =>
		isMock ? (await mock()).pages : ok(client.api["status-pages"].$get()),
});

/** Mutations do nothing in mock mode beyond echoing a fixture, so flows can be clicked through. */
const echo = async <T>(pick: (m: Awaited<ReturnType<typeof mock>>) => T) =>
	pick(await mock());

export const uptimeApi = {
	createMonitor: (json: MonitorInput): Promise<MonitorCreated> =>
		isMock
			? echo((m) => ({
					...(m.monitors[0] as Monitor),
					name: json.name,
					...(json.config.kind === "push" && { pushToken: "lsp_mock" }),
				}))
			: ok(client.api.monitors.$post({ json })),
	updateMonitor: ({ id, json }: { id: string; json: MonitorPatch }) =>
		isMock
			? echo((m) => m.monitors[0] as Monitor)
			: ok(client.api.monitors[":id"].$patch({ param: { id }, json })),
	removeMonitor: (id: string) =>
		isMock
			? Promise.resolve()
			: done(client.api.monitors[":id"].$delete({ param: { id } })),
	testMonitor: (json: {
		config: MonitorConfig;
		timeoutMs?: number;
	}): Promise<CheckTest> =>
		isMock
			? Promise.resolve({ ok: true, latencyMs: 142 })
			: ok(client.api.monitors.test.$post({ json })),
	rotatePushToken: (id: string) =>
		isMock
			? Promise.resolve({ pushToken: "lsp_mock_rotated" })
			: ok(client.api.monitors[":id"]["push-token"].$post({ param: { id } })),
	createIncident: (json: IncidentInput) =>
		isMock
			? echo((m) => m.incidents[0] as Incident)
			: ok(client.api.incidents.$post({ json })),
	postIncidentUpdate: ({
		id,
		json,
	}: {
		id: string;
		json: IncidentUpdateInput;
	}) =>
		isMock
			? echo((m) => m.incidents[0] as Incident)
			: ok(client.api.incidents[":id"].updates.$post({ param: { id }, json })),
	removeIncident: (id: string) =>
		isMock
			? Promise.resolve()
			: done(client.api.incidents[":id"].$delete({ param: { id } })),
	createWindow: (json: MaintenanceInput) =>
		isMock
			? echo((m) => m.windows[0] as MaintenanceWindow)
			: ok(client.api["maintenance-windows"].$post({ json })),
	removeWindow: (id: string) =>
		isMock
			? Promise.resolve()
			: done(
					client.api["maintenance-windows"][":id"].$delete({ param: { id } }),
				),
	createPage: (json: StatusPageInput) =>
		isMock
			? echo((m) => m.pages[0] as StatusPage)
			: ok(client.api["status-pages"].$post({ json })),
	updatePage: ({ id, json }: { id: string; json: StatusPagePatch }) =>
		isMock
			? echo((m) => m.pages[0] as StatusPage)
			: ok(client.api["status-pages"][":id"].$patch({ param: { id }, json })),
	removePage: (id: string) =>
		isMock
			? Promise.resolve()
			: done(client.api["status-pages"][":id"].$delete({ param: { id } })),
};

/** What the monitor checks, in one line. */
export function monitorTarget(c: MonitorConfig): string {
	switch (c.kind) {
		case "http":
			return c.http.url;
		case "tcp":
			return `${c.tcp.host}:${c.tcp.port}`;
		case "dns":
			return `${c.dns.recordType} ${c.dns.hostname}`;
		case "tls":
			return `${c.tls.host}:${c.tls.port}`;
		case "push":
			return "Push from a job";
	}
}

export const KIND_LABEL: Record<MonitorKind, string> = {
	http: "HTTP",
	tcp: "TCP",
	dns: "DNS",
	tls: "Certificate",
	push: "Push",
};

/** Whole days until `iso`, rounded down; negative once past. */
export const daysUntil = (iso: string, now = Date.now()) =>
	Math.floor((new Date(iso).getTime() - now) / 86_400_000);

/** Where a push token waits, in memory only, for the monitor page to show it once. */
export const pushTokenKey = (id: string) => ["push-token", id];

export const pushUrl = (token: string) =>
	`${typeof location === "undefined" ? "" : location.origin}/push/${token}`;

/** Public URL of a status page: its own hostname when it has one. */
export const statusPageUrl = (p: Pick<StatusPage, "hostname" | "slug">) =>
	p.hostname
		? `https://${p.hostname}`
		: `${typeof location === "undefined" ? "" : location.origin}/status/${p.slug}`;

export const badgeUrl = (
	p: Pick<StatusPage, "hostname" | "slug">,
	monitorId: string,
	type: "status" | "uptime",
) =>
	p.hostname
		? `https://${p.hostname}/badge/${monitorId}.svg?type=${type}${type === "uptime" ? "&days=30" : ""}`
		: `${statusPageUrl(p)}/badge/${monitorId}.svg?type=${type}${type === "uptime" ? "&days=30" : ""}`;
