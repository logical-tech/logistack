import { parseHomeProxyUpstream } from "@logistack/contracts";
import { homeProxy, homeProxyRoute } from "@logistack/db";
import type { technitium } from "@logistack/providers";
import {
	type DnsChallenge,
	PRIVATE_RANGES,
	type ProxyRoute,
} from "@logistack/proxy";
import { eq } from "drizzle-orm";
import { log } from "./bus.ts";
import type { Ctx } from "./ctx.ts";

type Proxy = typeof homeProxy.$inferSelect;
type Route = typeof homeProxyRoute.$inferSelect;

/** Domain ids of local proxy routes in the compiled config, so they never collide with `dom_…`. */
export const homeProxyDomainId = (id: string) => `local-${id}`;

/**
 * Pure: the local proxy's routes as the compiler takes them. Private addresses only, so a router
 * that forwards 443 to this server never exposes the NAS. The certificate is the zone's wildcard
 * (`withInstanceWildcard`); `dnsChallenge` only keeps a host on DNS-01 should Caddy ever want one
 * of its own.
 */
export function homeProxyCandidates(
	proxy: Pick<Proxy, "zone" | "tls">,
	routes: Route[],
	dnsChallenge: DnsChallenge | undefined,
): ProxyRoute[] {
	return routes.flatMap((r) => {
		const u = parseHomeProxyUpstream(r.upstream);
		if (!u) return [];
		return [
			{
				domainId: homeProxyDomainId(r.id),
				hostname: `${r.name}.${proxy.zone}`,
				upstream: {
					host: u.host,
					port: u.port,
					...(u.scheme === "https" && { tls: { insecure: r.insecure } }),
				},
				https: true,
				cert: "auto",
				...(dnsChallenge && { dnsChallenge }),
				access: [{ type: "ip_allow", cidrs: PRIVATE_RANGES }],
			},
		];
	});
}

export async function loadHomeProxy(ctx: Ctx) {
	const [proxy] = await ctx.db.select().from(homeProxy);
	if (!proxy) return undefined;
	return { proxy, routes: await ctx.db.select().from(homeProxyRoute) };
}

/** Records the local proxy writes on the home DNS carry this comment; only those are ever changed. */
export const HOME_PROXY_RECORD_COMMENT = "LogiStack: local proxy";

type RecordKey = {
	name: string;
	type: string;
	content: string;
	comment?: string;
};

/**
 * Pure: an A record per route name at the proxy's LAN address. Our records for a removed route
 * or an older address go; records someone made by hand are never touched, and one that already
 * gives the right address stands in for ours.
 */
export function homeProxyRecordsPlan<R extends RecordKey>(
	existing: R[],
	names: string[],
	lanAddress: string,
) {
	const ours = (r: RecordKey) =>
		r.type === "A" && r.comment === HOME_PROXY_RECORD_COMMENT;
	return {
		add: [...new Set(names)]
			.filter(
				// A matching record made by hand already answers; Technitium refuses a duplicate.
				(name) =>
					!existing.some(
						(e) =>
							e.type === "A" && e.name === name && e.content === lanAddress,
					),
			)
			.sort()
			.map((name) => ({
				name,
				type: "A" as const,
				content: lanAddress,
				ttl: 300,
				comment: HOME_PROXY_RECORD_COMMENT,
			})),
		remove: existing.filter(
			(e) => ours(e) && (!names.includes(e.name) || e.content !== lanAddress),
		),
	};
}

/** A Forwarder zone, so names under the zone without a route still resolve as before. */
// shortcut: the home DNS node's address stands for Caddy's, as for the instance base; records left in an old zone after a zone change stay until removed by hand.
export async function ensureHomeProxyRecords(
	api: ReturnType<typeof technitium>,
	zone: string,
	names: string[],
	lanAddress: string,
) {
	if (!(await api.zones()).some((z) => z.name === zone))
		await api.createForwarderZone(zone);
	const plan = homeProxyRecordsPlan(await api.records(zone), names, lanAddress);
	for (const r of plan.remove) await api.deleteRecord(zone, r);
	for (const r of plan.add) await api.addRecord(zone, r);
}

/** Caddy's internal root, from the admin API, so devices can be told to trust it. */
export async function recordCaRoot(ctx: Ctx, proxy: Proxy, adminUrl: string) {
	if (proxy.tls !== "internal") return;
	try {
		const res = await fetch(`${adminUrl}/pki/ca/local`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const { root_certificate: pem } = (await res.json()) as {
			root_certificate?: string;
		};
		if (pem && pem !== proxy.caRootPem)
			await ctx.db
				.update(homeProxy)
				.set({ caRootPem: pem })
				.where(eq(homeProxy.id, proxy.id));
	} catch (e) {
		log("warn", "local proxy: reading Caddy's root certificate failed", {
			error: String(e),
		});
	}
}

export async function recordHomeProxyStatus(
	ctx: Ctx,
	proxy: Proxy,
	message: string | null,
) {
	if (proxy.statusMessage === message) return;
	await ctx.db
		.update(homeProxy)
		.set({ statusMessage: message })
		.where(eq(homeProxy.id, proxy.id));
}
