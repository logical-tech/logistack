import { deriveCaddyStorageKey } from "@logistack/core";
import type { Ctx } from "./ctx.ts";

/**
 * Values in Caddy's Redis storage (pberkel/caddy-storage-redis): JSON with the file bytes in
 * `value`, AES-256-GCM sealed as nonce || ciphertext || tag when `encryption` is 1.
 */
export type StoredFile = {
	value: string;
	modified: string;
	size: number;
	compression: number;
	encryption: number;
};

const NONCE_BYTES = 12;

/** The storage key when encryption is on, else undefined. */
export async function caddyStorageKey(ctx: Ctx): Promise<string | undefined> {
	if (!ctx.cfg.LS_CADDY_STORAGE_ENCRYPTION) return undefined;
	return deriveCaddyStorageKey(ctx.cfg.LOGISTACK_MASTER_KEY);
}

const aes = (key: string, use: "encrypt" | "decrypt") =>
	crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		"AES-GCM",
		false,
		[use],
	);

export async function sealFile(
	bytes: Uint8Array<ArrayBuffer>,
	now: Date,
	key?: string,
): Promise<StoredFile> {
	let value = bytes;
	if (key) {
		const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
		const sealed = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv },
				await aes(key, "encrypt"),
				bytes,
			),
		);
		value = new Uint8Array(NONCE_BYTES + sealed.length);
		value.set(iv);
		value.set(sealed, NONCE_BYTES);
	}
	return {
		value: value.toBase64(),
		modified: now.toISOString(),
		size: bytes.length,
		compression: 0,
		encryption: key ? 1 : 0,
	};
}

/** The file's bytes. Throws on a compressed value, or an encrypted one without the key. */
export async function openFile(
	file: StoredFile,
	key?: string,
): Promise<Uint8Array> {
	if (file.compression) throw new Error("compressed values are not supported");
	const raw = Uint8Array.fromBase64(file.value);
	if (!file.encryption) return raw;
	if (!key) throw new Error("encrypted, and storage encryption is off");
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: raw.subarray(0, NONCE_BYTES) },
			await aes(key, "decrypt"),
			raw.subarray(NONCE_BYTES),
		),
	);
}
