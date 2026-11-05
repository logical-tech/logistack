/**
 * Dokploy (0.29+) encrypts env columns at rest: `enc:v1:` + base64(iv 12 | tag 16 | ciphertext),
 * AES-256-GCM, keyed with HMAC-SHA256(secret, "dokploy:db-encryption:v1"). The secret is its
 * ENCRYPTION_KEY, else its BETTER_AUTH_SECRET, else the fixed default old releases shipped with.
 * Written from that format; nothing of Dokploy's code is reused.
 */
const PREFIX = "enc:v1:";
const INFO = new TextEncoder().encode("dokploy:db-encryption:v1");
/** What Dokploy falls back to without a configured auth secret (deprecated there, still met). */
export const DOKPLOY_LEGACY_SECRET = "better-auth-secret-123456789";

export const isDokployEncrypted = (v: string | null | undefined) =>
	!!v?.startsWith(PREFIX);

export async function dokployKeys(secrets: string[]): Promise<CryptoKey[]> {
	return Promise.all(
		[...new Set(secrets.filter(Boolean))].map(async (secret) => {
			const hmac = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(secret),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const raw = await crypto.subtle.sign("HMAC", hmac, INFO);
			return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
		}),
	);
}

/** The plaintext, the value itself when it is not encrypted, or undefined when no key opens it. */
export async function decryptDokploy(
	value: string | null,
	keys: CryptoKey[],
): Promise<string | null | undefined> {
	if (!value || !isDokployEncrypted(value)) return value;
	const payload = Buffer.from(value.slice(PREFIX.length), "base64");
	const iv = payload.subarray(0, 12);
	// Web Crypto wants the tag after the ciphertext.
	const sealed = Buffer.concat([
		payload.subarray(28),
		payload.subarray(12, 28),
	]);
	for (const key of keys) {
		try {
			const plain = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv },
				key,
				sealed,
			);
			return new TextDecoder().decode(plain);
		} catch {
			// Another key.
		}
	}
	return undefined;
}
