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
	EMAIL: SendEmail;
	/** Secret: base64url PKCS#8 Ed25519 private key. */
	SIGNING_KEY: string;
	/** Secret: the `whsec_…` of the Stripe webhook endpoint. */
	STRIPE_WEBHOOK_SECRET: string;
	/** The marketing site, allowed to read a session's key from /thanks/. */
	SITE_ORIGIN: string;
	EMAIL_FROM: string;
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

async function sendKey(env: Env, to: string, key: string, monthly: boolean) {
	const steps = `In LogiStack, open Settings > Sponsor and paste this key:\n\n${key}\n\n`;
	const renewal = monthly
		? "Your instance renews the key by itself every month while the sponsorship is active. If it can't reach us, the key keeps working for a week past the month.\n\n"
		: "The key is valid for a year.\n\n";
	const text = `Thank you for sponsoring LogiStack.\n\n${steps}${renewal}— Logical`;
	await env.EMAIL.send({
		from: { email: env.EMAIL_FROM, name: "LogiStack" },
		to,
		subject: "Your LogiStack sponsor key",
		text,
		html: `<p>Thank you for sponsoring LogiStack.</p><p>In LogiStack, open <b>Settings &gt; Sponsor</b> and paste this key:</p><pre style="white-space:pre-wrap;word-break:break-all;font-size:13px;background:#f4f4f5;padding:12px;border-radius:8px">${key}</pre><p>${renewal.trim()}</p><p>— Logical</p>`,
	});
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
	await sendKey(env, email, key, monthly);
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
