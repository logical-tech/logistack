import { renderKeyEmail } from "./email.ts";
import {
	MONTHLY_TTL,
	ONCE_TTL,
	readClaims,
	type SponsorClaims,
	signSponsorKey,
} from "./key.ts";
import {
	type CheckoutSession,
	type Invoice,
	invoiceSubscription,
	verifyStripeSignature,
} from "./stripe.ts";

export type Env = {
	SPONSORS: KVNamespace;
	/** Secret: a Resend API key with sending access to EMAIL_FROM's domain. */
	RESEND_API_KEY: string;
	/** Secret: base64url PKCS#8 Ed25519 private key. */
	SIGNING_KEY: string;
	/** Secret: the `whsec_…` of the Stripe webhook endpoint. */
	STRIPE_WEBHOOK_SECRET: string;
	/** The marketing site, allowed to read a session's key from /thanks/. */
	SITE_ORIGIN: string;
	EMAIL_FROM: string;
	/** "1" in the sandbox environment: test emails say so. */
	SANDBOX?: string;
};

const DAY = 86_400;
/** /thanks/ reads the key by Checkout Session id for this long. The id is the bearer secret. */
const SESSION_TTL = 30 * DAY;
/** A subscription's latest key outlives its own expiry a little, so a slow refresh still finds it. */
const SUB_TTL = MONTHLY_TTL + 14 * DAY;

const now = () => Math.floor(Date.now() / 1000);

function cors(env: Env, res: Response): Response {
	res.headers.set("Access-Control-Allow-Origin", env.SITE_ORIGIN);
	res.headers.set("Vary", "Origin");
	return res;
}

async function issue(
	env: Env,
	c: Omit<SponsorClaims, "v" | "iat" | "exp">,
	ttl: number,
) {
	const iat = now();
	return signSponsorKey({ v: 1, ...c, iat, exp: iat + ttl }, env.SIGNING_KEY);
}

async function sendKey(
	env: Env,
	sessionId: string,
	to: string,
	key: string,
	monthly: boolean,
) {
	const email = renderKeyEmail({
		key,
		monthly,
		exp: readClaims(key)?.exp ?? now(),
		sandbox: env.SANDBOX === "1",
	});
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
			// Resend drops a repeat of the same key for 24 hours: one email per payment.
			"Idempotency-Key": `sponsor-key/${sessionId}`,
		},
		body: JSON.stringify({
			from: `LogiStack <${env.EMAIL_FROM}>`,
			to: [to],
			subject: email.subject,
			text: email.text,
			html: email.html,
		}),
	});
	// Throwing makes the webhook answer 500, so Stripe retries and the email goes out later.
	if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function onCheckout(env: Env, s: CheckoutSession) {
	if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required")
		return;
	const monthly = s.mode === "subscription" && !!s.subscription;
	// Stripe retries webhooks: the first delivery issues the key, retries reuse it.
	let key = await env.SPONSORS.get(`session:${s.id}`);
	if (!key) {
		key = await issue(
			env,
			{
				sub: monthly ? (s.subscription as string) : s.id,
				kind: monthly ? "monthly" : "once",
				amount: (s.amount_total ?? 0) / 100,
				currency: s.currency ?? "eur",
			},
			monthly ? MONTHLY_TTL : ONCE_TTL,
		);
		await env.SPONSORS.put(`session:${s.id}`, key, {
			expirationTtl: SESSION_TTL,
		});
		if (monthly)
			await env.SPONSORS.put(`sub:${s.subscription}`, key, {
				expirationTtl: SUB_TTL,
			});
	}
	// Marked only after a send succeeds: a failed send throws, the webhook answers 500, and
	// Stripe's retry sends the same key again.
	const email = s.customer_details?.email;
	if (!email || (await env.SPONSORS.get(`emailed:${s.id}`))) return;
	await sendKey(env, s.id, email, key, monthly);
	await env.SPONSORS.put(`emailed:${s.id}`, "1", {
		expirationTtl: SESSION_TTL,
	});
}

/** Renewals only: the first invoice of a subscription arrives with its checkout session. */
async function onInvoicePaid(env: Env, i: Invoice) {
	const sub = invoiceSubscription(i);
	if (!sub || i.billing_reason !== "subscription_cycle") return;
	const key = await issue(
		env,
		{
			sub,
			kind: "monthly",
			amount: i.amount_paid / 100,
			currency: i.currency,
		},
		MONTHLY_TTL,
	);
	await env.SPONSORS.put(`sub:${sub}`, key, { expirationTtl: SUB_TTL });
}

async function webhook(req: Request, env: Env): Promise<Response> {
	const body = await req.text();
	if (
		!(await verifyStripeSignature(
			body,
			req.headers.get("Stripe-Signature"),
			env.STRIPE_WEBHOOK_SECRET,
		))
	)
		return new Response("bad signature", { status: 400 });
	const event = JSON.parse(body) as { type: string; data: { object: unknown } };
	try {
		if (event.type === "checkout.session.completed")
			await onCheckout(env, event.data.object as CheckoutSession);
		else if (event.type === "invoice.paid")
			await onInvoicePaid(env, event.data.object as Invoice);
		// A cancelled subscription gets no new keys; the last one runs out on its own.
		else if (event.type === "customer.subscription.deleted")
			await env.SPONSORS.delete(
				`sub:${(event.data.object as { id: string }).id}`,
			);
	} catch (e) {
		// A non-2xx makes Stripe retry the event for up to three days.
		console.error(`${event.type} failed`, e);
		return new Response("retry", { status: 500 });
	}
	return new Response("ok");
}

/** An instance trades its monthly key for the newest one of the same subscription. */
async function refresh(req: Request, env: Env): Promise<Response> {
	const { key } = (await req.json().catch(() => ({}))) as { key?: unknown };
	const claims = typeof key === "string" ? readClaims(key) : null;
	if (claims?.kind !== "monthly")
		return Response.json(
			{ error: "not a monthly sponsor key" },
			{ status: 400 },
		);
	const latest = await env.SPONSORS.get(`sub:${claims.sub}`);
	const newer = latest ? readClaims(latest) : null;
	return Response.json({
		key: newer && newer.exp > claims.exp ? latest : null,
	});
}

export default {
	async fetch(req, env): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname === "/stripe/webhook")
			return webhook(req, env);
		if (req.method === "POST" && url.pathname === "/v1/refresh")
			return refresh(req, env);
		const session = /^\/v1\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(url.pathname);
		if (req.method === "GET" && session) {
			const key = await env.SPONSORS.get(`session:${session[1]}`);
			return cors(
				env,
				key
					? Response.json({ key })
					: // The webhook can land a second after the redirect: the page retries.
						Response.json({ key: null }, { status: 404 }),
			);
		}
		if (req.method === "GET" && url.pathname === "/")
			return new Response("LogiStack sponsors");
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
