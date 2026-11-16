import { describe, expect, test } from "bun:test";
import { compileAdvancedBlocking, EVERYONE_GROUP } from "../src/home-dns.ts";

const none = { listUrls: [], blocked: [] };

describe("compileAdvancedBlocking", () => {
	test("nobody blocks more: not needed, blocking off, only everyone", () => {
		const r = compileAdvancedBlocking(
			[{ id: "p1", blocking: none }],
			[{ id: "d1", address: "192.168.1.5", personId: "p1", blocking: none }],
		);
		expect(r.needed).toBe(false);
		expect(r.config.enableBlocking).toBe(false);
		expect(r.config.groups.map((g) => g.name)).toEqual([EVERYONE_GROUP]);
		expect(r.config.networkGroupMap).toEqual({
			"0.0.0.0/0": EVERYONE_GROUP,
			"[::]/0": EVERYONE_GROUP,
		});
	});

	test("person rules shared by their devices; device rules add to the person's", () => {
		const kids = {
			id: "p1",
			blocking: {
				listUrls: ["https://lists/social.txt"],
				blocked: ["tiktok.com"],
			},
		};
		const r = compileAdvancedBlocking(
			[kids, { id: "p2", blocking: none }],
			[
				{ id: "d1", address: "192.168.1.20", personId: "p1", blocking: none },
				{ id: "d2", address: "192.168.1.21", personId: "p1", blocking: none },
				{
					id: "d3",
					address: "192.168.1.22",
					personId: "p1",
					blocking: { listUrls: [], blocked: ["roblox.com", "tiktok.com"] },
				},
				{
					id: "d4",
					address: "fd00::4",
					personId: null,
					blocking: { listUrls: [], blocked: ["x.com"] },
				},
				{ id: "d5", address: "192.168.1.30", personId: "p2", blocking: none },
			],
		);
		expect(r.needed).toBe(true);
		expect(r.config.networkGroupMap).toEqual({
			"192.168.1.20": "person-p1",
			"192.168.1.21": "person-p1",
			"192.168.1.22": "device-d3",
			"fd00::4": "device-d4",
			"0.0.0.0/0": EVERYONE_GROUP,
			"[::]/0": EVERYONE_GROUP,
		});
		const byName = Object.fromEntries(r.config.groups.map((g) => [g.name, g]));
		expect(byName["device-d3"]?.blocked).toEqual(["roblox.com", "tiktok.com"]);
		expect(byName["device-d3"]?.blockListUrls).toEqual([
			"https://lists/social.txt",
		]);
		expect(byName["person-p1"]?.blocked).toEqual(["tiktok.com"]);
		expect(byName[EVERYONE_GROUP]?.blocked).toEqual([]);
		expect(r.config.groups.map((g) => g.name)).toEqual([
			EVERYONE_GROUP,
			"device-d3",
			"device-d4",
			"person-p1",
		]);
	});
});
