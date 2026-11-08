/* Log drains: straight to the API; mock mode shows a fixed pair for design work and screenshots. */
import { queryOptions } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

type Api = typeof client.api;
export type LogDrain = InferResponseType<
	Api["log-drains"]["$get"],
	200
>[number];
export type CreateLogDrain = InferRequestType<
	Api["log-drains"]["$post"]
>["json"];
export type UpdateLogDrain = InferRequestType<
	Api["log-drains"][":id"]["$patch"]
>["json"];

const node = (
	state: "ok" | "failing",
	hostname: string,
	lastError: string | null,
) => ({
	drainId: "",
	nodeId: `nod_${hostname}`,
	hostname,
	at: Date.now(),
	state,
	lastSuccessAt: Date.now() - (state === "ok" ? 4_000 : 3_600_000),
	lastFailureAt: state === "failing" ? Date.now() - 20_000 : null,
	lastError,
	sentLines: 184_220,
	droppedLines: state === "failing" ? 1_840 : 0,
	queuedLines: state === "failing" ? 41_002 : 12,
	queuedBytes: state === "failing" ? 8_100_000 : 2_048,
});

const MOCK: LogDrain[] = [
	{
		id: "lgd_loki",
		name: "Grafana Cloud",
		kind: "loki",
		target: "https://logs-prod-012.grafana.net/loki/api/v1/push",
		enabled: true,
		projectIds: ["prj_storefront", "prj_backoffice"],
		serviceIds: [],
		health: "healthy",
		nodes: [node("ok", "fra-1", null), node("ok", "fra-2", null)],
		createdAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
	},
	{
		id: "lgd_dd",
		name: "Datadog EU",
		kind: "datadog",
		target: "http-intake.logs.datadoghq.eu",
		enabled: true,
		projectIds: [],
		serviceIds: ["svc_checkout", "svc_payments", "svc_search"],
		health: "degraded",
		nodes: [node("ok", "fra-1", null), node("failing", "fra-2", "HTTP 403")],
		createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
	},
];

export const logDrainsQuery = queryOptions({
	queryKey: ["log-drains"],
	queryFn: (): Promise<LogDrain[]> =>
		isMock ? Promise.resolve(MOCK) : ok(client.api["log-drains"].$get()),
	// Agents report every 15 s.
	refetchInterval: 15_000,
});

export const logDrainsApi = {
	create: (json: CreateLogDrain) =>
		ok(client.api["log-drains"].$post({ json })),
	update: ({ id, ...json }: UpdateLogDrain & { id: string }) =>
		ok(client.api["log-drains"][":id"].$patch({ param: { id }, json })),
	remove: (id: string) =>
		done(client.api["log-drains"][":id"].$delete({ param: { id } })),
	testConfig: (config: unknown) =>
		ok(client.api["log-drains"].test.$post({ json: { config } })),
	test: (id: string) =>
		ok(
			client.api["log-drains"][":id"].test.$post({ param: { id }, query: {} }),
		),
};
