/** Signs sponsor keys. The verifier, and the claim shape, live in packages/core/src/sponsor.ts. */
export type SponsorClaims = {
	v: 1;
	sub: string;
	kind: "monthly" | "once";
	amount: number;
	currency: string;
	iat: number;
	exp: number;
};

const DAY = 86_400;
/** A month plus a week of grace, so a late renewal or a missed refresh never drops the badge. */
export const MONTHLY_TTL = 37 * DAY;
export const ONCE_TTL = 365 * DAY;

const b64u = (b: ArrayBuffer | Uint8Array) => {
	const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
	let s = "";
	for (const c of bytes) s += String.fromCharCode(c);
	return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
const fromB64u = (s: string) =>
	Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
		c.charCodeAt(0),
	);

/** `pkcs8` is the base64url PKCS#8 private key from the SIGNING_KEY secret. */
export async function signSponsorKey(
	claims: SponsorClaims,
	pkcs8: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		fromB64u(pkcs8),
		{ name: "Ed25519" },
		false,
		["sign"],
	);
	const payload = b64u(new TextEncoder().encode(JSON.stringify(claims)));
	const sig = await crypto.subtle.sign(
		{ name: "Ed25519" },
		key,
		new TextEncoder().encode(payload),
	);
	return `lss_${payload}.${b64u(sig)}`;
}

/** Reads a key this Worker issued. The KV lookup that follows is the real check, so no signature here. */
export function readClaims(key: string): SponsorClaims | null {
	const m = /^lss_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(key.trim());
	if (!m?.[1]) return null;
	try {
		return JSON.parse(new TextDecoder().decode(fromB64u(m[1])));
	} catch {
		return null;
	}
}
