import type { PluginManifest } from "@logistack/contracts";
import { ApiError } from "../adapter";
import type {
	PluginContribution,
	PluginInstall,
	PluginPolicy,
	PluginsApi,
} from "../plugins";

const MASK = "••••••••";
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;
const delay = <T>(value: T, ms = 160 + Math.random() * 240): Promise<T> =>
	new Promise((r) => setTimeout(() => r(structuredClone(value)), ms));

/** examples/plugins/deploy-notifier, as the server parses it. */
const DEPLOY_ALERTS: PluginManifest = {
	id: "dev.logistack.deploy-notifier",
	version: "0.1.0",
	name: "Deploy alerts",
	description:
		"Posts failed deployments to any chat webhook that takes a JSON `text` field, and lists them.",
	author: { name: "LogiStack", url: "https://stack.logicaltech.it" },
	license: "MIT",
	port: 8080,
	resources: { memory: "96Mi", cpu: 0.1 },
	permissions: ["read"],
	egress: ["hooks.slack.com", "discord.com"],
	config: {
		type: "object",
		properties: {
			webhookUrl: {
				type: "string",
				title: "Webhook URL",
				description:
					'Receives a POST with `{ "text": … }` for each failed deploy.',
				format: "uri",
				secret: true,
			},
			mention: {
				type: "string",
				title: "Mention",
				description: "Prepended to each message, as @oncall.",
			},
			includeSucceeded: {
				type: "boolean",
				title: "Also post successful deploys",
				default: false,
			},
		},
		required: ["webhookUrl"],
	},
	contributes: {
		events: ["deployment.failed", "deployment.succeeded"],
		pages: [
			{
				id: "failures",
				title: "Deploy alerts",
				icon: "bell",
				location: "sidebar",
				path: "/ui/failures",
			},
			{
				id: "service",
				title: "Alerts",
				location: "service-tab",
				path: "/ui/service",
			},
		],
		tools: [],
		dnsProviders: [],
		notificationChannels: [],
		secretProviders: [],
		backupDestinations: [],
	},
};

/** What any other source inspects to, so the wizard can be walked end to end. */
const COST_REPORT: PluginManifest = {
	id: "com.acme.cost-report",
	version: "1.2.0",
	name: "Cost report",
	description:
		"Estimates the monthly cost of each project from node prices and the CPU and memory its services reserve.",
	author: { name: "Acme Platform Team" },
	license: "Apache-2.0",
	port: 8080,
	resources: { memory: "128Mi", cpu: 0.25 },
	permissions: ["read"],
	egress: ["api.hetzner.cloud"],
	config: {
		type: "object",
		properties: {
			provider: {
				type: "string",
				title: "Server provider",
				enum: ["hetzner", "digitalocean", "manual"],
				default: "hetzner",
			},
			apiToken: {
				type: "string",
				title: "Provider API token",
				description: "Read-only. Used to look up server prices.",
				secret: true,
			},
			currency: {
				type: "string",
				title: "Currency",
				enum: ["EUR", "USD"],
				default: "EUR",
			},
			hoursPerMonth: {
				type: "integer",
				title: "Hours per month",
				default: 730,
			},
		},
		required: ["provider"],
	},
	contributes: {
		events: [],
		pages: [
			{
				id: "overview",
				title: "Costs",
				icon: "receipt",
				location: "sidebar",
				path: "/ui/overview",
			},
			{
				id: "project",
				title: "Cost",
				location: "service-tab",
				serviceKinds: ["app", "database"],
				path: "/ui/service",
			},
		],
		tools: [
			{
				name: "monthly-cost",
				description: "The estimated monthly cost of a project.",
				inputSchema: { type: "object" },
				destructive: false,
			},
		],
		dnsProviders: [],
		notificationChannels: [],
		secretProviders: [],
		backupDestinations: [],
	},
};

function masked(
	manifest: PluginManifest,
	config: Record<string, unknown>,
): PluginInstall["config"] {
	const props = (manifest.config.properties ?? {}) as Record<
		string,
		{ secret?: boolean }
	>;
	return Object.fromEntries(
		Object.entries(config).map(([k, v]) => [k, props[k]?.secret ? MASK : v]),
	) as PluginInstall["config"];
}

let policy: PluginPolicy = "any";
let installs: PluginInstall[] = [
	{
		id: "plg_deployalerts",
		pluginId: DEPLOY_ALERTS.id,
		name: DEPLOY_ALERTS.name,
		description: DEPLOY_ALERTS.description,
		version: DEPLOY_ALERTS.version,
		image:
			"ghcr.io/logical-tech/deploy-notifier@sha256:4f1c9e7a2b8d06c3e5f7a9b1d3c5e7f90a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d",
		devUrl: null,
		manifest: DEPLOY_ALERTS,
		config: {
			webhookUrl: MASK,
			mention: "@oncall",
			includeSucceeded: false,
		},
		enabled: true,
		status: "running",
		statusMessage: null,
		serviceAccountId: "sa_plugin_deployalerts",
		serviceName: "ls-plg-deployalerts",
		createdAt: iso(9 * DAY),
		updatedAt: iso(2 * DAY),
	},
];
const storage = new Map<string, unknown>();

const find = (id: string) => {
	const row = installs.find((i) => i.id === id);
	if (!row) throw new ApiError(404, "plugin not found", "not_found");
	return row;
};

export const mockPlugins: PluginsApi = {
	list: () => delay(installs),
	get: async (id) => delay(find(id)),
	contributions: () =>
		delay(
			installs
				.filter((i) => i.enabled)
				.map(
					(i): PluginContribution => ({
						installId: i.id,
						pluginId: i.pluginId,
						pluginName: i.name,
						author: i.manifest.author?.name ?? null,
						unlisted: true,
						pages: i.manifest.contributes.pages,
					}),
				),
		),
	policy: () => delay(policy),
	setPolicy: async (next) => {
		policy = next;
		return delay(policy);
	},
	inspect: async (source) => {
		const ref = source.kind === "image" ? source.image : source.url;
		const base = ref.includes("deploy-notifier") ? DEPLOY_ALERTS : COST_REPORT;
		// An image ref with "admin" in it asks for more than the mock user holds.
		const manifest: PluginManifest = ref.includes("admin")
			? { ...base, permissions: [...base.permissions, "admin"] }
			: base;
		await delay(null, 700);
		if (ref.includes("missing"))
			throw new ApiError(
				422,
				`${ref} has no io.logistack.plugin.manifest label`,
				"invalid",
			);
		return delay({
			manifest,
			image:
				source.kind === "image"
					? `${ref.split("@")[0]?.split(":")[0]}@sha256:9d2b7c41e0a85f36b1c4d7e9a2f5083b6c1d4e7f9a2b5c8d0e3f6a9b1c4d7e0f2`
					: null,
			devUrl: source.kind === "url" ? source.url : null,
			missingPermissions: ref.includes("admin") ? ["admin"] : [],
			installedId: installs.find((i) => i.pluginId === manifest.id)?.id ?? null,
		});
	},
	create: async ({ source, config }) => {
		const inspected = await mockPlugins.inspect(source);
		const id = `plg_${Math.random().toString(36).slice(2, 10)}`;
		const row: PluginInstall = {
			id,
			pluginId: inspected.manifest.id,
			name: inspected.manifest.name,
			description: inspected.manifest.description,
			version: inspected.manifest.version,
			image: inspected.image,
			devUrl: inspected.devUrl,
			manifest: inspected.manifest,
			config: masked(inspected.manifest, config),
			enabled: true,
			status: "pending",
			statusMessage: null,
			serviceAccountId: `sa_${id}`,
			serviceName: inspected.image ? `ls-${id.replace("_", "-")}` : null,
			createdAt: iso(),
			updatedAt: iso(),
		};
		installs = [...installs, row];
		// The reconciler starts it a moment later.
		setTimeout(() => {
			row.status = "running";
		}, 2500);
		return delay({
			...row,
			...(inspected.devUrl && {
				devCredentials: {
					token: `lsk_plg_${Math.random().toString(36).slice(2, 26)}`,
					signingSecret: `whsec_${Math.random().toString(36).slice(2, 34)}`,
				},
			}),
		});
	},
	update: async (id, patch) => {
		const row = find(id);
		if (patch.config) {
			const kept = Object.fromEntries(
				Object.entries(patch.config).map(([k, v]) => [
					k,
					v === MASK ? row.config[k] : v,
				]),
			);
			row.config = masked(row.manifest, kept);
		}
		if (patch.enabled !== undefined) {
			row.enabled = patch.enabled;
			row.status = patch.enabled ? "running" : "disabled";
		}
		row.updatedAt = iso();
		return delay(row);
	},
	remove: async (id) => {
		find(id);
		installs = installs.filter((i) => i.id !== id);
		return delay(undefined);
	},
	test: async (id) => {
		const row = find(id);
		await delay(null, 600);
		const up = row.enabled && row.status === "running";
		return delay({
			ok: up,
			health: up ? { ok: true } : { ok: false, error: "not running" },
			config: up ? { ok: true } : null,
		});
	},
	session: async () =>
		delay({
			token: `eyJhbGciOiJIUzI1NiJ9.mock.${Math.random().toString(36).slice(2)}`,
			expiresAt: iso(-5 * 60_000),
		}),
	storageGet: async (id, key) => delay(storage.get(`${id}:${key}`) ?? null),
	storageSet: async (id, key, value) => {
		storage.set(`${id}:${key}`, value);
		return delay(undefined);
	},
	storageDelete: async (id, key) => {
		storage.delete(`${id}:${key}`);
		return delay(undefined);
	},
};
