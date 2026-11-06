import { ApiError } from "../adapter";
import type { SponsorApi, SponsorStatus } from "../sponsor";

const NONE: SponsorStatus = {
	state: "none",
	kind: null,
	amount: null,
	currency: null,
	since: null,
	expiresAt: null,
	sandbox: false,
};

const DAY = 86_400_000;
const active = (): SponsorStatus => ({
	state: "active",
	kind: "monthly",
	amount: 15,
	currency: "eur",
	since: new Date(Date.now() - 12 * DAY).toISOString(),
	expiresAt: new Date(Date.now() + 25 * DAY).toISOString(),
	sandbox: false,
});

/** `ls-mock-sponsor=1` starts the mock as a sponsor; any `lss_` key activates it. */
let state: SponsorStatus =
	localStorage.getItem("ls-mock-sponsor") === "1" ? active() : NONE;

const delay = <T>(v: T) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 250));

export const mockSponsor: SponsorApi = {
	status: () => delay(state),
	activate: (key) => {
		if (!key.trim().startsWith("lss_"))
			return Promise.reject(
				new ApiError(
					400,
					"That isn't a sponsor key. Keys start with lss_ and come from the sponsorship email.",
					"bad_request",
				),
			);
		state = active();
		return delay(state);
	},
	remove: () => {
		state = NONE;
		return delay(state);
	},
};
