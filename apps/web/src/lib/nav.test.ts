import { expect, test } from "bun:test";
import { HOME_NETWORK, NAV, navGroups, PROXY_NETWORK } from "./nav";

test("with home DNS off the sidebar is the plain registry", () => {
	expect(navGroups(false)).toBe(NAV);
});

test("with home DNS on, Network becomes a group after the main one and keeps the map's URL", () => {
	const groups = navGroups(true);
	expect(groups[1]).toBe(HOME_NETWORK);
	expect(groups[0]?.items.some((s) => s.to === "/network")).toBe(false);
	expect(HOME_NETWORK.items.find((s) => s.title === "Map")?.to).toBe(
		"/network",
	);
	expect(groups.slice(2)).toEqual(NAV.slice(1));
});

test("with only the local proxy on, Network holds the proxy and the map but no DNS pages", () => {
	const groups = navGroups(false, true);
	expect(groups[1]).toBe(PROXY_NETWORK);
	expect(PROXY_NETWORK.items.map((s) => s.to)).toEqual([
		"/network/proxy",
		"/network",
	]);
	expect(groups[0]?.items.some((s) => s.to === "/network")).toBe(false);
	expect(groups.slice(2)).toEqual(NAV.slice(1));
});

test("with both on, the full group lists the local proxy", () => {
	expect(navGroups(true, true)[1]).toBe(HOME_NETWORK);
	expect(HOME_NETWORK.items.some((s) => s.to === "/network/proxy")).toBe(true);
});

test("people and devices need the home DNS", () => {
	const dns = navGroups(true, false)[1]?.items.map((s) => s.to);
	expect(dns).toContain("/network/people");
	expect(dns).toContain("/network/devices");
	expect(
		PROXY_NETWORK.items.some((s) => s.to.startsWith("/network/people")),
	).toBe(false);
});
