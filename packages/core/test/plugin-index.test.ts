import { describe, expect, test } from "bun:test";
import {
	readPluginDetail,
	readPluginIndex,
	verifyIndexResponse,
} from "../src/plugin-index.ts";

const b64u = (b: ArrayBuffer) => Buffer.from(b).toString("base64url");

async function signer() {
	const pair = (await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const keyId = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
	const sign = async (payload: string) => ({
		keyId,
		payload,
		signature: b64u(
			await crypto.subtle.sign(
				"Ed25519",
				pair.privateKey,
				new TextEncoder().encode(payload),
			),
		),
	});
	return { keyId, sign };
}

const digest = `sha256:${"a".repeat(64)}`;
const version = {
	version: "1.0.0",
	image: `ghcr.io/acme/notifier@${digest}`,
	manifest: { id: "com.acme.notifier", version: "1.0.0", name: "Notifier" },
	verified: false,
	yanked: false,
	iconUrl: null,
	publishedAt: "2026-11-08T00:00:00.000Z",
};
const entry = {
	id: "com.acme.notifier",
	publisher: "Acme",
	installs: 3,
	latest: version,
	latestVerified: null,
	yanked: [],
};

describe("verifyIndexResponse", () => {
	test("accepts a response signed by a trusted key, as a string or parsed", async () => {
		const s = await signer();
		const payload = JSON.stringify({ v: 1, kind: "index", plugins: [] });
		const env = await s.sign(payload);
		for (const body of [env, JSON.stringify(env)]) {
			const r = await verifyIndexResponse(body, [s.keyId]);
			expect(r).toEqual({
				ok: true,
				keyId: s.keyId,
				payload: JSON.parse(payload),
			});
		}
	});

	test("rejects an untrusted key, a changed byte and junk", async () => {
		const s = await signer();
		const other = await signer();
		const env = await s.sign('{"v":1}');
		expect(await verifyIndexResponse(env, [other.keyId])).toEqual({
			ok: false,
			reason: "unknown_key",
		});
		expect(await verifyIndexResponse(env, [])).toMatchObject({ ok: false });
		expect(
			await verifyIndexResponse({ ...env, payload: '{"v":2}' }, [s.keyId]),
		).toEqual({ ok: false, reason: "signature" });
		// A whitespace change is a different payload: no canonicalization, exact bytes only.
		expect(
			await verifyIndexResponse({ ...env, payload: '{"v": 1}' }, [s.keyId]),
		).toEqual({ ok: false, reason: "signature" });
		expect(await verifyIndexResponse("not json", [s.keyId])).toEqual({
			ok: false,
			reason: "malformed",
		});
		expect(
			await verifyIndexResponse({ ...env, signature: "AAAA" }, [s.keyId]),
		).toMatchObject({ ok: false });
	});

	test("a rotated key verifies while the server trusts both", async () => {
		const old = await signer();
		const next = await signer();
		const env = await next.sign('{"v":1}');
		expect((await verifyIndexResponse(env, [old.keyId, next.keyId])).ok).toBe(
			true,
		);
	});
});

describe("readPluginIndex", () => {
	test("keeps readable entries and counts the rest", () => {
		const r = readPluginIndex({
			v: 1,
			kind: "index",
			issuedAt: "2026-11-08T00:00:00.000Z",
			plugins: [entry, { id: "Not An Id" }],
		});
		expect(r?.plugins).toHaveLength(1);
		expect(r?.plugins[0]?.latest?.manifest.port).toBe(8080);
		expect(r?.skipped).toBe(1);
	});

	test("refuses a detail payload under the index reader", () => {
		expect(readPluginIndex({ v: 1, kind: "plugin", plugins: [] })).toBeNull();
	});
});

describe("readPluginDetail", () => {
	const detail = {
		v: 1,
		kind: "plugin",
		issuedAt: "2026-11-08T00:00:00.000Z",
		plugin: {
			id: "com.acme.notifier",
			publisher: "Acme",
			installs: 0,
			versions: [{ ...version, readme: "# Hi" }],
		},
	};

	test("reads the versions of the plugin asked for", () => {
		expect(
			readPluginDetail(detail, "com.acme.notifier")?.plugin.versions[0]?.readme,
		).toBe("# Hi");
	});

	test("refuses another plugin's answer", () => {
		expect(readPluginDetail(detail, "com.evil.other")).toBeNull();
	});
});
