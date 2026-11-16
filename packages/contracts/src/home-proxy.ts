import { z } from "zod";
import { isDnsName } from "./dns.ts";

/*
 * Local proxy: HTTPS names for things on the LAN (a NAS, the router, Home Assistant) served by
 * LogiStack's own Caddy and reachable only from private addresses. Nothing is published: the
 * certificate is a `*.<zone>` wildcard from Let's Encrypt over DNS-01, or Caddy's internal CA.
 * Instance-wide, like the home DNS, which answers the names when it is on.
 */

/** `acme`: Let's Encrypt wildcard over DNS-01 through a connected DNS provider. `internal`: Caddy's own CA. */
export const HomeProxyTls = z.enum(["acme", "internal"]);
export type HomeProxyTls = z.infer<typeof HomeProxyTls>;

const Zone = z
	.string()
	.trim()
	.toLowerCase()
	.transform((n) => n.replace(/\.$/, ""))
	.refine(
		(n) => isDnsName(n) && !n.startsWith("*") && n.includes("."),
		"enter a domain name such as home.example.com",
	);

/** One DNS label: the route answers at `<name>.<zone>`. */
export const HomeProxyName = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
		"letters, digits and dashes, not at the start or end",
	);

/** The canonical text of an upstream: `https://192.168.1.10:8006`. */
export function formatHomeProxyUpstream(u: {
	scheme: "http" | "https";
	host: string;
	port: number;
}) {
	return `${u.scheme}://${u.host.includes(":") ? `[${u.host}]` : u.host}:${u.port}`;
}

/** Accepts a pasted URL or a bare `host:port` (plain HTTP); null when it is neither. */
export function parseHomeProxyUpstream(text: string) {
	const raw = text.trim();
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.username || url.password || (url.pathname !== "/" && url.pathname))
		return null;
	const scheme = url.protocol === "https:" ? "https" : "http";
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (!host) return null;
	return {
		scheme,
		host,
		port: Number(url.port || (scheme === "https" ? 443 : 80)),
	} as const;
}

const Upstream = z
	.string()
	.trim()
	.min(1)
	.max(300)
	.transform((s, ctx) => {
		const u = parseHomeProxyUpstream(s);
		if (!u) {
			ctx.addIssue({
				code: "custom",
				message:
					"enter an address such as 192.168.1.10:8080 or https://nas.lan:5001",
			});
			return z.NEVER;
		}
		// The proxy's own admin API: a route there would hand its config to the LAN.
		if (u.port === 2019) {
			ctx.addIssue({
				code: "custom",
				message: "port 2019 is the proxy's admin API",
			});
			return z.NEVER;
		}
		return formatHomeProxyUpstream(u);
	});

export const HomeProxy = z.object({
	enabled: z.boolean(),
	zone: z.string().nullable(),
	tls: HomeProxyTls.nullable(),
	/** The DNS provider whose zone covers `zone`, which solves the DNS-01 challenge (tls `acme`). */
	dnsProvider: z.string().nullable(),
	/** Where the names must resolve inside the house: the home DNS node, when the home DNS is on. */
	lanAddress: z.string().nullable(),
	/** The home DNS writes the records itself; otherwise point the names at the proxy by hand. */
	automaticRecords: z.boolean(),
	/** Caddy's internal root certificate (tls `internal`), for devices to trust; null until the worker read it. */
	caRootPem: z.string().nullable(),
	statusMessage: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type HomeProxy = z.infer<typeof HomeProxy>;

export const HomeProxyEnableInput = z.object({
	zone: Zone,
	tls: HomeProxyTls,
});
export type HomeProxyEnableInput = z.infer<typeof HomeProxyEnableInput>;

export const HomeProxyUpdateInput = HomeProxyEnableInput.partial().refine(
	(o) => Object.keys(o).length > 0,
	"nothing to update",
);
export type HomeProxyUpdateInput = z.infer<typeof HomeProxyUpdateInput>;

export const HomeProxyRoute = z.object({
	id: z.string(),
	name: z.string(),
	hostname: z.string(),
	upstream: z.string(),
	/** HTTPS upstream with a self-signed certificate (Proxmox, UniFi, a NAS): skip its verification. */
	insecure: z.boolean(),
	createdAt: z.string(),
});
export type HomeProxyRoute = z.infer<typeof HomeProxyRoute>;

export const HomeProxyRouteInput = z.object({
	name: HomeProxyName,
	upstream: Upstream,
	insecure: z.boolean().default(false),
});
export type HomeProxyRouteInput = z.infer<typeof HomeProxyRouteInput>;

export const HomeProxyRouteUpdateInput = z
	.object({ name: HomeProxyName, upstream: Upstream, insecure: z.boolean() })
	.partial()
	.refine((o) => Object.keys(o).length > 0, "nothing to update");
export type HomeProxyRouteUpdateInput = z.infer<
	typeof HomeProxyRouteUpdateInput
>;

export const HomeProxyTestInput = z.object({
	upstream: Upstream,
	insecure: z.boolean().default(false),
});
export const HomeProxyTestResult = z.object({
	ok: z.boolean(),
	/** HTTP status the upstream answered with; any status proves it is reachable. */
	status: z.number().nullable(),
	error: z.string().nullable(),
	ms: z.number(),
});
export type HomeProxyTestResult = z.infer<typeof HomeProxyTestResult>;
