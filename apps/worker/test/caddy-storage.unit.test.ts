import { expect, test } from "bun:test";
import { deriveCaddyStorageKey } from "@logistack/core";
import { openFile, sealFile } from "../src/caddy-storage.ts";

test("caddy storage values round-trip, sealed only with a key", async () => {
	const key = await deriveCaddyStorageKey(btoa("k".repeat(32)));
	expect(key).toMatch(/^[0-9a-f]{32}$/);
	const pem = new TextEncoder().encode("-----BEGIN EC PRIVATE KEY-----");
	const now = new Date("2026-11-07T00:00:00Z");

	const plain = await sealFile(pem, now);
	expect(plain).toMatchObject({ encryption: 0, size: pem.length });
	expect(await openFile(plain)).toEqual(pem);

	const sealed = await sealFile(pem, now, key);
	expect(sealed).toMatchObject({ encryption: 1, size: pem.length });
	// nonce (12) + ciphertext + GCM tag (16)
	expect(Uint8Array.fromBase64(sealed.value).length).toBe(12 + pem.length + 16);
	expect(await openFile(sealed, key)).toEqual(pem);
	await expect(openFile(sealed)).rejects.toThrow("encryption is off");
	await expect(openFile(sealed, "f".repeat(32))).rejects.toThrow();
});
