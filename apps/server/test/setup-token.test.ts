import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { trustedOrigins } from "../src/auth.ts";
import { type SetupGate, setupGate } from "../src/routes/setup.ts";
import { type Harness, hasDocker, setupBody, startHarness } from "./harness.ts";

describe("setupGate", () => {
	const cases: [
		done: boolean,
		expected: string | undefined,
		given: string | undefined,
		gate: SetupGate,
	][] = [
		[false, undefined, undefined, "open"],
		[false, undefined, "anything", "open"],
		[false, "s3cret", undefined, "token_missing"],
		[false, "s3cret", "", "token_missing"],
		[false, "s3cret", "wrong", "token_invalid"],
		[false, "s3cret", "s3cret-longer", "token_invalid"],
		[false, "s3cret", "s3cret", "open"],
		[true, undefined, undefined, "done"],
		[true, "s3cret", "s3cret", "done"],
		[true, "s3cret", undefined, "done"],
	];
	test.each(cases)(
		"done=%p expected=%p given=%p -> %p",
		(done, expected, given, gate) => {
			expect(setupGate(done, expected, given)).toBe(gate);
		},
	);
});

describe.skipIf(!hasDocker)("setup with install.sh --public-setup", () => {
	const token = "a".repeat(64);
	let h: Harness;
	beforeAll(async () => {
		h = await startHarness({
			area: "qw3",
			label: "qw3",
			env: {
				LOGISTACK_SETUP_TOKEN: token,
				LOGISTACK_TUNNEL_ORIGIN: "http://localhost:3000",
			},
		});
	}, 60_000);
	afterAll(() => h?.close());

	test("setup needs the token, then the token is retired", async () => {
		expect((await h.call("GET", "/api/setup/status")).json).toMatchObject({
			setupCompleted: false,
			setupTokenRequired: true,
		});
		const missing = await h.call("POST", "/api/setup", { body: setupBody });
		expect(missing.status).toBe(401);
		const wrong = await h.call("POST", "/api/setup", {
			body: setupBody,
			headers: { "x-setup-token": "b".repeat(64) },
		});
		expect(wrong.status).toBe(401);
		const probe = await h.call("POST", "/api/setup/dns-check", {
			body: { hostname: "ls-check.example.com" },
		});
		expect(probe.status).toBe(401);
		expect((await h.call("GET", "/api/setup/status")).json).toMatchObject({
			setupCompleted: false,
			hasUsers: false,
		});

		const ok = await h.call("POST", "/api/setup", {
			body: setupBody,
			headers: { "x-setup-token": token },
		});
		expect(ok.status).toBe(201);
		expect((await h.call("GET", "/api/setup/status")).json).toMatchObject({
			setupCompleted: true,
			setupTokenRequired: false,
		});
		const again = await h.call("POST", "/api/setup", {
			body: setupBody,
			headers: { "x-setup-token": token },
		});
		expect(again.status).toBe(409);
	});

	test("the installer's loopback tunnel is a trusted origin", async () => {
		expect(await trustedOrigins(h.config, h.deps.db)()).toContain(
			"http://localhost:3000",
		);
	});
});
