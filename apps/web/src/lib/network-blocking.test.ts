import { expect, test } from "bun:test";
import { effectiveBlocking, hasBlocking } from "./network-blocking";

test("a device gets its person's extra rules plus its own, once each", () => {
	const b = effectiveBlocking(
		{
			listUrls: ["https://a.example/list"],
			blocked: ["twitch.tv", "tiktok.com"],
		},
		{
			listUrls: ["https://a.example/list"],
			blocked: ["tiktok.com", "roblox.com"],
		},
	);
	expect(b).toEqual({
		listUrls: ["https://a.example/list"],
		blocked: ["tiktok.com", "roblox.com", "twitch.tv"],
	});
	expect(
		hasBlocking(effectiveBlocking({ listUrls: [], blocked: [] }, undefined)),
	).toBe(false);
});
