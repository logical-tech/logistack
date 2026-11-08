import type { PluginManifest } from "@logistack/contracts";
import { ApiError } from "../adapter";
import type {
	PluginContribution,
	PluginIndex,
	PluginInstall,
	PluginMarketEntry,
	PluginPolicySettings,
	PluginsApi,
	PluginUpdate,
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
			{
				id: "project",
				title: "Deploy alerts",
				location: "project-tab",
				path: "/ui/project",
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

/** Deploy alerts 0.2.0: posts back to the deploy and talks to one more host. */
const DEPLOY_ALERTS_NEXT: PluginManifest = {
	...DEPLOY_ALERTS,
	version: "0.2.0",
	permissions: ["read", "write"],
	egress: [...DEPLOY_ALERTS.egress, "api.telegram.org"],
};

const HETZNER_DNS: PluginManifest = {
	...COST_REPORT,
	id: "dev.logistack.hetzner-dns",
	version: "1.0.3",
	name: "Hetzner DNS",
	description:
		"Manages records in Hetzner DNS, so certificates can use DNS-01 and wildcards.",
	author: { name: "LogiStack", url: "https://stack.logicaltech.it" },
	license: "MIT",
	permissions: [],
	egress: ["dns.hetzner.com"],
	config: {
		type: "object",
		properties: {
			apiToken: { type: "string", title: "API token", secret: true },
		},
		required: ["apiToken"],
	},
	contributes: { ...COST_REPORT.contributes, pages: [], tools: [] },
};

const digest = (seed: string) =>
	`sha256:${seed
		.repeat(64)
		.slice(0, 64)
		.replace(/[^a-f0-9]/g, "a")}`;

let settings: PluginPolicySettings = { policy: "any", installPing: false };
let indexes: PluginIndex[] = [
	{
		id: "pidx_official",
		url: "https://stack.logicaltech.it/plugins/api",
		name: "LogiStack",
		builtin: true,
		publicKeys: ["Yl3rT0bXq2CkV9Pp7mZ8wA1sE4uH6jN5oR2dF3gK7cL"],
		fetchedAt: iso(20 * 60_000),
		lastError: null,
		plugins: 2,
	},
	{
		id: "pidx_acme",
		url: "https://plugins.acme.internal/api",
		name: "Acme internal",
		builtin: false,
		publicKeys: ["Qm4nB8vC2xZ6lK1jH9gF5dS3aP7oI0uY4tR8eW2qE6r"],
		fetchedAt: iso(3 * DAY),
		lastError: null,
		plugins: 1,
	},
];
const entry = (
	indexId: string,
	m: PluginManifest,
	verified: boolean,
	extra: Partial<PluginMarketEntry> = {},
): PluginMarketEntry => ({
	indexId,
	indexName: indexes.find((i) => i.id === indexId)?.name ?? "",
	id: m.id,
	name: m.name,
	description: m.description,
	author: m.author?.name ?? null,
	publisher: m.author?.name ?? "Unknown",
	installs: verified ? 214 : 3,
	iconUrl: null,
	verified,
	latestVerified: verified ? m.version : null,
	latest: {
		version: m.version,
		image: `ghcr.io/acme/${m.id}@${digest(m.id.length.toString(16))}`,
		changelog: null,
		publishedAt: iso(6 * DAY),
		manifest: m,
	},
	compatible: true,
	installed: null,
	...extra,
});
const entries = (): PluginMarketEntry[] =>
	[
		entry("pidx_official", DEPLOY_ALERTS_NEXT, true),
		entry("pidx_official", HETZNER_DNS, true),
		entry("pidx_acme", COST_REPORT, false),
	].map((e) => {
		const i = installs.find((x) => x.pluginId === e.id);
		return {
			...e,
			installed: i
				? { installId: i.id, version: i.version, indexId: i.indexId }
				: null,
		};
	});
const UPDATES: Record<string, PluginUpdate[]> = {
	[DEPLOY_ALERTS.id]: [
		{
			version: "0.2.0",
			changelog:
				"- Marks the failed deployment with a link back to the chat thread.\n- Telegram as a target.",
			publishedAt: iso(6 * DAY),
			verified: true,
			compatible: true,
			permissions: { added: ["write"], removed: [] },
			egress: { added: ["api.telegram.org"], removed: [] },
			missingPermissions: [],
		},
	],
};
const MANIFESTS: Record<string, PluginManifest> = {
	[`${DEPLOY_ALERTS.id}@0.2.0`]: DEPLOY_ALERTS_NEXT,
	[`${DEPLOY_ALERTS.id}@0.1.0`]: DEPLOY_ALERTS,
};
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
		indexId: "pidx_official",
		verified: true,
		yanked: false,
		previousVersion: null,
		gate: { timeoutSeconds: 10, failMode: "closed" },
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
						unlisted: !i.indexId,
						pages: i.manifest.contributes.pages,
						providers: {
							dnsProviders: i.manifest.contributes.dnsProviders,
							notificationChannels: i.manifest.contributes.notificationChannels,
							secretProviders: i.manifest.contributes.secretProviders,
						} as PluginContribution["providers"],
					}),
				),
		),
	policy: () => delay(settings),
	setPolicy: async (patch) => {
		settings = { ...settings, ...patch };
		return delay(settings);
	},
	marketplace: () =>
		delay({ policy: settings.policy, indexes, entries: entries() }, 500),
	addIndex: async ({ url, name, publicKeys }) => {
		await delay(null, 700);
		if (url.includes("bad"))
			throw new ApiError(
				400,
				"the index signed with a key this instance does not trust",
				"bad_request",
			);
		const row: PluginIndex = {
			id: `pidx_${Math.random().toString(36).slice(2, 10)}`,
			url,
			name: name || new URL(url).host,
			builtin: false,
			publicKeys,
			fetchedAt: iso(),
			lastError: null,
			plugins: 0,
		};
		indexes = [...indexes, row];
		return delay(row);
	},
	removeIndex: async (id) => {
		indexes = indexes.filter((i) => i.id !== id);
		for (const i of installs) if (i.indexId === id) i.indexId = null;
		return delay(undefined);
	},
	refreshIndex: async (id) => {
		const row = indexes.find((i) => i.id === id);
		if (!row) throw new ApiError(404, "plugin index not found", "not_found");
		await delay(null, 600);
		row.fetchedAt = iso();
		row.lastError = null;
		return delay(row);
	},
	updates: async (id) => {
		const row = find(id);
		return delay({
			current: row.version,
			yanked: row.yanked,
			previousVersion: row.previousVersion,
			versions: (UPDATES[row.pluginId] ?? []).filter(
				(u) => u.version > row.version,
			),
		});
	},
	updateVersion: async (id, { version, acceptPermissions }) => {
		const row = find(id);
		const next = MANIFESTS[`${row.pluginId}@${version}`];
		if (!next)
			throw new ApiError(404, `${version} is not in this index`, "not_found");
		const added = next.permissions.filter(
			(a) => !row.manifest.permissions.includes(a),
		);
		if (added.length && !acceptPermissions)
			throw new ApiError(
				409,
				`${version} also asks for ${added.join(", ")}; accept the new permissions to update`,
				"conflict",
			);
		await delay(null, 900);
		row.previousVersion = row.version;
		row.version = next.version;
		row.manifest = next;
		row.yanked = false;
		row.status = "pending";
		row.updatedAt = iso();
		setTimeout(() => {
			row.status = "running";
		}, 2500);
		return delay(row);
	},
	rollback: async (id) => {
		const row = find(id);
		const back = row.previousVersion;
		const prev = back && MANIFESTS[`${row.pluginId}@${back}`];
		if (!back || !prev)
			throw new ApiError(
				409,
				"there is no previous version to go back to",
				"conflict",
			);
		await delay(null, 700);
		row.previousVersion = row.version;
		row.version = back;
		row.manifest = prev;
		row.updatedAt = iso();
		return delay(row);
	},
	inspect: async (source) => {
		if (source.kind === "index") {
			const e = entries().find(
				(x) => x.indexId === source.indexId && x.id === source.pluginId,
			);
			if (!e) throw new ApiError(404, "not in this index", "not_found");
			if (settings.policy === "verified" && !e.verified)
				throw new ApiError(
					403,
					"this instance only allows verified marketplace plugins",
					"forbidden",
				);
			await delay(null, 600);
			return delay({
				manifest: e.latest.manifest,
				image: e.latest.image,
				devUrl: null,
				missingPermissions: [],
				installedId: e.installed?.installId ?? null,
				indexId: e.indexId,
				verified: e.verified,
			});
		}
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
			indexId: null,
			verified: false,
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
			indexId: inspected.indexId,
			verified: inspected.verified,
			yanked: false,
			previousVersion: null,
			gate: { timeoutSeconds: 10, failMode: "closed" },
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
		if (patch.gate) row.gate = { ...row.gate, ...patch.gate };
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
