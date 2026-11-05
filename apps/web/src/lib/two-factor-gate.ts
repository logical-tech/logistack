import { ApiError, type Me } from "./api";

/** Where people add an authenticator app or a passkey. */
export const ENROL_PATH = "/account/security";

const PROMPTED_KEY = "ls.two-factor-prompted";

/** The server's answer when the organization's two-factor deadline has passed for this person. */
export const isTwoFactorRequired = (err: unknown) =>
	err instanceof ApiError && err.code === "two_factor_required";

/**
 * Whether the app shell should send this person to enrolment: always once they are blocked,
 * and once per browser session while they are still inside the grace period.
 */
export function shouldEnrol(me: Pick<Me, "twoFactor">, pathname: string) {
	if (!me.twoFactor || pathname === ENROL_PATH) return false;
	if (me.twoFactor.kind === "blocked") return true;
	try {
		if (sessionStorage.getItem(PROMPTED_KEY)) return false;
		sessionStorage.setItem(PROMPTED_KEY, "1");
	} catch {}
	return true;
}
