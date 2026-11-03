import { expect, test } from "bun:test";
import { decrypt, encrypt, importMasterKey } from "../src/crypto.ts";

const keyB64 = () => crypto.getRandomValues(new Uint8Array(32)).toBase64();
const key = await importMasterKey(keyB64());

function flipFirstByte(b64: string): string {
	const bytes = Uint8Array.fromBase64(b64);
	bytes[0] = (bytes[0] ?? 0) ^ 1;
	return bytes.toBase64();
}

test("round-trips unicode and empty strings", async () => {
	for (const s of ["", "postgres://u:p@h/db", "päss✓🔑", "x".repeat(100_000)]) {
		expect(await decrypt(key, await encrypt(key, s))).toBe(s);
	}
});

test("versioned format with a fresh IV per call", async () => {
	const a = await encrypt(key, "same");
	const b = await encrypt(key, "same");
	expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
	expect(a).not.toBe(b);
	expect(Uint8Array.fromBase64(a.split(":")[1] ?? "").length).toBe(12);
});

test("detects tampering with ciphertext or iv", async () => {
	const [v, iv, ct] = (await encrypt(key, "secret")).split(":") as [
		string,
		string,
		string,
	];
	await expect(
		decrypt(key, `${v}:${iv}:${flipFirstByte(ct)}`),
	).rejects.toThrow();
	await expect(
		decrypt(key, `${v}:${flipFirstByte(iv)}:${ct}`),
	).rejects.toThrow();
	await expect(decrypt(key, `${v}:${iv}:${ct.slice(0, -4)}`)).rejects.toThrow();
});

test("rejects the wrong key", async () => {
	const other = await importMasterKey(keyB64());
	await expect(decrypt(other, await encrypt(key, "secret"))).rejects.toThrow();
});

test("rejects unknown versions and malformed payloads", async () => {
	const good = await encrypt(key, "secret");
	for (const bad of [
		good.replace(/^v1/, "v2"),
		"plaintext",
		"v1:only-two",
		`${good}:extra`,
		"v1:AAAA:AAAA",
	]) {
		await expect(decrypt(key, bad)).rejects.toThrow();
	}
});

test("master key must be exactly 32 bytes", async () => {
	await expect(importMasterKey(new Uint8Array(16).toBase64())).rejects.toThrow(
		"32 bytes",
	);
	await expect(importMasterKey("change-me-32-bytes-base64")).rejects.toThrow();
});
