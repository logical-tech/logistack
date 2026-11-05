import type { TwoFactorPolicy } from "@logistack/contracts";

/** What a person has set up to prove it is them, beyond a password. */
export type SecondFactorState = {
	totp: boolean;
	passkey: boolean;
	/** Signs in only through one of the organization's SSO providers (no password account). */
	ssoOnly: boolean;
};

export type TwoFactorAccess =
	| { kind: "allow" }
	| { kind: "enroll_prompt" | "blocked"; deadline: Date };

const DAY_MS = 86_400_000;

/**
 * Whether a member may use the organization under its two-factor policy. The grace period
 * runs from the later of the policy's enablement and the member's joining: members present when
 * it is switched on get the full grace, and so does everyone who joins afterwards.
 */
export function twoFactorAccess(
	user: SecondFactorState,
	policy: TwoFactorPolicy,
	since: { joinedAt: Date; enabledAt: Date },
	now: Date,
): TwoFactorAccess {
	if (policy.mode === "off") return { kind: "allow" };
	if (user.totp || user.passkey) return { kind: "allow" };
	if (policy.trustIdpMfa && user.ssoOnly) return { kind: "allow" };
	const start = Math.max(since.joinedAt.getTime(), since.enabledAt.getTime());
	const deadline = new Date(start + policy.graceDays * DAY_MS);
	return { kind: now < deadline ? "enroll_prompt" : "blocked", deadline };
}
