import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import worker, { type Env } from "../src/index.ts";

const secret = "whsec_test";
const pair = (await crypto.subtle.generateKey("Ed25519", true, [
	"sign",
	"verify",
])) as CryptoKeyPair;
const pkcs8 = Buffer.from(
	await crypto.subtle.exportKey("pkcs8", pair.privateKey),
).toString("base64url");

function fakeEnv(failSends: number) {
	const kv = new Map<string, string>();
	const sent: string[] = [];
	const env = {
		SPONSORS: {
			get: async (k: string) => kv.get(k) ?? null,
			put: async (k: string, v: string) => void kv.set(k, v),
			delete: async (k: string) => void kv.delete(k),
		},
		EMAIL: {
			send: async (m: { text: string }) => {
				if (failSends-- > 0) throw new Error("sending not enabled");
				sent.push(m.text);
			},
		},
		SIGNING_KEY: pkcs8,
		STRIPE_WEBHOOK_SECRET: secret,
		SITE_ORIGIN: "https://site.test",
		EMAIL_FROM: "sponsors@site.test",
	} as unknown as Env;
	return { env, kv, sent };
}

function deliver(env: Env, event: unknown) {
	const body = JSON.stringify(event);
	const t = Math.floor(Date.now() / 1000);
	const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
	return worker.fetch(
		new Request("https://w.test/stripe/webhook", {
			method: "POST",
			body,
			headers: { "Stripe-Signature": `t=${t},v1=${sig}` },
		}),
		env,
		{} as ExecutionContext,
	);
}

const checkout = {
	type: "checkout.session.completed",
	data: {
		object: {
			id: "cs_test_1",
			mode: "payment",
			payment_status: "paid",
			amount_total: 500,
			currency: "eur",
			subscription: null,
			customer_details: { email: "a@example.com" },
		},
	},
};

test("a failed email makes Stripe retry, and the retry mails the same key once", async () => {
	const { env, kv, sent } = fakeEnv(1);
	expect((await deliver(env, checkout)).status).toBe(500);
	const key = kv.get("session:cs_test_1");
	expect(key).toStartWith("lss_");
	expect(sent).toHaveLength(0);

	expect((await deliver(env, checkout)).status).toBe(200);
	expect(kv.get("session:cs_test_1")).toBe(key);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(key as string);

	expect((await deliver(env, checkout)).status).toBe(200);
	expect(sent).toHaveLength(1);
});
