import { expect, test } from "bun:test";
import {
	decrypt,
	deriveSecretsKek,
	importMasterKey,
	newWrappedDataKey,
	seal,
	secretValueAad,
	unseal,
	unwrapDataKey,
} from "../src/crypto.ts";

const master = crypto.getRandomValues(new Uint8Array(32)).toBase64();
const kek = await deriveSecretsKek(master);
const dek = await unwrapDataKey(
	kek,
	"org_a",
	1,
	await newWrappedDataKey(kek, "org_a", 1),
);
const aad = secretValueAad("org_a", "sec_1", 1);

test("round-trips values bound to their row", async () => {
	for (const s of ["", "postgres://u:p@h/db", "päss✓🔑", "x".repeat(65_536)])
		expect(await unseal(dek, aad, await seal(dek, aad, s))).toBe(s);
});

test("a ciphertext moved to another row, version or org does not open", async () => {
	const ct = await seal(dek, aad, "secret");
	for (const other of [
		secretValueAad("org_a", "sec_2", 1),
		secretValueAad("org_a", "sec_1", 2),
		secretValueAad("org_b", "sec_1", 1),
	])
		await expect(unseal(dek, other, ct)).rejects.toThrow();
});

test("tampering, wrong keys and v1 payloads are rejected", async () => {
	const ct = await seal(dek, aad, "secret");
	const [v, iv, body] = ct.split(":") as [string, string, string];
	const bytes = Uint8Array.fromBase64(body);
	bytes[0] = (bytes[0] ?? 0) ^ 1;
	await expect(
		unseal(dek, aad, `${v}:${iv}:${bytes.toBase64()}`),
	).rejects.toThrow();
	const otherDek = await unwrapDataKey(
		kek,
		"org_a",
		2,
		await newWrappedDataKey(kek, "org_a", 2),
	);
	await expect(unseal(otherDek, aad, ct)).rejects.toThrow();
	await expect(unseal(dek, aad, ct.replace(/^v2/, "v1"))).rejects.toThrow();
});

test("a wrapped data key opens only for its org and version, under its KEK", async () => {
	const wrapped = await newWrappedDataKey(kek, "org_a", 3);
	await expect(unwrapDataKey(kek, "org_b", 3, wrapped)).rejects.toThrow();
	await expect(unwrapDataKey(kek, "org_a", 4, wrapped)).rejects.toThrow();
	const otherKek = await deriveSecretsKek(
		crypto.getRandomValues(new Uint8Array(32)).toBase64(),
	);
	await expect(unwrapDataKey(otherKek, "org_a", 3, wrapped)).rejects.toThrow();
});

test("the KEK is not the raw master key", async () => {
	const ct = await seal(kek, "x", "secret");
	const raw = await importMasterKey(master);
	await expect(decrypt(raw, ct.replace(/^v2/, "v1"))).rejects.toThrow();
});
