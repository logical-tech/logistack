import {
	keepPreviousData,
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

const a = client.api.ai;
const pk = a["provider-keys"];
const gk = a["gateway-keys"];

export type AiSettings = InferResponseType<(typeof a.settings)["$get"], 200>;
export type AiProviderDef = AiSettings["providers"][number];
export type AiTier = AiProviderDef["tier"];
export type AiSettingsUpdate = InferRequestType<
	(typeof a.settings)["$put"]
>["json"];
export type AiProviderKey = InferResponseType<(typeof pk)["$get"], 200>[number];
export type AiProviderKeyInput = InferRequestType<(typeof pk)["$post"]>["json"];
export type AiProviderKeyPatch = InferRequestType<
	(typeof pk)[":id"]["$patch"]
>["json"];
export type AiModel = InferResponseType<(typeof a.models)["$get"], 200>[number];
export type AiGatewayKey = InferResponseType<(typeof gk)["$get"], 200>[number];
export type CreatedAiGatewayKey = InferResponseType<(typeof gk)["$post"], 201>;
export type AiBudget = InferResponseType<
	(typeof a.budgets)["$get"],
	200
>[number];
export type AiCaps = AiBudget["caps"];
export type AiUsage = InferResponseType<(typeof a.usage)["$get"], 200>;
export type AiUsageRange = AiUsage["range"];
export type AiFigures = AiUsage["totals"]["free"];
export type AiCapacity = InferResponseType<(typeof a.capacity)["$get"], 200>;

export const aiUsageRanges: AiUsageRange[] = ["24h", "7d", "30d", "90d", "12m"];

export type AiApi = {
	settings(): Promise<AiSettings>;
	updateSettings(input: AiSettingsUpdate): Promise<void>;
	providerKeys: {
		list(): Promise<AiProviderKey[]>;
		create(input: AiProviderKeyInput): Promise<AiProviderKey>;
		update(id: string, input: AiProviderKeyPatch): Promise<AiProviderKey>;
		test(id: string): Promise<AiProviderKey>;
		remove(id: string): Promise<void>;
	};
	models(): Promise<AiModel[]>;
	gatewayKeys: {
		list(): Promise<AiGatewayKey[]>;
		create(name: string): Promise<CreatedAiGatewayKey>;
		remove(id: string): Promise<void>;
	};
	budgets: {
		list(): Promise<AiBudget[]>;
		set(userId: string, caps: AiCaps): Promise<void>;
	};
	usage(range: AiUsageRange, userId?: string): Promise<AiUsage>;
	capacity(): Promise<AiCapacity>;
};

const http: AiApi = {
	settings: () => ok(a.settings.$get()),
	updateSettings: (json) => done(a.settings.$put({ json })),
	providerKeys: {
		list: () => ok(pk.$get()),
		create: (json) => ok(pk.$post({ json })),
		update: (id, json) => ok(pk[":id"].$patch({ param: { id }, json })),
		test: (id) => ok(pk[":id"].test.$post({ param: { id } })),
		remove: (id) => done(pk[":id"].$delete({ param: { id } })),
	},
	models: () => ok(a.models.$get()),
	gatewayKeys: {
		list: () => ok(gk.$get()),
		create: (name) => ok(gk.$post({ json: { name } })),
		remove: (id) => done(gk[":id"].$delete({ param: { id } })),
	},
	budgets: {
		list: () => ok(a.budgets.$get()),
		set: (userId, json) =>
			done(a.budgets[":userId"].$put({ param: { userId }, json })),
	},
	usage: (range, userId) => ok(a.usage.$get({ query: { range, userId } })),
	capacity: () => ok(a.capacity.$get()),
};

export const aiApi: AiApi = isMock ? (await import("./mock/ai")).mockAi : http;

export const aiSettingsQuery = queryOptions({
	queryKey: ["ai", "settings"],
	queryFn: () => aiApi.settings(),
	retry: false,
});
export const aiProviderKeysQuery = queryOptions({
	queryKey: ["ai", "provider-keys"],
	queryFn: () => aiApi.providerKeys.list(),
});
export const aiModelsQuery = queryOptions({
	queryKey: ["ai", "models"],
	queryFn: () => aiApi.models(),
});
export const aiGatewayKeysQuery = queryOptions({
	queryKey: ["ai", "gateway-keys"],
	queryFn: () => aiApi.gatewayKeys.list(),
});
export const aiBudgetsQuery = queryOptions({
	queryKey: ["ai", "budgets"],
	queryFn: () => aiApi.budgets.list(),
});
export const aiUsageQuery = (range: AiUsageRange) =>
	queryOptions({
		queryKey: ["ai", "usage", range],
		queryFn: () => aiApi.usage(range),
		placeholderData: keepPreviousData,
	});

export const aiCapacityQuery = queryOptions({
	queryKey: ["ai", "capacity"],
	queryFn: () => aiApi.capacity(),
});

/** A mutation that refreshes the AI views it touches. */
function useAiMutation<A, R>(fn: (args: A) => Promise<R>, keys: string[][]) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () =>
			Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k }))),
	});
}

const KEYS = [
	["ai", "provider-keys"],
	["ai", "models"],
	["ai", "capacity"],
];

export const useUpdateAiSettings = () =>
	useAiMutation(aiApi.updateSettings, [["ai", "settings"]]);
export const useCreateProviderKey = () =>
	useAiMutation(aiApi.providerKeys.create, KEYS);
export const useUpdateProviderKey = () =>
	useAiMutation(
		(v: { id: string; input: AiProviderKeyPatch }) =>
			aiApi.providerKeys.update(v.id, v.input),
		KEYS,
	);
export const useTestProviderKey = () =>
	useAiMutation(aiApi.providerKeys.test, KEYS);
export const useRemoveProviderKey = () =>
	useAiMutation(aiApi.providerKeys.remove, KEYS);
export const useCreateGatewayKey = () =>
	useAiMutation(aiApi.gatewayKeys.create, [["ai", "gateway-keys"]]);
export const useRemoveGatewayKey = () =>
	useAiMutation(aiApi.gatewayKeys.remove, [["ai", "gateway-keys"]]);
export const useSetBudget = () =>
	useAiMutation(
		(v: { userId: string; caps: AiCaps }) =>
			aiApi.budgets.set(v.userId, v.caps),
		[
			["ai", "budgets"],
			["ai", "settings"],
		],
	);

/** "$12.40", "$0.0042" for sub-cent values, "$0" for nothing. */
export function formatUsd(n: number): string {
	if (n === 0) return "$0";
	const abs = Math.abs(n);
	const digits = abs >= 100 ? 0 : abs >= 0.1 ? 2 : abs >= 0.01 ? 3 : 4;
	return `$${n.toFixed(digits)}`;
}

/** 1234 -> "1.2K", 1_200_000 -> "1.2M". */
export const formatCount = (n: number) =>
	new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(n);

/** The gateway's base URL, as clients configure it. */
export const gatewayBaseUrl = () => `${window.location.origin}/v1`;
