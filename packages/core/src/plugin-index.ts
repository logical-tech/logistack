import {
	PluginDetailPayload,
	PluginIndexEntry,
	PluginIndexPayload,
	PluginIndexVersion,
	SignedIndexResponse,
} from "@logistack/contracts";

/**
 * Plugin index responses (plugin-index/README.md): `{keyId, payload, signature}`, where
 * `payload` is the exact JSON text the index signed with Ed25519 and `keyId` is the signer's
 * base64url raw public key. A server trusts a response only when `keyId` is one of the keys
 * it ships with, so a key rotates by shipping the new one next to the old one first.
 */
export const PLUGIN_INDEX_URL = "https://stack.logicaltech.it/plugins/api";

/** Public keys of the official index (generated at deploy, 2026-11-09; plugin-index/README.md). */
export const PLUGIN_INDEX_KEYS: readonly string[] = [
	"gQ_dPyISF8twX84LNy9qmbMTRlTt0KWLDL2WJr0NPi8",
];

/** Public keys of the official index's sandbox (`LOGISTACK_PLUGIN_INDEX_SANDBOX=1`). */
export const PLUGIN_INDEX_SANDBOX_KEYS: readonly string[] = [
	"_YeDic33G6pPhXBm4blK3jGaOJ06W3B6XDRQ4N72eL8",
];

export type IndexCheck =
	| { ok: true; keyId: string; payload: unknown }
	| { ok: false; reason: "malformed" | "unknown_key" | "signature" };

const fromB64u = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

/** Checks the envelope's signature against `trustedKeys` and parses the signed JSON. */
export async function verifyIndexResponse(
	body: unknown,
	trustedKeys: readonly string[],
): Promise<IndexCheck> {
	let raw = body;
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return { ok: false, reason: "malformed" };
		}
	}
	const env = SignedIndexResponse.safeParse(raw);
	if (!env.success) return { ok: false, reason: "malformed" };
	const { keyId, payload, signature } = env.data;
	if (!trustedKeys.includes(keyId)) return { ok: false, reason: "unknown_key" };
	let valid = false;
	try {
		const pub = await crypto.subtle.importKey(
			"raw",
			fromB64u(keyId),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		valid = await crypto.subtle.verify(
			{ name: "Ed25519" },
			pub,
			fromB64u(signature),
			new TextEncoder().encode(payload),
		);
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (!valid) return { ok: false, reason: "signature" };
	try {
		return { ok: true, keyId, payload: JSON.parse(payload) };
	} catch {
		return { ok: false, reason: "malformed" };
	}
}

/** Reads a verified `GET /v1/index` payload. Entries this server cannot parse (a newer schema) are skipped and counted. */
export function readPluginIndex(payload: unknown) {
	const p = PluginIndexPayload.safeParse(payload);
	if (!p.success) return null;
	const plugins: PluginIndexEntry[] = [];
	let skipped = 0;
	for (const e of p.data.plugins) {
		const entry = PluginIndexEntry.safeParse(e);
		if (entry.success) plugins.push(entry.data);
		else skipped++;
	}
	return { issuedAt: p.data.issuedAt, plugins, skipped };
}

/** Reads a verified `GET /v1/plugins/{id}` payload; null unless it is about `id`, so one plugin's answer cannot stand in for another's. */
export function readPluginDetail(payload: unknown, id: string) {
	const p = PluginDetailPayload.safeParse(payload);
	if (!p.success || p.data.plugin.id !== id) return null;
	const versions: PluginIndexVersion[] = [];
	let skipped = 0;
	for (const v of p.data.plugin.versions) {
		const version = PluginIndexVersion.safeParse(v);
		if (version.success) versions.push(version.data);
		else skipped++;
	}
	return {
		issuedAt: p.data.issuedAt,
		plugin: { ...p.data.plugin, versions },
		skipped,
	};
}
