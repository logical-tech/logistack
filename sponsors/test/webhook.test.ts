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
	const store = new Map<string, { value: string; metadata: unknown }>();
	const kv = { get: (k: string) => store.get(k)?.value };
	const sent: string[] = [];
	const env = {
		SPONSORS: {
			get: async (k: string) => store.get(k)?.value ?? null,
			getWithMetadata: async (k: string) => ({
				value: store.get(k)?.value ?? null,
				metadata: store.get(k)?.metadata ?? null,
			}),
			put: async (k: string, value: string, o?: { metadata?: unknown }) =>
				void store.set(k, { value, metadata: o?.metadata ?? null }),
			delete: async (k: string) => void store.delete(k),
			list: async ({ prefix }: { prefix: string }) => ({
				keys: [...store]
					.filter(([k]) => k.startsWith(prefix))
					.map(([name, e]) => ({ name, metadata: e.metadata })),
				list_complete: true,
			}),
		},
		RESEND_API_KEY: "re_test",
		SIGNING_KEY: pkcs8,
		STRIPE_WEBHOOK_SECRET: secret,
		SITE_ORIGIN: "https://site.test",
		EMAIL_FROM: "sponsors@site.test",
	} as unknown as Env;
	// Stands in for Resend: fails the first `failSends` requests with a 500.
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		if (failSends-- > 0)
			return new Response("domain not ready", { status: 500 });
		const body = JSON.parse(String(init.body)) as { text: string };
		sent.push(body.text);
		return Response.json({ id: "email_1" });
	}) as typeof fetch;
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

const get = (env: Env, path: string) =>
	worker.fetch(
		new Request(`https://w.test${path}`),
		env,
		{} as ExecutionContext,
	);

test("a name and website from the payment page reach the email and the public list, until cancelled", async () => {
	const { env, sent } = fakeEnv(0);
	const fields = [
		{ key: "sponsorname", text: { value: "  Ada <b>Lovelace</b> " } },
		{ key: "website", text: { value: "ada.dev/?utm=x" } },
		{ key: "instance", text: { value: "https://paas.ada.dev/projects" } },
	];
	const session = {
		...checkout.data.object,
		id: "cs_test_2",
		mode: "subscription",
		subscription: "sub_2",
		custom_fields: fields,
	};
	await deliver(env, {
		type: "checkout.session.completed",
		data: { object: session },
	});

	expect(sent[0]).toContain("Thank you, Ada bLovelace/b.");
	expect(sent[0]).toContain("https://paas.ada.dev/settings/sponsor#key=lss_");
	const wall = await (await get(env, "/v1/sponsors")).json();
	expect(wall).toEqual({
		sponsors: [
			{ name: "Ada bLovelace/b", website: "https://ada.dev", kind: "monthly" },
		],
	});
	const s = await (await get(env, "/v1/sessions/cs_test_2")).json();
	expect(s.instance).toBe("https://paas.ada.dev");

	await deliver(env, {
		type: "customer.subscription.deleted",
		data: { object: { id: "sub_2" } },
	});
	expect(await (await get(env, "/v1/sponsors")).json()).toEqual({
		sponsors: [],
	});
});

test("a sponsor who leaves the fields empty stays off the public list", async () => {
	const { env } = fakeEnv(0);
	await deliver(env, checkout);
	expect(await (await get(env, "/v1/sponsors")).json()).toEqual({
		sponsors: [],
	});
});
