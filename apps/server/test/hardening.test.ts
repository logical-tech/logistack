import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authPathAllowed } from "../src/app.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

test("better-auth families that bypass LogiStack's checks are closed, encodings included", () => {
	for (const p of [
		"/api/auth/organization/create",
		"/api/auth/organization/create-role",
		"/api/auth/organization/update-member-role",
		"/api/auth/organization/get-full-organization",
		"/api/auth/admin/impersonate-user",
		"/api/auth/admin/update-user",
		"/api/auth/api-key/create",
		"/api/auth/API-KEY/create",
		"/api/auth/api-key%2Fcreate",
		"/api/auth/api-key/update/",
	])
		expect(authPathAllowed(p)).toBe(false);
	for (const p of [
		"/api/auth/sign-in/email",
		"/api/auth/sign-up/email",
		"/api/auth/two-factor/verify-totp",
		"/api/auth/organization/accept-invitation",
		"/api/auth/organization/set-active",
		"/api/auth/organization/list",
		"/api/auth/sign-in/sso",
	])
		expect(authPathAllowed(p)).toBe(true);
});

describe.skipIf(!hasDocker)("request hardening", () => {
	let h: Harness;
	let cookie: string;

	beforeAll(async () => {
		h = await startHarness({ area: "harden", label: "harden" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
	}, 120_000);
	afterAll(() => h?.close());

	test("a stranger who signs up cannot create an organization", async () => {
		const stranger = {
			name: "Mallory",
			email: "mallory@harden.example.com",
			password: "mallory-password-123",
		};
		expect(
			(await h.call("POST", "/api/auth/sign-up/email", { body: stranger }))
				.status,
		).toBe(200);
		const c = await h.signIn(stranger.email, stranger.password);
		const res = await h.call("POST", "/api/auth/organization/create", {
			headers: { cookie: c },
			body: { name: "Mine", slug: "mine" },
		});
		expect(res.status).toBe(404);
		// Signed in, member of nothing: the API answers nothing.
		expect(
			(await h.call("GET", "/api/projects", { headers: { cookie: c } })).status,
		).toBe(401);
	});

	test("a session cannot mint an API key through better-auth", async () => {
		const res = await h.call("POST", "/api/auth/api-key/create", {
			headers: { cookie },
			body: { name: "x" },
		});
		expect(res.status).toBe(404);
	});

	test("a cookie-authenticated change from another origin is refused", async () => {
		const res = await h.call("POST", "/api/projects", {
			headers: {
				cookie,
				origin: "http://5-6-7-8.sslip.io",
				"sec-fetch-site": "same-site",
			},
			body: { name: "csrf" },
		});
		expect(res.status).toBe(403);
		expect(res.json.error.message).toContain("cross-site");
		// The same request from the dashboard's origin goes through to validation.
		const ok = await h.call("POST", "/api/projects", {
			headers: { cookie, "sec-fetch-site": "same-origin" },
			body: { name: "csrf" },
		});
		expect(ok.status).not.toBe(403);
	});

	test("a cross-site WebSocket upgrade with the cookie is refused", async () => {
		const res = await h.call("GET", "/ws", {
			headers: {
				cookie,
				upgrade: "websocket",
				origin: "https://evil.example.com",
			},
		});
		expect(res.status).toBe(403);
	});

	test("responses carry the security headers", async () => {
		const res = await h.call("GET", "/api/health");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect(res.headers.get("referrer-policy")).toBe(
			"strict-origin-when-cross-origin",
		);
	});
});
