import { expect, test } from "bun:test";
import { HOME_NETWORK, NAV, navGroups } from "./nav";

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
