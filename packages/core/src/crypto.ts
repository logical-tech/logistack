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

// --- v2: envelope encryption for managed secrets -------------------------------------
// master key --HKDF--> KEK --wraps--> per-organization DEKs --seal--> values.
// Every v2 ciphertext authenticates an AAD naming the row it belongs to, so a ciphertext
// copied into another row, organization or version fails to open.

const V2 = "v2";
const encoder = new TextEncoder();

/** Derives the key that wraps organization data keys. The raw master key never touches v2 data. */
export async function deriveSecretsKek(
	masterKeyBase64: string,
): Promise<CryptoKey> {
	const raw = Uint8Array.fromBase64(masterKeyBase64.trim());
	if (raw.length !== 32)
		throw new Error(`master key must be 32 bytes, got ${raw.length}`);
	const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: encoder.encode("logistack/secrets"),
			info: encoder.encode("logistack/secrets/kek/v1"),
		},
		ikm,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/**
 * The `encryption_key` of Caddy's Redis storage (pberkel/caddy-storage-redis): 32 hex
 * characters, whose ASCII bytes are its AES-256-GCM key. Derived, so it never needs storing.
 */
export async function deriveCaddyStorageKey(
	masterKeyBase64: string,
): Promise<string> {
	const raw = Uint8Array.fromBase64(masterKeyBase64.trim());
	const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: encoder.encode("logistack/caddy-storage"),
			info: encoder.encode("logistack/caddy-storage/v1"),
		},
		ikm,
		128,
	);
	return new Uint8Array(bits).toHex();
}

/** Encrypts to `v2:<iv base64>:<ciphertext+tag base64>`, authenticating `aad`. */
export async function seal(
	key: CryptoKey,
	aad: string,
	plaintext: string | Uint8Array<ArrayBuffer>,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const data =
		typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext;
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
			key,
			data,
		),
	);
	return `${V2}:${iv.toBase64()}:${ct.toBase64()}`;
}

async function openBytes(
	key: CryptoKey,
	aad: string,
	payload: string,
): Promise<Uint8Array<ArrayBuffer>> {
	const [version, ivB64, ctB64, ...rest] = payload.split(":");
	if (version !== V2 || !ivB64 || ctB64 === undefined || rest.length > 0)
		throw new Error("unsupported ciphertext format");
	const iv = Uint8Array.fromBase64(ivB64);
	if (iv.length !== IV_BYTES) throw new Error("unsupported ciphertext format");
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
			key,
			Uint8Array.fromBase64(ctB64),
		),
	);
}

/** Throws on a wrong key, a different `aad`, an unknown format or any tampering. */
export async function unseal(
	key: CryptoKey,
	aad: string,
	payload: string,
): Promise<string> {
	return new TextDecoder().decode(await openBytes(key, aad, payload));
}

export const dataKeyAad = (organizationId: string, version: number) =>
	`secret_key:${organizationId}:${version}`;

export const secretValueAad = (
	organizationId: string,
	secretId: string,
	version: number,
) => `secret_version:${organizationId}:${secretId}:${version}`;

/** A fresh organization data key, wrapped by the KEK. Only the wrapped form is ever stored. */
export async function newWrappedDataKey(
	kek: CryptoKey,
	organizationId: string,
	version: number,
): Promise<string> {
	const raw = crypto.getRandomValues(new Uint8Array(32));
	try {
		return await seal(kek, dataKeyAad(organizationId, version), raw);
	} finally {
		raw.fill(0);
	}
}

/** Unwraps a data key into a non-extractable AES-GCM key. */
export async function unwrapDataKey(
	kek: CryptoKey,
	organizationId: string,
	version: number,
	wrapped: string,
): Promise<CryptoKey> {
	const raw = await openBytes(
		kek,
		dataKeyAad(organizationId, version),
		wrapped,
	);
	try {
		if (raw.length !== 32) throw new Error("data key must be 32 bytes");
		return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
			"encrypt",
			"decrypt",
		]);
	} finally {
		raw.fill(0);
	}
}
