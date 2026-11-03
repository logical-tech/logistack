const VERSION = "v1";
const IV_BYTES = 12;

/** Imports the 32-byte AES-256-GCM master key, given as base64. */
export async function importMasterKey(base64: string): Promise<CryptoKey> {
	const raw = Uint8Array.fromBase64(base64.trim());
	if (raw.length !== 32)
		throw new Error(`master key must be 32 bytes, got ${raw.length}`);
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

/** Encrypts to `v1:<iv base64>:<ciphertext+tag base64>` with a fresh random IV. */
export async function encrypt(
	key: CryptoKey,
	plaintext: string,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			key,
			new TextEncoder().encode(plaintext),
		),
	);
	return `${VERSION}:${iv.toBase64()}:${ct.toBase64()}`;
}

/** Throws on unknown version, malformed input, wrong key or any tampering. */
export async function decrypt(
	key: CryptoKey,
	payload: string,
): Promise<string> {
	const [version, ivB64, ctB64, ...rest] = payload.split(":");
	if (
		version !== VERSION ||
		ivB64 === undefined ||
		ctB64 === undefined ||
		rest.length > 0
	) {
		throw new Error("unsupported ciphertext format");
	}
	const iv = Uint8Array.fromBase64(ivB64);
	if (iv.length !== IV_BYTES) throw new Error("unsupported ciphertext format");
	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		Uint8Array.fromBase64(ctB64),
	);
	return new TextDecoder().decode(pt);
}
