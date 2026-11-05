import { describe, expect, test } from "bun:test";
import type { TwoFactorPolicy } from "@logistack/contracts";
import {
	type SecondFactorState,
	type TwoFactorAccess,
	twoFactorAccess,
} from "../src/two-factor.ts";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

const none: SecondFactorState = { totp: false, passkey: false, ssoOnly: false };
const totp = { ...none, totp: true };
const passkey = { ...none, passkey: true };
const sso = { ...none, ssoOnly: true };

const off: TwoFactorPolicy = { mode: "off", graceDays: 7, trustIdpMfa: false };
const req7: TwoFactorPolicy = {
	mode: "required",
	graceDays: 7,
	trustIdpMfa: false,
};
const req0 = { ...req7, graceDays: 0 };
const req7Idp = { ...req7, trustIdpMfa: true };

const allow: TwoFactorAccess = { kind: "allow" };
const prompt = (d: number): TwoFactorAccess => ({
	kind: "enroll_prompt",
	deadline: day(d),
});
const blocked = (d: number): TwoFactorAccess => ({
	kind: "blocked",
	deadline: day(d),
});

// [case, user, policy, joinedAt day, enabledAt day, now day, expected]
const rows: [
	string,
	SecondFactorState,
	TwoFactorPolicy,
	number,
	number,
	number,
	TwoFactorAccess,
][] = [
	["policy off, nothing enrolled", none, off, 0, 0, 100, allow],
	["policy off, sso only", sso, off, 0, 0, 100, allow],
	["required, totp", totp, req7, 0, 0, 100, allow],
	["required, passkey", passkey, req7, 0, 0, 100, allow],
	[
		"required, totp and passkey, no grace",
		{ ...totp, passkey: true },
		req0,
		0,
		0,
		0,
		allow,
	],
	["required, nothing, inside grace", none, req7, 0, 0, 3, prompt(7)],
	[
		"required, nothing, one ms before deadline",
		none,
		req7,
		0,
		0,
		6.99999,
		prompt(7),
	],
	["required, nothing, at deadline", none, req7, 0, 0, 7, blocked(7)],
	["required, nothing, after deadline", none, req7, 0, 0, 30, blocked(7)],
	["required, nothing, zero grace", none, req0, 0, 0, 0, blocked(0)],
	["old member: grace starts at enablement", none, req7, 0, 50, 55, prompt(57)],
	[
		"old member: blocked after enablement grace",
		none,
		req7,
		0,
		50,
		57,
		blocked(57),
	],
	["new member: grace starts at joining", none, req7, 60, 50, 65, prompt(67)],
	[
		"new member: blocked after joining grace",
		none,
		req7,
		60,
		50,
		67,
		blocked(67),
	],
	["sso only, IdP not trusted, inside grace", sso, req7, 0, 0, 3, prompt(7)],
	["sso only, IdP not trusted, after grace", sso, req7, 0, 0, 8, blocked(7)],
	["sso only, IdP trusted", sso, req7Idp, 0, 0, 100, allow],
	[
		"password user, IdP trusted, after grace",
		none,
		req7Idp,
		0,
		0,
		8,
		blocked(7),
	],
];

describe("twoFactorAccess", () => {
	test.each(rows)("%s", (_, user, policy, joined, enabled, now, expected) => {
		const at = (d: number) => new Date(day(0).getTime() + d * 86_400_000);
		expect(
			twoFactorAccess(
				user,
				policy,
				{ joinedAt: at(joined), enabledAt: at(enabled) },
				at(now),
			),
		).toEqual(expected);
	});
});
