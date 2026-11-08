import type { ProxyRoute, Upstream } from "./compile.ts";

/** Route id prefix of status page hostnames; `routeId` adds `ls-domain-`. */
export const STATUS_ROUTE_PREFIX = "status-";

/**
 * One HTTPS route per published status page with its own hostname, to the API upstream: the
 * API recognises the Host header and serves only that page there.
 */
export function statusPageRoutes(
	pages: readonly { id: string; hostname: string | null; published: boolean }[],
	api: Upstream,
): ProxyRoute[] {
	return pages.flatMap((p) =>
		p.published && p.hostname
			? [
					{
						domainId: `${STATUS_ROUTE_PREFIX}${p.id}`,
						hostname: p.hostname,
						upstream: api,
						https: true,
						cert: "auto",
					},
				]
			: [],
	);
}
