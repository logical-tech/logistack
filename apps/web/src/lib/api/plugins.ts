/*
 * Plugins (docs/plans/plugins.md): installs, the instance policy, the pages enabled
 * installs contribute, and what a plugin page needs from the host bridge.
 */
import type { PluginManifest } from "@logistack/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";

const p = client.api.plugins;
type One = (typeof p)[":id"];

/** The server types the manifest as a record; it parsed it with `PluginManifest` already. */
export type PluginInstall = Omit<
	InferResponseType<(typeof p)["$get"], 200>[number],
	"manifest"
> & { manifest: PluginManifest };
export type CreatedPlugin = PluginInstall & {
	devCredentials?: { token: string; signingSecret: string };
};
export type PluginInspection = Omit<
	InferResponseType<(typeof p)["inspect"]["$post"], 200>,
	"manifest"
> & { manifest: PluginManifest };
export type PluginSource = InferRequestType<
	(typeof p)["inspect"]["$post"]
>["json"];
export type PluginContribution = InferResponseType<
	(typeof p)["contributions"]["$get"],
	200
>[number];
export type PluginPolicySettings = InferResponseType<
	(typeof p)["policy"]["$get"],
	200
>;
export type PluginPolicy = PluginPolicySettings["policy"];
export type PluginMarketplace = InferResponseType<
	(typeof p)["marketplace"]["$get"],
	200
>;
export type PluginIndex = PluginMarketplace["indexes"][number];
/** The server types the manifest as a record; it parsed it with `PluginManifest` already. */
export type PluginMarketEntry = Omit<
	PluginMarketplace["entries"][number],
	"latest"
> & {
	latest: Omit<PluginMarketplace["entries"][number]["latest"], "manifest"> & {
		manifest: PluginManifest;
	};
};
export type PluginUpdates = InferResponseType<One["updates"]["$get"], 200>;
export type PluginUpdate = PluginUpdates["versions"][number];
export type PluginTestResult = InferResponseType<One["test"]["$post"], 200>;
export type PluginSession = InferResponseType<One["session"]["$get"], 200>;
export type PluginContext = { serviceId?: string; projectId?: string };

export type PluginsApi = {
	list(): Promise<PluginInstall[]>;
	get(id: string): Promise<PluginInstall>;
	contributions(): Promise<PluginContribution[]>;
	policy(): Promise<PluginPolicySettings>;
	setPolicy(
		patch: Partial<PluginPolicySettings>,
	): Promise<PluginPolicySettings>;
	/** Cached entries; an index older than an hour is fetched first. */
	marketplace(): Promise<{
		policy: PluginPolicy;
		indexes: PluginIndex[];
		entries: PluginMarketEntry[];
	}>;
	addIndex(input: {
		url: string;
		name?: string;
		publicKeys: string[];
	}): Promise<PluginIndex>;
	removeIndex(id: string): Promise<void>;
	refreshIndex(id: string): Promise<PluginIndex>;
	updates(id: string): Promise<PluginUpdates>;
	/** Added permissions need `acceptPermissions`; the plugin gets a new API token. */
	updateVersion(
		id: string,
		input: { version: string; acceptPermissions: boolean },
	): Promise<PluginInstall>;
	rollback(id: string): Promise<PluginInstall>;
	inspect(source: PluginSource): Promise<PluginInspection>;
	create(input: {
		source: PluginSource;
		config: Record<string, unknown>;
	}): Promise<CreatedPlugin>;
	/** `enabled: false` is the kill switch; a masked secret in `config` keeps the stored one. */
	update(
		id: string,
		patch: { config?: Record<string, unknown>; enabled?: boolean },
	): Promise<PluginInstall>;
	remove(id: string): Promise<void>;
	test(id: string): Promise<PluginTestResult>;
	session(id: string, context: PluginContext): Promise<PluginSession>;
	storageGet(id: string, key: string): Promise<unknown>;
	storageSet(id: string, key: string, value: unknown): Promise<void>;
	storageDelete(id: string, key: string): Promise<void>;
};

const http: PluginsApi = {
	list: async () => (await ok(p.$get())) as PluginInstall[],
	get: async (id) =>
		(await ok(p[":id"].$get({ param: { id } }))) as PluginInstall,
	contributions: () => ok(p.contributions.$get()),
	policy: () => ok(p.policy.$get()),
	setPolicy: (json) => ok(p.policy.$put({ json })),
	marketplace: async () =>
		(await ok(p.marketplace.$get())) as Awaited<
			ReturnType<PluginsApi["marketplace"]>
		>,
	addIndex: (json) => ok(p.indexes.$post({ json })),
	removeIndex: (id) => done(p.indexes[":id"].$delete({ param: { id } })),
	refreshIndex: (id) => ok(p.indexes[":id"].refresh.$post({ param: { id } })),
	updates: (id) => ok(p[":id"].updates.$get({ param: { id } })),
	updateVersion: async (id, json) =>
		(await ok(p[":id"].update.$post({ param: { id }, json }))) as PluginInstall,
	rollback: async (id) =>
		(await ok(p[":id"].rollback.$post({ param: { id } }))) as PluginInstall,
	inspect: async (json) =>
		(await ok(p.inspect.$post({ json }))) as PluginInspection,
	create: async (json) => (await ok(p.$post({ json }))) as CreatedPlugin,
	update: async (id, json) =>
		(await ok(p[":id"].$patch({ param: { id }, json }))) as PluginInstall,
	remove: (id) => done(p[":id"].$delete({ param: { id } })),
	test: (id) => ok(p[":id"].test.$post({ param: { id } })),
	session: (id, query) => ok(p[":id"].session.$get({ param: { id }, query })),
	storageGet: async (id, key) =>
		(await ok(p[":id"].storage[":key"].$get({ param: { id, key } }))).value,
	storageSet: (id, key, value) =>
		done(
			p[":id"].storage[":key"].$put({ param: { id, key }, json: { value } }),
		),
	storageDelete: (id, key) =>
		done(p[":id"].storage[":key"].$delete({ param: { id, key } })),
};

export const pluginsApi: PluginsApi = isMock
	? (await import("./mock/plugins")).mockPlugins
	: http;

export const pluginsQuery = queryOptions({
	queryKey: ["plugins"],
	queryFn: () => pluginsApi.list(),
});

export const pluginQuery = (id: string) =>
	queryOptions({
		queryKey: ["plugins", id],
		queryFn: () => pluginsApi.get(id),
	});

/** The sidebar and service tabs read this; it changes only on install, toggle or uninstall. */
export const pluginContributionsQuery = queryOptions({
	queryKey: ["plugins", "contributions"],
	queryFn: () => pluginsApi.contributions(),
	staleTime: 60_000,
});

export const pluginPolicyQuery = queryOptions({
	queryKey: ["plugins", "policy"],
	queryFn: () => pluginsApi.policy(),
});

export const pluginMarketplaceQuery = queryOptions({
	queryKey: ["plugins", "marketplace"],
	queryFn: () => pluginsApi.marketplace(),
});

export const pluginUpdatesQuery = (id: string) =>
	queryOptions({
		queryKey: ["plugins", id, "updates"],
		queryFn: () => pluginsApi.updates(id),
	});
