import { expect, test } from "bun:test";
import { compileProxy, routeId, statusPageRoutes } from "../src/index.ts";
import { dashboard, settings } from "./fixtures.ts";

const pages = [
	{ id: "stp_a", hostname: "status.example.com", published: true },
	{ id: "stp_b", hostname: null, published: true },
	{ id: "stp_c", hostname: "hidden.example.com", published: false },
];

test("only published pages with a hostname get a route, to the API upstream", () => {
	expect(statusPageRoutes(pages, dashboard.upstream)).toEqual([
		{
			domainId: "status-stp_a",
			hostname: "status.example.com",
			upstream: dashboard.upstream,
			https: true,
			cert: "auto",
		},
	]);
});

test("a status page hostname compiles to an HTTPS route with an http redirect", () => {
	const config = compileProxy({
		settings,
		dashboard,
		routes: statusPageRoutes(pages, dashboard.upstream),
	});
	const https = config.apps.http.servers.https;
	const route = https?.routes.find((r) => r["@id"] === routeId("status-stp_a"));
	expect(route).toMatchSnapshot();
	const redirect = config.apps.http.servers.http?.routes[0];
	expect(JSON.stringify(redirect)).toContain("status.example.com");
});
