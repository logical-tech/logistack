import { describe, expect, test } from "bun:test";
import {
	manifestDiff,
	parsePublicKeys,
	satisfiesRange,
	verifyIndexResponse,
} from "../src/index.ts";

const pair = async () => {
	const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const pub = Buffer.from(
		await crypto.subtle.exportKey("raw", k.publicKey),
	).toString("base64");
	const sign = async (payload: string) =>
		Buffer.from(
			await crypto.subtle.sign(
				{ name: "Ed25519" },
				k.privateKey,
				new TextEncoder().encode(payload),
			),
		).toString("base64url");
	return { pub, sign };
};

describe("verifyIndexResponse", () => {
	test("accepts a payload signed by a trusted key and parses it", async () => {
		const { pub, sign } = await pair();
		const payload = JSON.stringify({ indexName: "Ünïcode index", plugins: [] });
		const r = await verifyIndexResponse(
			{ payload, keyId: "k1", signature: await sign(payload) },
			{ k1: pub },
		);
		expect(r).toEqual({
			ok: true,
			keyId: "k1",
			payload: { indexName: "Ünïcode index", plugins: [] },
		});
	});

	test("refuses a tampered payload, another key and an unknown key id", async () => {
		const a = await pair();
		const b = await pair();
		const payload = '{"plugins":[]}';
		const signature = await a.sign(payload);
		expect(
			await verifyIndexResponse(
				{ payload: '{"plugins":[1]}', keyId: "k1", signature },
				{ k1: a.pub },
			),
		).toEqual({ ok: false, reason: "signature" });
		expect(
			await verifyIndexResponse(
				{ payload, keyId: "k1", signature },
				{ k1: b.pub },
			),
		).toEqual({ ok: false, reason: "signature" });
		expect(
			await verifyIndexResponse(
				{ payload, keyId: "k2", signature },
				{ k1: a.pub },
			),
		).toEqual({ ok: false, reason: "unknown_key" });
		expect(
			await verifyIndexResponse(
				{ payload, keyId: "toString", signature },
				{ k1: a.pub },
			),
		).toEqual({ ok: false, reason: "unknown_key" });
		expect(
			await verifyIndexResponse(
				{ payload, keyId: "k1", signature: "!!" },
				{ k1: "not a key" },
			),
		).toEqual({ ok: false, reason: "signature" });
	});

	test("a signed payload that is not JSON is malformed", async () => {
		const { pub, sign } = await pair();
		expect(
			await verifyIndexResponse(
				{ payload: "nope", keyId: "k", signature: await sign("nope") },
				{ k: pub },
			),
		).toEqual({ ok: false, reason: "malformed" });
	});
});

test("parsePublicKeys", () => {
	expect(parsePublicKeys("a:AAA=, b:BBB")).toEqual({ a: "AAA=", b: "BBB" });
	expect(parsePublicKeys("nokey,:x,")).toEqual({});
});

test("satisfiesRange", () => {
	expect(satisfiesRange("0.6.0", ">=0.6.0")).toBe(true);
	expect(satisfiesRange("0.5.9", ">=0.6.0")).toBe(false);
	expect(satisfiesRange("0.7.1", ">= 0.6.0 <1.0.0")).toBe(true);
	expect(satisfiesRange("1.0.0", ">=0.6.0 <1.0.0")).toBe(false);
	expect(satisfiesRange("1.0.0-rc.1", "<1.0.0")).toBe(true);
	expect(satisfiesRange("1.4.0", "^1.2.0")).toBe(true);
	expect(satisfiesRange("2.0.0-beta.1", "^1.2.0")).toBe(false);
	expect(satisfiesRange("0.3.9", "^0.3.1")).toBe(true);
	expect(satisfiesRange("0.4.0", "^0.3.1")).toBe(false);
	expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
	expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
	expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
	expect(satisfiesRange("2.1.0", "<1.0.0 || >=2.0.0")).toBe(true);
	expect(satisfiesRange("1.0.0", "*")).toBe(true);
	expect(satisfiesRange("1.0.0", "1.0.0")).toBe(true);
	expect(satisfiesRange("1.0.0", "garbage")).toBe(false);
	expect(satisfiesRange("1.0.0", "")).toBe(false);
});

test("manifestDiff", () => {
	expect(
		manifestDiff(
			{ permissions: ["read"], egress: ["a.com", "b.com"] },
			{ permissions: ["read", "write"], egress: ["b.com"] },
		),
	).toEqual({
		permissions: { added: ["write"], removed: [] },
		egress: { added: [], removed: ["a.com"] },
	});
});
