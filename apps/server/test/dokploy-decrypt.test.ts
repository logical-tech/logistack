import { expect, test } from "bun:test";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import {
	decryptDokploy,
	dokployKeys,
	isDokployEncrypted,
} from "../src/migration/dokploy/decrypt.ts";

/** Encrypts the way Dokploy's format is documented: iv | tag | ciphertext after `enc:v1:`. */
function seal(value: string, secret: string) {
	const key = createHmac("sha256", secret)
		.update("dokploy:db-encryption:v1")
		.digest();
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
	return `enc:v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}

test("Dokploy's encrypted env opens with the secret it was sealed with", async () => {
	const sealed = seal("DATABASE_URL=postgres://u:p@db:5432/x", "auth-secret");
	expect(isDokployEncrypted(sealed)).toBe(true);
	const keys = await dokployKeys(["wrong", "auth-secret"]);
	expect(await decryptDokploy(sealed, keys)).toBe(
		"DATABASE_URL=postgres://u:p@db:5432/x",
	);
	expect(
		await decryptDokploy(sealed, await dokployKeys(["wrong"])),
	).toBeUndefined();
	expect(await decryptDokploy("PLAIN=1", keys)).toBe("PLAIN=1");
	expect(await decryptDokploy(null, keys)).toBeNull();
});
