import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, instanceSettings, organization, user } from "@logistack/db";
import { trustedOrigins } from "../src/auth.ts";
import { completeSetup, SetupInput } from "../src/routes/setup.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("first-run setup", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await startHarness();
	}, 60_000);
	afterAll(() => h?.close());

	test("sign-up is refused before setup", async () => {
		const res = await h.call("POST", "/api/auth/sign-up/email", {
			body: {
				name: "Mallory",
				email: "mallory@example.com",
				password: "hunter2hunter2",
			},
		});
		expect(res.status).not.toBe(200);
		expect((await h.call("GET", "/api/setup/status")).json).toEqual({
			setupCompleted: false,
			hasUsers: false,
			setupTokenRequired: false,
			publicIp: "203.0.113.7",
			lanAddress: null,
			publicUrl: null,
			authProviders: { github: false, google: false },
		});
		// Records at the LAN address need the installer's LAN_ADDRESS; the refusal leaves setup open.
		const lan = await h.call("POST", "/api/setup", {
			body: {
				...setupBody,
				instance: { ...setupBody.instance, reachFrom: "lan" },
			},
		});
		expect(lan.status).toBe(400);
		expect((await h.call("GET", "/api/setup/status")).json.hasUsers).toBe(
			false,
		);
	});

	test("concurrent setups: exactly one wins, then it is locked", async () => {
		// Nothing unique collides between the rivals, so only the setup lock can stop them.
		const rivals = Array.from({ length: 8 }, (_, i) => ({
			...setupBody,
			owner: { ...owner, email: `rival${i}@example.com` },
			organization: { name: `Rival ${i}` },
		}));
		const results = await Promise.all([
			h.call("POST", "/api/setup", { body: setupBody }),
			...rivals.map((body) => h.call("POST", "/api/setup", { body })),
		]);
		const statuses = results.map((r) => r.status);
		expect(statuses.filter((s) => s === 201)).toHaveLength(1);
		expect(statuses.filter((s) => s === 409)).toHaveLength(8);
		// The wizard moves the browser here and diagnoses a name that does not answer.
		const won = results.find((r) => r.status === 201);
		expect(won?.json).toMatchObject({
			dnsRecords: [],
			dashboard: { url: "https://ls.example.com", hostname: "ls.example.com" },
			publicIp: "203.0.113.7",
		});
		expect(Array.isArray(won?.json.dashboard.resolvesTo)).toBe(true);
		expect(
			(await h.call("POST", "/api/setup", { body: setupBody })).status,
		).toBe(409);
		expect((await h.call("GET", "/api/setup/status")).json).toEqual({
			setupCompleted: true,
			hasUsers: true,
			setupTokenRequired: false,
			publicIp: "203.0.113.7",
			lanAddress: null,
			publicUrl: "https://ls.example.com",
			authProviders: { github: false, google: false },
		});
		// Once set up, DNS probing is an admin action.
		expect(
			(
				await h.call("POST", "/api/setup/dns-check", {
					body: { hostname: "ls-check.example.com" },
				})
			).status,
		).toBe(401);
		const [settings] = await h.deps.db.select().from(instanceSettings);
		expect(settings?.generatedDomainBase).toBe("sslip");
		const rows = await h.deps.db.select().from(auditLog);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "setup.complete",
			outcome: "success",
		});
		expect(JSON.stringify(rows[0]?.diff)).not.toContain(owner.password);
	});

	test("the owner can sign in", async () => {
		// Any of the concurrent rivals may have won; they all share the password.
		const [winner] = await h.deps.db.select({ email: user.email }).from(user);
		const email = winner?.email ?? owner.email;
		const cookie = await h.signIn(email, owner.password);
		const session = await h.call("GET", "/api/auth/get-session", {
			headers: { cookie },
		});
		expect(session.json.user.email).toBe(email);
		expect((await h.call("GET", "/api/version")).status).toBe(401);
		expect(
			(await h.call("GET", "/api/version", { headers: { cookie } })).json,
		).toEqual({ version: "dev" });
	});

	// BETTER_AUTH_URL is http://localhost:3000 here, standing in for the installer's sslip URL.
	test("passkey options carry the browser's host as RP ID, else the public URL's", async () => {
		const [winner] = await h.deps.db.select({ email: user.email }).from(user);
		const cookie = await h.signIn(winner?.email ?? owner.email, owner.password);
		const rp = async (headers: Record<string, string>) => {
			const res = await h.call(
				"GET",
				"/api/auth/passkey/generate-register-options",
				{ headers: { cookie, ...headers } },
			);
			expect(res.status).toBe(200);
			return res.json.rp;
		};
		expect(await rp({ origin: "https://ls.example.com" })).toEqual({
			id: "ls.example.com",
			name: "LogiStack",
		});
		// Same-origin GETs carry no Origin; the Host header says where the browser is.
		expect((await rp({ origin: "", host: "ls.example.com" })).id).toBe(
			"ls.example.com",
		);
		expect((await rp({ origin: "https://evil.example" })).id).toBe(
			"ls.example.com",
		);
		expect((await rp({ origin: "http://localhost:5173" })).id).toBe(
			"localhost",
		);
		const totp = await h.call("POST", "/api/auth/two-factor/enable", {
			headers: { cookie },
			body: { password: owner.password },
		});
		expect(totp.json.totpURI).toContain("issuer=LogiStack");
	});

	// better-auth skips its origin check under NODE_ENV=test, so this asserts the list it is given.
	test("trusted origins follow the instance settings", async () => {
		const origins = trustedOrigins(h.config, h.deps.db);
		expect(await origins()).toEqual([
			"http://localhost:5173",
			"https://ls.example.com",
			"http://ls.example.com",
		]);
		await h.deps.db
			.update(instanceSettings)
			.set({ primaryDomain: "dash.example.org" });
		expect(await origins()).toContain("https://dash.example.org");
	});
});

// Over HTTP the password hash runs on the event loop and staggers the callers; calling the
// transaction directly makes them overlap inside Postgres.
describe.skipIf(!hasDocker)("setup transaction race", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await startHarness();
	}, 60_000);
	afterAll(() => h?.close());

	test("overlapping transactions: exactly one commits", async () => {
		const input = SetupInput.parse(setupBody);
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, (_, i) =>
				completeSetup(
					h.deps.db,
					{
						...input,
						owner: { ...input.owner, email: `r${i}@example.com` },
						organization: { name: `R${i}` },
					},
					"not-a-real-hash",
				),
			),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		for (const r of results)
			if (r.status === "rejected")
				expect(r.reason).toMatchObject({ code: "conflict" });
		expect(await h.deps.db.$count(user)).toBe(1);
		expect(await h.deps.db.$count(organization)).toBe(1);
	});
});
