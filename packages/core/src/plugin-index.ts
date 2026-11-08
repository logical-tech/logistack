import type { PluginIndexEnvelope, PluginManifest } from "@logistack/contracts";

// The marketplace index (docs/plans/plugins.md, "Marketplace and distribution"): signed JSON an
// instance fetches only on an explicit refresh, checked offline against public keys it trusts.

/** The official index. */
export const OFFICIAL_PLUGIN_INDEX_URL =
	"https://stack.logicaltech.it/plugins/api";
/** The official index's sandbox, trusted only with LOGISTACK_PLUGIN_INDEX_SANDBOX=1. */
export const OFFICIAL_PLUGIN_INDEX_SANDBOX_URL =
	"https://stack.logicaltech.it/plugins/sandbox/api";

/**
 * PLACEHOLDER, replace at release: the official index's signing keys, `keyId` to base64 raw
 * Ed25519 public key. Until then an instance trusts the official index only through
 * LS_PLUGIN_INDEX_PUBLIC_KEY, and refreshing it fails with a signature error.
 */
export const OFFICIAL_PLUGIN_INDEX_KEYS: Record<string, string> = {
	"placeholder-replace-at-release": "",
};

/** `keyId:base64,keyId2:base64` (LS_PLUGIN_INDEX_PUBLIC_KEY) to a key map; malformed parts are dropped. */
export function parsePublicKeys(value: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of value.split(",")) {
		const i = part.indexOf(":");
		const id = part.slice(0, i).trim();
		const key = part.slice(i + 1).trim();
		if (i > 0 && key) out[id] = key;
	}
	return out;
}

export type IndexCheck =
	| { ok: true; payload: unknown; keyId: string }
	| { ok: false; reason: "unknown_key" | "signature" | "malformed" };

/**
 * Pure: checks the envelope's Ed25519 signature over the UTF-8 bytes of `payload` with the key
 * its `keyId` names, then parses the payload JSON. Callers validate the shape with zod.
 */
export async function verifyIndexResponse(
	envelope: PluginIndexEnvelope,
	publicKeys: Record<string, string>,
): Promise<IndexCheck> {
	const raw = Object.hasOwn(publicKeys, envelope.keyId)
		? publicKeys[envelope.keyId]
		: undefined;
	if (!raw) return { ok: false, reason: "unknown_key" };
	let valid = false;
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			// Node's base64 decoder reads both the standard and the url alphabet.
			Uint8Array.from(Buffer.from(raw, "base64")),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		valid = await crypto.subtle.verify(
			{ name: "Ed25519" },
			key,
			Uint8Array.from(Buffer.from(envelope.signature, "base64url")),
			new TextEncoder().encode(envelope.payload),
		);
	} catch {
		valid = false;
	}
	if (!valid) return { ok: false, reason: "signature" };
	try {
		return {
			ok: true,
			payload: JSON.parse(envelope.payload),
			keyId: envelope.keyId,
		};
	} catch {
		return { ok: false, reason: "malformed" };
	}
}

export type ListDiff = { added: string[]; removed: string[] };

const diff = (from: string[], to: string[]): ListDiff => ({
	added: to.filter((x) => !from.includes(x)),
	removed: from.filter((x) => !to.includes(x)),
});

/** What an update changes in what the plugin may do: its token's actions and declared egress. */
export function manifestDiff(
	from: Pick<PluginManifest, "permissions" | "egress">,
	to: Pick<PluginManifest, "permissions" | "egress">,
): { permissions: ListDiff; egress: ListDiff } {
	return {
		permissions: diff(from.permissions, to.permissions),
		egress: diff(from.egress, to.egress),
	};
}
