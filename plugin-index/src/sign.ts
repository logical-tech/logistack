import { b64u, fromB64u } from "./http.ts";

// Signs index responses (README.md, "Signed responses"). The verifier LogiStack servers run is
// packages/core/src/plugin-index.ts.

let cached: { pkcs8: string; key: CryptoKey; keyId: string } | undefined;

async function signer(pkcs8: string) {
	if (cached?.pkcs8 === pkcs8) return cached;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		fromB64u(pkcs8),
		{ name: "Ed25519" },
		true,
		["sign"],
	);
	// The private JWK carries the public key as `x`: the key id needs no second secret.
	const { x } = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
	if (!x) throw new Error("SIGNING_KEY is not an Ed25519 key");
	cached = { pkcs8, key, keyId: x };
	return cached;
}

/** `{keyId, payload, signature}`: Ed25519 over the UTF-8 bytes of `payload`, the JSON text sent. */
export async function signPayload(value: unknown, pkcs8: string) {
	const { key, keyId } = await signer(pkcs8);
	const payload = JSON.stringify(value);
	const sig = await crypto.subtle.sign(
		{ name: "Ed25519" },
		key,
		new TextEncoder().encode(payload),
	);
	return { keyId, payload, signature: b64u(sig) };
}
