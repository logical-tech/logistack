/**
 * Sponsor keys: `lss_<payload>.<signature>`, both base64url. The sponsors Worker (`sponsors/`)
 * signs the payload with Ed25519 after a Stripe payment; an instance checks it offline against
 * the public key below, so a sponsor badge never depends on our service being up.
 */
export const SPONSOR_PUBLIC_KEY = "_-xHuSNt5sLPW6W_7Ec9owcki5QYPGwI3Avwcd0rosk";

/**
 * Signs keys bought through Stripe's sandbox. Only an instance started with
 * LOGISTACK_SPONSOR_SANDBOX=1 accepts them, so test payments never unlock a real badge.
 */
export const SPONSOR_SANDBOX_PUBLIC_KEY =
	"AOzY2GUbIV6ds-_gGanL8hAGZto0PV397oOvrhwhG5o";

/** The public keys an instance trusts. */
export const sponsorKeys = (sandbox: boolean) =>
	sandbox
		? [SPONSOR_PUBLIC_KEY, SPONSOR_SANDBOX_PUBLIC_KEY]
		: [SPONSOR_PUBLIC_KEY];

export type SponsorClaims = {
	v: 1;
	/** The Stripe subscription id for monthly sponsors, the Checkout Session id otherwise. */
	sub: string;
	kind: "monthly" | "once";
	/** Whole currency units paid per period, e.g. 15. */
	amount: number;
	currency: string;
	/** Unix seconds. */
	iat: number;
	exp: number;
};

export type SponsorCheck =
	| { ok: true; claims: SponsorClaims; expired: boolean; sandbox: boolean }
	| { ok: false; reason: "malformed" | "signature" };

const fromB64u = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

function parseClaims(json: string): SponsorClaims | null {
	try {
		const c = JSON.parse(json);
		const ok =
			c?.v === 1 &&
			typeof c.sub === "string" &&
			(c.kind === "monthly" || c.kind === "once") &&
			typeof c.amount === "number" &&
			typeof c.currency === "string" &&
			Number.isInteger(c.iat) &&
			Number.isInteger(c.exp);
		return ok ? c : null;
	} catch {
		return null;
	}
}

async function verifies(publicKey: string, sig: string, payload: string) {
	const pub = await crypto.subtle.importKey(
		"raw",
		fromB64u(publicKey),
		{ name: "Ed25519" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		{ name: "Ed25519" },
		pub,
		fromB64u(sig),
		new TextEncoder().encode(payload),
	);
}

/** Verifies a key against `publicKeys` and reads its claims. An expired key still parses, flagged `expired`. */
export async function checkSponsorKey(
	key: string,
	now = Date.now(),
	publicKeys: readonly string[] = [SPONSOR_PUBLIC_KEY],
): Promise<SponsorCheck> {
	const m = /^lss_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key.trim());
	if (!m?.[1] || !m[2]) return { ok: false, reason: "malformed" };
	const [, payload, sig] = m;
	const claims = parseClaims(Buffer.from(payload, "base64url").toString());
	if (!claims) return { ok: false, reason: "malformed" };
	for (const pk of publicKeys)
		if (await verifies(pk, sig, payload))
			return {
				ok: true,
				claims,
				expired: claims.exp * 1000 <= now,
				sandbox: pk === SPONSOR_SANDBOX_PUBLIC_KEY,
			};
	return { ok: false, reason: "signature" };
}

/** The sponsors Worker. Instances only call it to renew a monthly key, never to check one. */
export const SPONSORS_URL = "https://sponsors.logicaltech.it";
export const SPONSORS_SANDBOX_URL = "https://sponsors-sandbox.logicaltech.it";

/** A monthly key is renewed once less than this is left on it. */
export const SPONSOR_RENEW_WINDOW_MS = 10 * 86_400_000;
