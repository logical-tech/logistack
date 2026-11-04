import { type Deps, Http, ProviderError } from "../http.ts";

const API = "https://api.cloudflare.com/client/v4";

export type TunnelIngressRule =
	| { hostname: string; service: string }
	| { service: string };

/** Pure: one rule per hostname to `origin`, sorted for a stable diff, then the required catch-all. */
export function tunnelIngress(
	hostnames: string[],
	origin: string,
): TunnelIngressRule[] {
	return [
		...[...new Set(hostnames.map((h) => h.toLowerCase()))]
			.sort()
			.map((hostname) => ({ hostname, service: origin })),
		{ service: "http_status:404" },
	];
}

/** Where a tunnel hostname's proxied CNAME points. */
export const tunnelTarget = (tunnelId: string) =>
	`${tunnelId}.cfargotunnel.com`;

export type TunnelStatus = "inactive" | "degraded" | "healthy" | "down";

/** Cloudflare Tunnel (remotely managed) over an API token with Account › Cloudflare Tunnel › Edit. */
export function cloudflareTunnels(apiToken: string, deps?: Deps) {
	const http = new Http("cloudflare", deps);
	const headers = {
		authorization: `Bearer ${apiToken}`,
		"content-type": "application/json",
	};
	const call = async <T>(
		op: string,
		method: string,
		path: string,
		body?: unknown,
	) =>
		(
			await http.json<{ result: T }>(op, `${API}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			})
		).result;
	const tunnel = (accountId: string, id = "") =>
		`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel${id ? `/${encodeURIComponent(id)}` : ""}`;

	return {
		accounts: () =>
			call<{ id: string; name: string }[]>(
				"listAccounts",
				"GET",
				"/accounts?per_page=50",
			),
		async create(accountId: string, name: string) {
			const t = await call<{ id: string }>(
				"createTunnel",
				"POST",
				tunnel(accountId),
				{
					name,
					config_src: "cloudflare",
				},
			);
			const token = await call<string>(
				"tunnelToken",
				"GET",
				`${tunnel(accountId, t.id)}/token`,
			);
			return { tunnelId: t.id, token };
		},
		async status(accountId: string, tunnelId: string) {
			const t = await call<{ status: TunnelStatus; connections?: unknown[] }>(
				"tunnelStatus",
				"GET",
				tunnel(accountId, tunnelId),
			);
			return { status: t.status, connections: t.connections?.length ?? 0 };
		},
		putIngress: (
			accountId: string,
			tunnelId: string,
			ingress: TunnelIngressRule[],
		) =>
			call(
				"putIngress",
				"PUT",
				`${tunnel(accountId, tunnelId)}/configurations`,
				{
					config: { ingress },
				},
			),
		/** Deleting a tunnel that no longer exists succeeds. */
		async remove(accountId: string, tunnelId: string) {
			try {
				await call(
					"tunnelConnections",
					"DELETE",
					`${tunnel(accountId, tunnelId)}/connections`,
				);
				await call("deleteTunnel", "DELETE", tunnel(accountId, tunnelId));
			} catch (e) {
				if (e instanceof ProviderError && e.status === 404) return;
				throw e;
			}
		},
	};
}
