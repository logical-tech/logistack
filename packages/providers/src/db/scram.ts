import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * A Postgres SCRAM-SHA-256 verifier for `password`, the form `pg_authid` stores. Sent as the
 * role's PASSWORD, it keeps the plain text out of the engine and its statement logs.
 */
// shortcut: no SASLprep, so a password with non-ASCII characters that SASLprep would normalize may not log in; normalize NFKC if one ever fails.
export function scramVerifier(
	password: string,
	salt = randomBytes(16),
	iterations = 4096,
): string {
	const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
	const hmac = (key: Buffer, text: string) =>
		createHmac("sha256", key).update(text).digest();
	const stored = createHash("sha256")
		.update(hmac(salted, "Client Key"))
		.digest();
	const server = hmac(salted, "Server Key");
	return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored.toString("base64")}:${server.toString("base64")}`;
}
