import { expect, test } from "bun:test";
import { encrypt, importMasterKey } from "@logistack/core";
import type { Deps } from "../src/env.ts";
import { readShareToken, shareToken } from "../src/storage.ts";

test("share tokens open only as share tokens", async () => {
	const deps = {
		masterKey: await importMasterKey(Buffer.alloc(32, 3).toString("base64")),
	} as Deps;
	const p = { s: "svc_1", b: "bucket", k: "a.txt", e: Date.now() + 60_000 };
	expect(await readShareToken(deps, await shareToken(deps, p))).toEqual(p);
	// Any other master-key ciphertext of the same shape is not a link.
	const plain = Buffer.from(
		await encrypt(deps.masterKey, JSON.stringify(p)),
	).toString("base64url");
	await expect(readShareToken(deps, plain)).rejects.toThrow(
		"link expired or invalid",
	);
});
