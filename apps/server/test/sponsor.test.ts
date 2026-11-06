import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signSponsorKey } from "../../../sponsors/src/key.ts";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

describe.skipIf(!hasDocker)("sponsor key", () => {
	let h: Harness;
	let cookie: string;
	const as = () => ({ headers: { cookie } });

	beforeAll(async () => {
		h = await startHarness({ area: "sponsor", label: "sponsor" });
		await h.call("POST", "/api/setup", { body: setupBody });
		cookie = await h.signIn(owner.email, owner.password);
	});
	afterAll(() => h?.close());

	test("starts without a sponsorship and refuses keys LogiStack didn't sign", async () => {
		expect(
			(await h.call("GET", "/api/instance/sponsor", as())).json.state,
		).toBe("none");

		const malformed = await h.call("PUT", "/api/instance/sponsor", {
			...as(),
			body: { key: "not-a-key" },
		});
		expect(malformed.status).toBe(400);

		// Signed, but by a key pair that isn't LogiStack's.
		const pair = (await crypto.subtle.generateKey("Ed25519", true, [
			"sign",
			"verify",
		])) as CryptoKeyPair;
		const pkcs8 = Buffer.from(
			await crypto.subtle.exportKey("pkcs8", pair.privateKey),
		).toString("base64url");
		const now = Math.floor(Date.now() / 1000);
		const foreign = await signSponsorKey(
			{
				v: 1,
				sub: "sub_x",
				kind: "monthly",
				amount: 15,
				currency: "eur",
				iat: now,
				exp: now + 86_400,
			},
			pkcs8,
		);
		const refused = await h.call("PUT", "/api/instance/sponsor", {
			...as(),
			body: { key: foreign },
		});
		expect(refused.status).toBe(400);
		expect(refused.json.error.message).toContain("wasn't signed by LogiStack");

		const removed = await h.call("DELETE", "/api/instance/sponsor", as());
		expect(removed.json.state).toBe("none");
	});
});
