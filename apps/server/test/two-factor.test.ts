import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, member, organization, passkey, user } from "@logistack/db";
import { and, eq, sql } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("organization two-factor requirement", () => {
	let h: Harness;
	let orgId: string;
	let cookie: string;
	let key: string;
	let devMemberId: string;
	const dev = {
		name: "Dev",
		email: "dev@qw6.example.com",
		password: "dev-password-123",
	};
	const asOwner = () => ({ headers: { cookie } });
	const auditRows = (action: string) =>
		h.deps.db
			.select()
			.from(auditLog)
			.where(
				and(eq(auditLog.organizationId, orgId), eq(auditLog.action, action)),
			);
	/** Moves the policy's enablement and the owner's joining `days` into the past. */
	const enabledDaysAgo = async (days: number) => {
		const then = new Date(Date.now() - days * 86_400_000);
		await h.deps.db
			.update(organization)
			.set({
				metadata: sql`jsonb_set(${organization.metadata}::jsonb, '{twoFactor,enabledAt}', to_jsonb(${then.toISOString()}::text))::text`,
			})
			.where(eq(organization.id, orgId));
		await h.deps.db
			.update(member)
			.set({ createdAt: then })
			.where(eq(member.organizationId, orgId));
	};

	beforeAll(async () => {
		h = await startHarness({ area: "qw6", label: "qw6" });
		orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		key = (
			await h.call("POST", "/api/api-keys", {
				...asOwner(),
				body: { name: "ci" },
			})
		).json.key;
		const invite = await h.call("POST", "/api/invitations", {
			...asOwner(),
			body: { email: dev.email, role: "viewer" },
		});
		await h.call("POST", "/api/auth/sign-up/email", { body: dev });
		const devCookie = await h.signIn(dev.email, dev.password);
		await h.call("POST", "/api/auth/organization/accept-invitation", {
			headers: { cookie: devCookie },
			body: { invitationId: invite.json.id },
		});
		const [row] = await h.deps.db
			.select({ id: member.id })
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.where(eq(user.email, dev.email));
		devMemberId = row?.id as string;
	}, 90_000);
	afterAll(() => h?.close());

	test("off by default", async () => {
		const res = await h.call("GET", "/api/organization/two-factor", asOwner());
		expect(res.json).toEqual({
			mode: "off",
			graceDays: 7,
			trustIdpMfa: false,
			enabledAt: null,
		});
		expect((await h.call("GET", "/api/me", asOwner())).json.twoFactor).toBe(
			null,
		);
	});

	test("switching it on is audited with before and after", async () => {
		const res = await h.call("PUT", "/api/organization/two-factor", {
			...asOwner(),
			body: { mode: "required", graceDays: 7, trustIdpMfa: false },
		});
		expect(res.status).toBe(200);
		expect(res.json.enabledAt).toBeString();
		const [row] = await auditRows("organization.two_factor_update");
		expect(row?.outcome).toBe("success");
		expect(row?.diff).toMatchObject({
			before: { mode: "off", enabledAt: null },
			after: { mode: "required", graceDays: 7 },
		});
	});

	test("inside the grace period the member works and is prompted", async () => {
		const me = await h.call("GET", "/api/me", asOwner());
		expect(me.json.twoFactor.kind).toBe("enroll_prompt");
		expect((await h.call("GET", "/api/projects", asOwner())).status).toBe(200);
	});

	test("after the grace period the member is blocked from organization routes, audited once in the audit log", async () => {
		await enabledDaysAgo(8);
		// The first requests after the deadline race to write the lockout row.
		await Promise.all(
			Array.from({ length: 6 }, () => h.call("GET", "/api/folders", asOwner())),
		);
		const projects = await h.call("GET", "/api/projects", asOwner());
		expect(projects.status).toBe(403);
		expect(projects.json.error.code).toBe("two_factor_required");
		expect(
			(await h.call("GET", "/api/home/summary", asOwner())).json.error.code,
		).toBe("two_factor_required");
		const me = await h.call("GET", "/api/me", asOwner());
		expect(me.status).toBe(200);
		expect(me.json.twoFactor.kind).toBe("blocked");
		// Routes that need no organization (the app shell's first call) still answer.
		expect((await h.call("GET", "/api/setup/status", asOwner())).status).toBe(
			200,
		);
		const blocked = await auditRows("member.two_factor_blocked");
		expect(blocked).toHaveLength(1);
		expect(blocked[0]?.outcome).toBe("denied");
	});

	test("API keys are exempt", async () => {
		const res = await h.call("GET", "/api/projects", {
			headers: { authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(200);
	});

	test("a blocked admin cannot manage the organization through better-auth, but can still pick it and enrol", async () => {
		const setActive = await h.call(
			"POST",
			"/api/auth/organization/set-active",
			{ ...asOwner(), body: { organizationId: orgId } },
		);
		expect(setActive.status).toBe(200);
		const list = await h.call("GET", "/api/auth/organization/list", asOwner());
		expect(list.status).toBe(200);

		const invite = await h.call(
			"POST",
			"/api/auth/organization/invite-member",
			{ ...asOwner(), body: { email: "x@qw6.example.com", role: "admin" } },
		);
		expect(invite.status).toBe(403);
		expect(invite.json).toMatchObject({
			code: "two_factor_required",
			message: expect.stringContaining("two-factor"),
		});
		const role = await h.call(
			"POST",
			"/api/auth/organization/update-member-role",
			{
				...asOwner(),
				body: { memberId: devMemberId, role: "owner", organizationId: orgId },
			},
		);
		expect(role.status).toBe(403);
		expect(role.json.code).toBe("two_factor_required");
		const [devRole] = await h.deps.db
			.select({ role: member.role })
			.from(member)
			.where(eq(member.id, devMemberId));
		expect(devRole?.role).toBe("viewer");

		const passkeyOptions = await h.call(
			"GET",
			"/api/auth/passkey/generate-register-options",
			asOwner(),
		);
		expect(passkeyOptions.status).toBe(200);
		expect(passkeyOptions.json.challenge).toBeString();
	});

	test("editing the grace period keeps the original enablement", async () => {
		const body = { mode: "required", graceDays: 30, trustIdpMfa: false };
		const asBlocked = await h.call("PUT", "/api/organization/two-factor", {
			...asOwner(),
			body,
		});
		expect(asBlocked.status).toBe(403);
		const res = await h.call("PUT", "/api/organization/two-factor", {
			headers: { authorization: `Bearer ${key}` },
			body,
		});
		expect(res.status).toBe(200);
		expect(Date.parse(res.json.enabledAt)).toBeLessThan(
			Date.now() - 7 * 86_400_000,
		);
		expect(
			(await h.call("GET", "/api/me", asOwner())).json.twoFactor.kind,
		).toBe("enroll_prompt");
	});

	test("a passkey satisfies the requirement and shows in the members list", async () => {
		await enabledDaysAgo(60);
		expect((await h.call("GET", "/api/projects", asOwner())).status).toBe(403);
		const [u] = await h.deps.db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, owner.email));
		await h.deps.db.insert(passkey).values({
			id: crypto.randomUUID(),
			userId: u?.id as string,
			publicKey: "pk",
			credentialID: "cred",
			counter: 0,
			deviceType: "multiDevice",
			backedUp: true,
		});
		expect((await h.call("GET", "/api/projects", asOwner())).status).toBe(200);
		expect((await h.call("GET", "/api/me", asOwner())).json.twoFactor).toBe(
			null,
		);
		const members = await h.call("GET", "/api/members", asOwner());
		expect(members.json[0]).toMatchObject({
			passkey: true,
			twoFactorEnabled: false,
		});
	});
});
