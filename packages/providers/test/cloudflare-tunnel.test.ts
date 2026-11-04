import { expect, test } from "bun:test";
import {
	cloudflareTunnels,
	tunnelIngress,
} from "../src/dns/cloudflare-tunnel.ts";

test("ingress dedupes and sorts hostnames, ending in the catch-all", () => {
	expect(
		tunnelIngress(
			["B.example.com", "a.example.com", "b.example.com"],
			"http://caddy:80",
		),
	).toEqual([
		{ hostname: "a.example.com", service: "http://caddy:80" },
		{ hostname: "b.example.com", service: "http://caddy:80" },
		{ service: "http_status:404" },
	]);
});

test("create returns the tunnel id and its run token", async () => {
	const calls: string[] = [];
	const t = cloudflareTunnels("tok", {
		fetch: async (url, init) => {
			calls.push(`${init?.method} ${url}`);
			const result = url.endsWith("/token") ? "run-token" : { id: "uuid-1" };
			return Response.json({ success: true, result });
		},
	});
	expect(await t.create("acc", "home")).toEqual({
		tunnelId: "uuid-1",
		token: "run-token",
	});
	expect(calls).toEqual([
		"POST https://api.cloudflare.com/client/v4/accounts/acc/cfd_tunnel",
		"GET https://api.cloudflare.com/client/v4/accounts/acc/cfd_tunnel/uuid-1/token",
	]);
});

test("removing a missing tunnel succeeds", async () => {
	const t = cloudflareTunnels("tok", {
		fetch: async () => Response.json({ success: false }, { status: 404 }),
	});
	await t.remove("acc", "gone");
});
