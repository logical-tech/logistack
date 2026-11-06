import { expect, test } from "bun:test";
import { signSponsorKey } from "../../../sponsors/src/key.ts";
import { checkSponsorKey } from "../src/sponsor.ts";

const pair = (await crypto.subtle.generateKey("Ed25519", true, [
	"sign",
	"verify",
])) as CryptoKeyPair;
const b64u = (b: ArrayBuffer) => Buffer.from(b).toString("base64url");
const priv = b64u(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
const pub = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));

const claims = {
	v: 1 as const,
	sub: "sub_123",
	kind: "monthly" as const,
	amount: 15,
	currency: "eur",
	iat: 1_800_000_000,
	exp: 1_800_000_000 + 37 * 86_400,
};

test("a key the sponsors Worker signs verifies on an instance", async () => {
	const key = await signSponsorKey(claims, priv);
	expect(await checkSponsorKey(key, claims.iat * 1000, [pub])).toEqual({
		ok: true,
		claims,
		expired: false,
		sandbox: false,
	});
	const later = await checkSponsorKey(key, (claims.exp + 1) * 1000, [pub]);
	expect(later.ok && later.expired).toBe(true);
});

test("a tampered or foreign key is refused", async () => {
	const key = await signSponsorKey(claims, priv);
	const [payload, sig] = key.slice(4).split(".");
	const forged = Buffer.from(
		JSON.stringify({ ...claims, exp: claims.exp + 1e6 }),
	).toString("base64url");
	expect(await checkSponsorKey(`lss_${forged}.${sig}`, 0, [pub])).toEqual({
		ok: false,
		reason: "signature",
	});
	expect(await checkSponsorKey(`lss_${payload}.${sig}`, 0)).toEqual({
		ok: false,
		reason: "signature",
	});
	expect(await checkSponsorKey("lsk_nope", 0, [pub])).toEqual({
		ok: false,
		reason: "malformed",
	});
});
