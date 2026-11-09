import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

/** The counters live in one-minute windows: start a burst well inside one. */
async function freshWindow() {
	const s = (Date.now() / 1000) % 60;
	if (s > 45) await Bun.sleep((61 - s) * 1000);
}

/** The start of the next one-minute window, so earlier sign-ins (setup's) no longer count. */
async function newWindow() {
	await Bun.sleep((60 - ((Date.now() / 1000) % 60)) * 1000 + 50);
}

describe.skipIf(!hasDocker)("rate limits", () => {
	let h: Harness;
	let key: string;

	beforeAll(async () => {
		h = await startHarness({
			area: "rlim",
			label: "rlim",
			env: {
				RATE_LIMIT_LOGIN_PER_MINUTE: "4",
				// The test client stands in for Caddy, which names the client in x-logistack-client-ip.
				TRUSTED_PROXY_PREFIXES: "127.,::1",
				RATE_LIMIT_API_KEY_PER_MINUTE: "5",
			},
		});
		await h.call("POST", "/api/setup", { body: setupBody });
		await freshWindow();
		const cookie = await h.signIn(owner.email, owner.password);
		const res = await h.call("POST", "/api/api-keys", {
			headers: { cookie },
			body: { name: "ci" },
		});
		key = res.json.key;
	}, 120_000);
	afterAll(() => h?.close());

	test("sign-in answers 429 above the threshold, for right and wrong passwords alike", async () => {
		await newWindow();
		const attempt = (password: string) =>
			h.call("POST", "/api/auth/sign-in/email", {
				body: { email: owner.email, password },
				headers: { "x-logistack-client-ip": "198.51.100.20" },
			});
		const statuses: number[] = [];
		for (let i = 0; i < 4; i++) statuses.push((await attempt("wrong")).status);
		expect(statuses.every((s) => s === 401)).toBe(true);
		const over = await attempt(owner.password);
		expect(over.status).toBe(429);
		expect(over.json.error.code).toBe("rate_limited");
		expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
		// Another address shares the account's count, so rotating addresses does not help.
		const other = await h.call("POST", "/api/auth/sign-in/email", {
			body: { email: owner.email, password: owner.password },
			headers: { "x-logistack-client-ip": "198.51.100.21" },
		});
		expect(other.status).toBe(429);
	});

	test("a client's own X-Forwarded-For does not choose its rate-limit bucket", async () => {
		await freshWindow();
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++)
			statuses.push(
				(
					await h.call("POST", "/api/auth/sign-in/email", {
						body: { email: `nobody${i}@example.com`, password: "x" },
						headers: { "x-forwarded-for": `203.0.113.${i}, 198.51.100.30` },
					})
				).status,
			);
		// Same trusted peer, same last hop: one bucket, the fifth attempt is refused.
		expect(statuses.at(-1)).toBe(429);
	});

	test("an API key answers 429 above the threshold, even when the calls race", async () => {
		await freshWindow();
		const results = await Promise.all(
			Array.from({ length: 12 }, () =>
				h.call("GET", "/api/projects", {
					headers: { authorization: `Bearer ${key}` },
				}),
			),
		);
		const statuses = results.map((r) => r.status);
		// The key's own creation call above is in an earlier window or counts as one.
		expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(5);
		expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(7);
	});
});
