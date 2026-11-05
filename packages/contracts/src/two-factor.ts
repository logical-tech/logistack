import { z } from "zod";

export const twoFactorModes = ["off", "required"] as const;
export const TwoFactorMode = z.enum(twoFactorModes);
export type TwoFactorMode = z.infer<typeof TwoFactorMode>;

/** An organization's two-factor requirement, as admins set it. */
export const TwoFactorPolicy = z.object({
	mode: TwoFactorMode,
	/** Days a member may keep working without a second factor once the requirement applies to them. */
	graceDays: z.int().min(0).max(90),
	/** Members who can only sign in through the organization's SSO count as enrolled: their IdP enforces MFA. */
	trustIdpMfa: z.boolean(),
});
export type TwoFactorPolicy = z.infer<typeof TwoFactorPolicy>;

export const twoFactorAccessKinds = [
	"allow",
	"enroll_prompt",
	"blocked",
] as const;
export type TwoFactorAccessKind = (typeof twoFactorAccessKinds)[number];
