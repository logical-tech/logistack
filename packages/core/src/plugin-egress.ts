import {
	type Labels,
	managedLabels,
	type ServiceSpec,
} from "@logistack/docker";

// Plugin egress (docs/plans/plugins.md, phase 4): the plugins overlay is `internal`, so a plugin
// container has no route out. Its only way to the internet is this proxy, which joins the plugins
// network and one ordinary overlay, and tunnels to the hosts the plugin's manifest declares.
// Each plugin authenticates with Basic credentials derived from its install id, so the proxy
// knows whose allowlist applies without trusting source addresses.

export const EGRESS_PROXY_PORT = 3128;

/** The proxy's Swarm service, and its name on the plugins network. */
export const egressProxyName = (prefix = "") => `${prefix}ls-plugin-egress`;

/** The ordinary overlay that gives the proxy, and only the proxy, a route out. */
export const egressNetworkName = (prefix = "") => `${prefix}ls-plugins-egress`;

/** What `ROLE=egressproxy` reads. */
export type EgressEnv = {
	LS_EGRESS_LISTEN: string;
	/** HMAC key the per-install passwords derive from. */
	LS_EGRESS_KEY: string;
	/** JSON `{ [installId]: hosts[] }`. */
	LS_EGRESS_RULES: string;
};

const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");

/**
 * True when `host` is declared: an exact name or IP, or `*.example.com` for any name below
 * example.com (not example.com itself). Ports are not part of a rule.
 */
export function egressAllowed(rules: readonly string[], host: string): boolean {
	const h = norm(host.replace(/^\[|\]$/g, ""));
	if (!h) return false;
	return rules.some((r) => {
		const rule = norm(r);
		if (rule.startsWith("*.")) return h.endsWith(rule.slice(1));
		return rule === h;
	});
}

const hex = (b: ArrayBuffer) =>
	Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join(
		"",
	);

/** HMAC-SHA256(key, message) as hex. */
export async function hmacHex(key: string, message: string): Promise<string> {
	const k = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(
		await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)),
	);
}

/** The proxy key, derived from the master key so nothing new is stored. */
export const egressKey = (masterKey: string) =>
	hmacHex(masterKey, "logistack plugin egress v1");

/** An install's proxy password. */
export const egressPassword = (key: string, installId: string) =>
	hmacHex(key, installId);

/** Env a plugin container gets: both spellings, since tools disagree on case. */
export function egressClientEnv(o: {
	installId: string;
	password: string;
	/** Hosts reached directly over the plugins network, the LogiStack API first. */
	noProxy: string[];
	prefix?: string;
}): Record<string, string> {
	const url = `http://${o.installId}:${o.password}@${egressProxyName(o.prefix)}:${EGRESS_PROXY_PORT}`;
	const no = [...o.noProxy, "localhost", "127.0.0.1"].join(",");
	return {
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		http_proxy: url,
		https_proxy: url,
		NO_PROXY: no,
		no_proxy: no,
	};
}

export type EgressProxyInput = {
	image: string;
	key: string;
	rules: Record<string, string[]>;
	/** The plugins overlay (internal) and the egress overlay, by id or name. */
	networks: [string, string];
	scope?: { namePrefix: string; labels: Labels };
};

/** Pure: the proxy's Swarm service. Rules ride in env, so a manifest change rolls it. */
export function compileEgressProxy(i: EgressProxyInput): ServiceSpec {
	const labels: Labels = {
		...managedLabels({
			resource: "plugin-egress",
			kind: "system",
			org: "system",
		}),
		...i.scope?.labels,
	};
	const env: EgressEnv = {
		LS_EGRESS_LISTEN: String(EGRESS_PROXY_PORT),
		LS_EGRESS_KEY: i.key,
		// Sorted, so the same rules always compile to the same spec.
		LS_EGRESS_RULES: JSON.stringify(
			Object.fromEntries(
				Object.entries(i.rules)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, v]) => [k, [...v].sort()]),
			),
		),
	};
	return {
		Name: egressProxyName(i.scope?.namePrefix),
		Labels: labels,
		TaskTemplate: {
			ContainerSpec: {
				Image: i.image,
				Labels: labels,
				Env: [
					"ROLE=egressproxy",
					...Object.entries(env).map(([k, v]) => `${k}=${v}`),
				],
				ReadOnly: true,
				CapabilityDrop: ["ALL"],
				Mounts: [
					{
						Type: "tmpfs",
						Target: "/tmp",
						TmpfsOptions: { SizeBytes: 16 * 1024 * 1024 },
					},
				],
				StopGracePeriod: 5e9,
				// The image's own check probes the api's HTTP port, which the proxy does not serve.
				Healthcheck: { Test: ["NONE"] },
			},
			Resources: { Limits: { NanoCPUs: 5e8, MemoryBytes: 128 * 1024 * 1024 } },
			RestartPolicy: { Condition: "any", Delay: 5e9, MaxAttempts: 0 },
			Networks: i.networks.map((Target) => ({ Target })),
		},
		Mode: { Replicated: { Replicas: 1 } },
		EndpointSpec: { Mode: "vip" },
	};
}
