import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("home network people and devices api", () => {
	let h: Harness;
	let cookie: string;
	const as = (body?: unknown) => ({ headers: { cookie }, body });

	beforeAll(async () => {
		h = await startHarness({ area: "netpeople", label: "netpeople" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
	}, 120_000);
	afterAll(() => h?.close(), 60_000);

	test("people and devices, with extra blocking, unique addresses and a person that may go", async () => {
		const bad = await h.call(
			"POST",
			"/api/network/people",
			as({ name: "Luca", blocking: { listUrls: ["ftp://x"], blocked: [] } }),
		);
		expect(bad.status).toBe(400);
		const luca = await h.call(
			"POST",
			"/api/network/people",
			as({
				name: "Luca",
				blocking: { blocked: ["*.TikTok.com."], listUrls: [] },
			}),
		);
		expect(luca.status).toBe(201);
		expect(luca.json).toMatchObject({
			name: "Luca",
			devices: 0,
			blocking: { blocked: ["tiktok.com"], listUrls: [] },
		});

		const missing = await h.call(
			"POST",
			"/api/network/devices",
			as({ name: "Tablet", address: "192.168.1.40", personId: "nps_nope" }),
		);
		expect(missing.status).toBe(404);
		const tablet = await h.call(
			"POST",
			"/api/network/devices",
			as({ name: "Tablet", address: "192.168.1.40", personId: luca.json.id }),
		);
		expect(tablet.status).toBe(201);
		expect(tablet.json).toMatchObject({
			personName: "Luca",
			blocking: { listUrls: [], blocked: [] },
		});
		expect(
			(
				await h.call(
					"POST",
					"/api/network/devices",
					as({ name: "Phone", address: "192.168.1.40" }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await h.call(
					"POST",
					"/api/network/devices",
					as({ name: "Phone", address: "not-an-ip" }),
				)
			).status,
		).toBe(400);

		const moved = await h.call(
			"PATCH",
			`/api/network/devices/${tablet.json.id}`,
			as({ blocking: { listUrls: [], blocked: ["roblox.com"] } }),
		);
		expect(moved.json.blocking.blocked).toEqual(["roblox.com"]);
		expect(
			(await h.call("GET", "/api/network/people", as())).json[0].devices,
		).toBe(1);

		expect(
			(await h.call("DELETE", `/api/network/people/${luca.json.id}`, as()))
				.status,
		).toBe(204);
		expect((await h.call("GET", "/api/network/devices", as())).json).toEqual([
			expect.objectContaining({
				name: "Tablet",
				personId: null,
				personName: null,
			}),
		]);
		expect(
			(await h.call("DELETE", `/api/network/devices/${tablet.json.id}`, as()))
				.status,
		).toBe(204);
	});
});
