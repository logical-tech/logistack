import { z } from "zod";
import { PermissionAction } from "./enums.ts";
import { EventType } from "./events.ts";

// Plugins (docs/plans/plugins.md): an OCI image whose manifest rides in an image label,
// run by LogiStack as a hardened Swarm service per organization, spoken to over signed HTTP.

/** The image label that carries the manifest as JSON. */
export const PLUGIN_MANIFEST_LABEL = "io.logistack.plugin.manifest";

/** Version of the HTTP contract between LogiStack and a plugin; every path starts with it. */
export const PLUGIN_CONTRACT_VERSION = "v1";

/** Headers LogiStack sets on every request it sends a plugin, signed like the webhook channel. */
export const PLUGIN_HEADERS = {
	timestamp: "x-logistack-timestamp",
	signature: "x-logistack-signature",
	install: "x-logistack-install",
	/** JSON of `PluginUserClaims`, on requests a plugin page makes through the proxy. */
	user: "x-logistack-user",
	/** The page's session token, sent by the page to the proxy; never forwarded. */
	session: "x-logistack-session",
} as const;

/** Reverse-DNS, as `com.acme.hetzner-dns`. */
export const PluginId = z
	.string()
	.min(3)
	.max(128)
	.regex(
		/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/,
		"reverse-DNS, lower case, as com.acme.my-plugin",
	);

const SemVer = z
	.string()
	.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "semver, as 1.2.0");

/** A JSON Schema object; `secret: true` on a string property marks it secret. */
export const JsonSchemaObject = z
	.object({ type: z.literal("object") })
	.catchall(z.unknown());
export type JsonSchemaObject = z.infer<typeof JsonSchemaObject>;

export const pluginPageLocations = [
	"sidebar",
	"service-tab",
	"project-tab",
	"settings",
] as const;
export const PluginPageLocation = z.enum(pluginPageLocations);
export type PluginPageLocation = z.infer<typeof PluginPageLocation>;

const Slug = z
	.string()
	.min(1)
	.max(48)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const PluginPage = z.object({
	id: Slug,
	title: z.string().min(1).max(40),
	/** A name from our icon set, never a URL. */
	icon: z.string().max(40).optional(),
	location: PluginPageLocation,
	/** Service kinds a service tab appears on; absent: every kind. */
	serviceKinds: z.array(z.string()).optional(),
	/** Path the plugin container serves the page at, as `/ui/costs`. */
	path: z
		.string()
		.regex(/^\/ui(?:\/[A-Za-z0-9._~-]+)*\/?$/, "a path under /ui"),
});
export type PluginPage = z.infer<typeof PluginPage>;

export const PluginTool = z.object({
	name: Slug,
	description: z.string().min(1).max(500),
	inputSchema: JsonSchemaObject,
	destructive: z.boolean().default(false),
});
export type PluginTool = z.infer<typeof PluginTool>;

export const pluginProviderKinds = [
	"dnsProviders",
	"notificationChannels",
	"secretProviders",
	"backupDestinations",
] as const;
export type PluginProviderKind = (typeof pluginProviderKinds)[number];

export const PluginProvider = z.object({
	name: Slug,
	title: z.string().min(1).max(60),
	configSchema: JsonSchemaObject,
});
export type PluginProvider = z.infer<typeof PluginProvider>;

const Memory = z
	.string()
	.regex(/^\d+(?:Mi|Gi)$/, "as 128Mi or 1Gi")
	.default("128Mi");

export const PluginManifest = z.object({
	id: PluginId,
	version: SemVer,
	name: z.string().min(1).max(60),
	description: z.string().max(300).default(""),
	author: z
		.object({ name: z.string().min(1).max(80), url: z.url().optional() })
		.optional(),
	license: z.string().max(40).optional(),
	/** Compatible server versions, as `>=0.6.0`. */
	logistack: z.string().max(60).optional(),
	port: z.int().min(1).max(65535).default(8080),
	resources: z
		.object({ memory: Memory, cpu: z.number().min(0.05).max(4).default(0.25) })
		.default({ memory: "128Mi", cpu: 0.25 }),
	/** Organization-wide actions the plugin's API token gets; the installer must hold each. */
	permissions: z.array(PermissionAction).default([]),
	/** Hosts the plugin says it talks to; shown at install, enforced in a later phase. */
	egress: z.array(z.string().max(253)).max(50).default([]),
	config: JsonSchemaObject.default({ type: "object", properties: {} }),
	contributes: z
		.object({
			events: z.array(EventType).default([]),
			pages: z.array(PluginPage).max(20).default([]),
			tools: z.array(PluginTool).max(50).default([]),
			dnsProviders: z.array(PluginProvider).max(10).default([]),
			notificationChannels: z.array(PluginProvider).max(10).default([]),
			secretProviders: z.array(PluginProvider).max(10).default([]),
			backupDestinations: z.array(PluginProvider).max(10).default([]),
		})
		.default({
			events: [],
			pages: [],
			tools: [],
			dnsProviders: [],
			notificationChannels: [],
			secretProviders: [],
			backupDestinations: [],
		}),
});
export type PluginManifest = z.infer<typeof PluginManifest>;
export type PluginManifestInput = z.input<typeof PluginManifest>;

export const pluginStatuses = [
	/** Waiting for the reconciler. */
	"pending",
	"running",
	"disabled",
	"error",
] as const;
export const PluginStatus = z.enum(pluginStatuses);
export type PluginStatus = z.infer<typeof PluginStatus>;

/** Instance-wide: who may install what. `verified` needs the marketplace (phase 3). */
export const pluginPolicies = ["off", "verified", "any"] as const;
export const PluginPolicy = z.enum(pluginPolicies);
export type PluginPolicy = z.infer<typeof PluginPolicy>;

/** What a plugin page's session token carries, and what the proxy forwards in `x-logistack-user`. */
export const PluginUserClaims = z.object({
	userId: z.string(),
	name: z.string(),
	organizationId: z.string(),
	installId: z.string(),
	/** The viewer's actions on the context resource (the service or project of a tab, else the organization). */
	permissions: z.array(PermissionAction),
	context: z
		.object({
			serviceId: z.string().optional(),
			projectId: z.string().optional(),
		})
		.default({}),
});
export type PluginUserClaims = z.infer<typeof PluginUserClaims>;

/** Bridge messages a plugin page sends the dashboard (`@logistack/plugin-sdk/ui`). */
export const PluginPageMessage = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ready") }),
	z.object({ type: z.literal("token.refresh"), id: z.string() }),
	z.object({
		type: z.literal("resize"),
		height: z.number().min(0).max(100_000),
	}),
	z.object({ type: z.literal("navigate"), to: z.string().max(2048) }),
	z.object({
		type: z.literal("toast"),
		message: z.string().max(300),
		kind: z.enum(["info", "success", "error"]).default("info"),
	}),
	z.object({
		type: z.literal("confirm"),
		id: z.string(),
		title: z.string().max(120),
		description: z.string().max(600).optional(),
		confirmLabel: z.string().max(40).optional(),
		destructive: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("openExternal"),
		url: z.url().max(2048),
	}),
	z.object({ type: z.literal("storage.get"), id: z.string(), key: z.string() }),
	z.object({
		type: z.literal("storage.set"),
		id: z.string(),
		key: z.string(),
		value: z.unknown(),
	}),
	z.object({
		type: z.literal("storage.delete"),
		id: z.string(),
		key: z.string(),
	}),
]);
export type PluginPageMessage = z.infer<typeof PluginPageMessage>;

/** Bridge messages the dashboard sends a plugin page. */
export type PluginHostMessage =
	| {
			type: "init";
			theme: "light" | "dark";
			/** Our CSS custom properties, name to value. */
			css: Record<string, string>;
			locale: string;
			user: { id: string; name: string };
			organization: { id: string; name: string };
			context: { serviceId?: string; projectId?: string };
			/** Path below the page's own path, from the dashboard URL. */
			subpath: string;
			token: string;
			tokenExpiresAt: string;
	  }
	| { type: "theme"; theme: "light" | "dark"; css: Record<string, string> }
	| { type: "reply"; id: string; ok: true; value?: unknown }
	| { type: "reply"; id: string; ok: false; error: string };

/** Limits of the per-user key-value storage plugin pages get over the bridge. */
export const PLUGIN_STORAGE_LIMITS = {
	keyLength: 128,
	valueBytes: 16 * 1024,
	keys: 256,
} as const;

// ---- PluginIndexPayload: the marketplace index contract (docs/plans/plugins.md, "Marketplace") ----
// Every response is an envelope whose `payload` is JSON text, signed with Ed25519 over its UTF-8
// bytes. `GET {indexUrl}/v1/index` carries `PluginIndexPayload`, `GET {indexUrl}/v1/plugins/{id}`
// carries `PluginDetailPayload`.

export const PluginIndexEnvelope = z.object({
	payload: z.string(),
	keyId: z.string().min(1).max(128),
	/** base64url Ed25519 signature over the UTF-8 bytes of `payload`. */
	signature: z.string().min(1),
});
export type PluginIndexEnvelope = z.infer<typeof PluginIndexEnvelope>;

/** A digest-pinned image, `repo@sha256:…`. */
const PinnedImage = z
	.string()
	.max(512)
	.regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/, "repo@sha256:<64 hex>");

export const PluginIndexVersion = z.object({
	version: SemVer,
	image: PinnedImage,
	manifest: PluginManifest,
	changelog: z.string().max(20_000).optional(),
	publishedAt: z.string(),
	yanked: z.boolean(),
});
export type PluginIndexVersion = z.infer<typeof PluginIndexVersion>;

const PluginIndexListing = z.object({
	id: PluginId,
	name: z.string().min(1).max(60),
	description: z.string().max(300).default(""),
	author: z.string().max(80).optional(),
	iconUrl: z.url().max(2048).optional(),
});

export const PluginIndexEntry = PluginIndexListing.extend({
	verified: z.boolean(),
	latest: PluginIndexVersion,
});
export type PluginIndexEntry = z.infer<typeof PluginIndexEntry>;

export const PluginIndexPayload = z.object({
	generatedAt: z.string(),
	indexName: z.string().min(1).max(80),
	plugins: z.array(PluginIndexEntry),
});
export type PluginIndexPayload = z.infer<typeof PluginIndexPayload>;

export const PluginDetailVersion = PluginIndexVersion.extend({
	verified: z.boolean(),
});
export type PluginDetailVersion = z.infer<typeof PluginDetailVersion>;

export const PluginDetailPayload = PluginIndexListing.extend({
	versions: z.array(PluginDetailVersion),
});
export type PluginDetailPayload = z.infer<typeof PluginDetailPayload>;
// ---- end PluginIndexPayload ----
