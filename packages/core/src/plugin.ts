import type { PluginManifest } from "@logistack/contracts";
import {
	type Labels,
	managedLabels,
	type ServiceSpec,
} from "@logistack/docker";
import { dockerName } from "./ids.ts";

// Plugins run as hardened Swarm services (docs/plans/plugins.md, "Runtime"): no Docker socket,
// no host mounts, every capability dropped, read-only root with a tmpfs /tmp, limits from the
// manifest, one volume for their own state, on a network of their own.

/** The overlay plugins join; the api and worker are attached so they can call them. */
export const pluginsNetworkName = (prefix = "") => `${prefix}ls-plugins`;

/** `ls-plg-<id body>`, from the install id (rule 5). */
export const pluginServiceName = (installId: string, prefix = "") =>
	`${prefix}${dockerName("plg", installId)}`;

/** Instance cap on what a manifest may ask for. */
export const PLUGIN_LIMITS = { memoryMb: 1024, cpu: 1 } as const;

/** `128Mi` → 128, `1Gi` → 1024. */
export function memoryMb(m: string): number {
	const match = /^(\d+)(Mi|Gi)$/.exec(m);
	if (!match) throw new Error(`bad memory size ${JSON.stringify(m)}`);
	return Number(match[1]) * (match[2] === "Gi" ? 1024 : 1);
}

/** What the container reads at start. Secrets go through env, never argv (rule 3). */
export type PluginEnv = {
	LOGISTACK_URL: string;
	LOGISTACK_TOKEN: string;
	LOGISTACK_SIGNING_SECRET: string;
	LOGISTACK_INSTALL_ID: string;
	PORT: string;
};

export type PluginInput = {
	install: {
		id: string;
		organizationId: string;
		image: string;
		enabled: boolean;
		manifest: PluginManifest;
	};
	env: Omit<PluginEnv, "LOGISTACK_INSTALL_ID" | "PORT">;
	/** Id or name of the plugins overlay. */
	network: string;
	scope?: { namePrefix: string; labels: Labels };
};

const ns = (seconds: number) => seconds * 1e9;

/** Pure: the plugin's Swarm service. A disabled install keeps its service at zero replicas. */
export function compilePlugin(i: PluginInput): ServiceSpec {
	const { install, scope } = i;
	const labels: Labels = {
		...managedLabels({
			resource: install.id,
			kind: "plugin",
			org: install.organizationId,
		}),
		"logistack.plugin": install.manifest.id,
		...scope?.labels,
	};
	const res = install.manifest.resources;
	const memory = Math.min(memoryMb(res.memory), PLUGIN_LIMITS.memoryMb);
	const cpu = Math.min(res.cpu, PLUGIN_LIMITS.cpu);
	const env: PluginEnv = {
		...i.env,
		LOGISTACK_INSTALL_ID: install.id,
		PORT: String(install.manifest.port),
	};
	return {
		Name: pluginServiceName(install.id, scope?.namePrefix),
		Labels: labels,
		TaskTemplate: {
			ContainerSpec: {
				Image: install.image,
				Labels: labels,
				Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
				ReadOnly: true,
				CapabilityDrop: ["ALL"],
				Mounts: [
					{
						Type: "tmpfs",
						Target: "/tmp",
						TmpfsOptions: { SizeBytes: 64 * 1024 * 1024 },
					},
					{
						Type: "volume",
						Source: `${scope?.namePrefix ?? ""}${dockerName("plg", install.id)}-data`,
						Target: "/data",
						VolumeOptions: { Labels: labels },
					},
				],
				StopGracePeriod: ns(10),
			},
			Resources: {
				Limits: {
					NanoCPUs: Math.round(cpu * 1e9),
					MemoryBytes: memory * 1024 * 1024,
				},
			},
			RestartPolicy: { Condition: "any", Delay: ns(5), MaxAttempts: 0 },
			Networks: [{ Target: i.network }],
		},
		Mode: { Replicated: { Replicas: install.enabled ? 1 : 0 } },
		// The volume is local to a node; a second task elsewhere would see an empty one.
		UpdateConfig: { Parallelism: 1, Order: "stop-first" },
		EndpointSpec: { Mode: "vip" },
	};
}

/** Where LogiStack reaches the plugin: its service on the plugins network, or its dev URL. */
export function pluginBaseUrl(
	install: { id: string; devUrl: string | null; manifest: PluginManifest },
	prefix = "",
): string {
	if (install.devUrl) return install.devUrl.replace(/\/+$/, "");
	return `http://${pluginServiceName(install.id, prefix)}:${install.manifest.port}`;
}

/**
 * The secret fields of a JSON Schema object, top level only (`secret: true` on a property).
 * shortcut: nested objects are not walked; plugin settings forms are flat in v1.
 */
export function secretFields(schema: Record<string, unknown>): string[] {
	const props = (schema.properties ?? {}) as Record<
		string,
		{ secret?: unknown }
	>;
	return Object.entries(props)
		.filter(([, p]) => p && typeof p === "object" && p.secret === true)
		.map(([k]) => k);
}

/** Settings as the API returns them: secret values replaced by a marker. */
export function maskConfig(
	config: Record<string, unknown>,
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...config };
	for (const k of secretFields(schema))
		if (out[k] !== undefined && out[k] !== "") out[k] = SECRET_MASK;
	return out;
}

/** A masked secret in an update means "keep what is stored". */
export const SECRET_MASK = "••••••••";

export function mergeConfig(
	stored: Record<string, unknown>,
	incoming: Record<string, unknown>,
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...incoming };
	for (const k of secretFields(schema))
		if (out[k] === SECRET_MASK) out[k] = stored[k];
	return out;
}

export type ListDiff = { added: string[]; removed: string[] };

const listDiff = (from: string[], to: string[]): ListDiff => ({
	added: to.filter((x) => !from.includes(x)),
	removed: from.filter((x) => !to.includes(x)),
});

/** What an update changes in what the plugin may do: its token's actions and declared egress. */
export function manifestDiff(
	from: Pick<PluginManifest, "permissions" | "egress">,
	to: Pick<PluginManifest, "permissions" | "egress">,
): { permissions: ListDiff; egress: ListDiff } {
	return {
		permissions: listDiff(from.permissions, to.permissions),
		egress: listDiff(from.egress, to.egress),
	};
}
