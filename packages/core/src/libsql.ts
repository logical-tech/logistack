import { generateKeyPairSync, sign } from "node:crypto";

export const LIBSQL_ENV = {
	/** sqld reads the Ed25519 public key (base64url) from here and accepts JWTs it signed. */
	jwtKey: "SQLD_AUTH_JWT_KEY",
	/** Full-access token apps pass as `authToken`; the backup dump uses it too. */
	authToken: "LIBSQL_AUTH_TOKEN",
} as const;

/** Bash, no single quotes: exits 0 once sqld answers its unauthenticated /health. The image has no curl. */
export const LIBSQL_HEALTH =
	'exec 3<>/dev/tcp/127.0.0.1/8080 && printf "GET /health HTTP/1.0\\r\\n\\r\\n" >&3 && IFS= read -r l <&3 && [[ $l == *" 200 "* ]]';

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

/**
 * Credentials a new libSQL service is created with. The private key signs one non-expiring
 * token and is then dropped: rotating means minting a new pair.
 */
export function libsqlCredentials(): Record<string, string> {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const x = publicKey.export({ format: "jwk" }).x as string;
	const payload = `${b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }))}.${b64url(JSON.stringify({ a: "rw" }))}`;
	const signature = b64url(sign(null, Buffer.from(payload), privateKey));
	return {
		[LIBSQL_ENV.jwtKey]: x,
		[LIBSQL_ENV.authToken]: `${payload}.${signature}`,
	};
}
