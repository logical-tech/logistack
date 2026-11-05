/**
 * Coolify encrypts secrets with Laravel's encrypter: `base64(JSON {iv, value, mac, tag})`,
 * AES-256-CBC with PKCS#7, and `mac` = hex HMAC-SHA256(iv_b64 . value_b64) under the same key, its
 * `APP_KEY` (`base64:` + 32 bytes). Columns cast `encrypted` hold the plaintext as is; env values
 * go through Laravel's `encrypt()`, which PHP-serializes first (`s:5:"hello";`). Written from that
 * format; nothing of Coolify's or Laravel's code is reused.
 */

export type LaravelKey = { aes: CryptoKey; hmac: CryptoKey };

export async function laravelKey(appKey: string): Promise<LaravelKey> {
	const raw = appKey.startsWith("base64:")
		? Buffer.from(appKey.slice(7), "base64")
		: Buffer.from(appKey, "utf8");
	if (raw.length !== 32)
		throw new Error("APP_KEY is not 32 bytes: Coolify uses AES-256-CBC");
	return {
		aes: await crypto.subtle.importKey("raw", raw, "AES-CBC", false, [
			"decrypt",
		]),
		hmac: await crypto.subtle.importKey(
			"raw",
			raw,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		),
	};
}

type Payload = { iv: string; value: string; mac: string };

/** The payload, if `v` looks like one; plaintext rows (older Coolify) are not. */
function payloadOf(v: string): Payload | undefined {
	if (!/^[A-Za-z0-9+/=]{40,}$/.test(v)) return undefined;
	try {
		const p = JSON.parse(Buffer.from(v, "base64").toString("utf8"));
		return typeof p?.iv === "string" &&
			typeof p.value === "string" &&
			typeof p.mac === "string"
			? p
			: undefined;
	} catch {
		return undefined;
	}
}

export const isLaravelEncrypted = (v: string | null | undefined) =>
	!!v && payloadOf(v) !== undefined;

/** Decrypts one payload; throws when the MAC does not verify under any key. */
export async function decryptLaravel(
	v: string,
	keys: LaravelKey[],
): Promise<string> {
	const p = payloadOf(v);
	if (!p) throw new Error("not a Laravel payload");
	const mac = Buffer.from(p.mac, "hex");
	const signed = new TextEncoder().encode(p.iv + p.value);
	for (const key of keys) {
		if (!(await crypto.subtle.verify("HMAC", key.hmac, mac, signed))) continue;
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-CBC", iv: Buffer.from(p.iv, "base64") },
			key.aes,
			Buffer.from(p.value, "base64"),
		);
		return new TextDecoder().decode(plain);
	}
	throw new Error("no key opens it");
}

/** PHP's serialized string, `s:<bytes>:"…";`, unwrapped; anything else is returned as it is. */
export function unserializeString(v: string): string {
	const m = /^s:(\d+):"([\s\S]*)";$/.exec(v);
	return m && Buffer.byteLength(m[2] as string) === Number(m[1])
		? (m[2] as string)
		: v;
}

/**
 * A column value as Coolify reads it: decrypted (and unserialized, for env values), or kept as
 * is when the row predates encryption. `undefined` means no key opens it: the caller notes the
 * column, never the value.
 */
export async function openCoolify(
	v: string | null,
	keys: LaravelKey[],
	opts: { serialized?: boolean } = {},
): Promise<string | null | undefined> {
	if (v === null || v === "") return v;
	if (!isLaravelEncrypted(v)) return opts.serialized ? unserializeString(v) : v;
	try {
		const plain = await decryptLaravel(v, keys);
		// `encrypt()` serializes; a cast column written by an older release may have been too.
		return unserializeString(plain);
	} catch {
		return undefined;
	}
}
