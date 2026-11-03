import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { LIBSQL_ENV, libsqlCredentials } from "../src/libsql.ts";

test("the token is an EdDSA JWT the minted public key verifies", () => {
	const env = libsqlCredentials();
	const x = env[LIBSQL_ENV.jwtKey] as string;
	const [header, payload, signature] = (
		env[LIBSQL_ENV.authToken] as string
	).split(".") as [string, string, string];
	const json = (s: string) =>
		JSON.parse(Buffer.from(s, "base64url").toString());
	expect(json(header)).toEqual({ alg: "EdDSA", typ: "JWT" });
	expect(json(payload)).toEqual({ a: "rw" });
	const key = createPublicKey({
		key: { kty: "OKP", crv: "Ed25519", x },
		format: "jwk",
	});
	expect(
		verify(
			null,
			Buffer.from(`${header}.${payload}`),
			key,
			Buffer.from(signature, "base64url"),
		),
	).toBe(true);
	expect(libsqlCredentials()[LIBSQL_ENV.jwtKey]).not.toBe(x);
});
