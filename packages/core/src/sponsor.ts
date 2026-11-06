/**
 * Sponsor keys: `lss_<payload>.<signature>`, both base64url. The sponsors Worker (`sponsors/`)
 * signs the payload with Ed25519 after a Stripe payment; an instance checks it offline against
 * the public key below, so a sponsor badge never depends on our service being up.
 */
export const SPONSOR_PUBLIC_KEY = "_-xHuSNt5sLPW6W_7Ec9owcki5QYPGwI3Avwcd0rosk";

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
	| { ok: true; claims: SponsorClaims; expired: boolean }
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

/** Verifies a key's signature and reads its claims. An expired key still parses, flagged `expired`. */
export async function checkSponsorKey(
	key: string,
	now = Date.now(),
	publicKey = SPONSOR_PUBLIC_KEY,
): Promise<SponsorCheck> {
	const m = /^lss_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key.trim());
	if (!m?.[1] || !m[2]) return { ok: false, reason: "malformed" };
	const payload = m[1];
	const claims = parseClaims(Buffer.from(payload, "base64url").toString());
	if (!claims) return { ok: false, reason: "malformed" };
	const pub = await crypto.subtle.importKey(
		"raw",
		fromB64u(publicKey),
		{ name: "Ed25519" },
		false,
		["verify"],
	);
	const valid = await crypto.subtle.verify(
		{ name: "Ed25519" },
		pub,
		fromB64u(m[2]),
		new TextEncoder().encode(payload),
	);
	if (!valid) return { ok: false, reason: "signature" };
	return { ok: true, claims, expired: claims.exp * 1000 <= now };
}

/** The sponsors Worker. Instances only call it to renew a monthly key, never to check one. */
export const SPONSORS_URL = "https://sponsors.logicaltech.it";

/** A monthly key is renewed once less than this is left on it. */
export const SPONSOR_RENEW_WINDOW_MS = 10 * 86_400_000;
