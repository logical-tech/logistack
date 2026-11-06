import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyStripeSignature } from "../src/stripe.ts";

const secret = "whsec_test";
const body = '{"type":"checkout.session.completed"}';
const sign = (t: number, b = body) =>
	`t=${t},v1=${createHmac("sha256", secret).update(`${t}.${b}`).digest("hex")}`;

test("accepts Stripe's signature and rejects tampering, staleness and a missing header", async () => {
	const t = 1_800_000_000;
	expect(await verifyStripeSignature(body, sign(t), secret, t)).toBe(true);
	expect(await verifyStripeSignature(`${body} `, sign(t), secret, t)).toBe(
		false,
	);
	expect(await verifyStripeSignature(body, sign(t), secret, t + 301)).toBe(
		false,
	);
	expect(await verifyStripeSignature(body, null, secret, t)).toBe(false);
});
