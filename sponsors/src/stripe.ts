/** Checks a `Stripe-Signature` header the way Stripe's SDKs do, without pulling the SDK in. */
export async function verifyStripeSignature(
	body: string,
	header: string | null,
	secret: string,
	nowSeconds = Math.floor(Date.now() / 1000),
	toleranceSeconds = 300,
): Promise<boolean> {
	if (!header) return false;
	const parts = header
		.split(",")
		.map((p) => p.split("=", 2) as [string, string]);
	const t = Number(parts.find(([k]) => k === "t")?.[1]);
	const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
	if (!t || !signatures.length || Math.abs(nowSeconds - t) > toleranceSeconds)
		return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(`${t}.${body}`),
		),
	);
	const expected = [...mac]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return signatures.some((s) => timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** The fields of the events we handle. Stripe sends far more; parsing stops here. */
export type CheckoutSession = {
	id: string;
	mode: "payment" | "subscription" | "setup";
	payment_status: string;
	amount_total: number | null;
	currency: string | null;
	subscription: string | null;
	customer_details: { email: string | null } | null;
};

export type Invoice = {
	billing_reason: string | null;
	amount_paid: number;
	currency: string;
	/** Older API versions. */
	subscription?: string | null;
	/** API 2025-03-31 and later. */
	parent?: {
		subscription_details?: { subscription?: string | null } | null;
	} | null;
};

export const invoiceSubscription = (i: Invoice) =>
	i.parent?.subscription_details?.subscription ?? i.subscription ?? null;
