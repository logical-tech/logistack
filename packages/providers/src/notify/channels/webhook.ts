import { z } from "zod";
import {
	defineProvider,
	Http,
	hmacSha256,
	safeEqual,
	secret,
} from "../../http.ts";
import { channel } from "../types.ts";

export const webhookConfig = z.object({
	url: z.url(),
	/** HMAC key; receivers verify `X-LogiStack-Signature` with it. */
	secret: secret().pipe(z.string().min(16)),
});

/** Receivers should reject deliveries whose timestamp is further than this from their clock. */
export const WEBHOOK_REPLAY_WINDOW_S = 300;

/**
 * Signature over `<timestamp>.<raw body>`, so a captured body cannot be replayed with a
 * fresh timestamp. Sent as `X-LogiStack-Signature: sha256=<hex>` with
 * `X-LogiStack-Timestamp: <unix seconds>`.
 */
export async function signWebhook(
	key: string,
	timestamp: number,
	body: string,
): Promise<string> {
	return `sha256=${(await hmacSha256(key, `${timestamp}.${body}`)).toHex()}`;
}

/** Reference receiver check: valid signature and timestamp inside the replay window. */
export async function verifyWebhookSignature(
	key: string,
	headers: Headers,
	body: string,
	nowS = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	const sig = headers.get("x-logistack-signature");
	const ts = Number(headers.get("x-logistack-timestamp"));
	if (!sig || !Number.isInteger(ts)) return false;
	if (Math.abs(nowS - ts) > WEBHOOK_REPLAY_WINDOW_S) return false;
	return safeEqual(sig, await signWebhook(key, ts, body));
}

export const webhook = defineProvider({
	configSchema: webhookConfig,
	create(config, deps) {
		const http = new Http("webhook", deps);
		return channel(async (event, rendered) => {
			const body = JSON.stringify({ event, rendered });
			const ts = Math.floor(Date.now() / 1000);
			await http.request("send", config.url, {
				method: "POST",
				body,
				headers: {
					"content-type": "application/json",
					"user-agent": "LogiStack-Webhook",
					"x-logistack-event": event.type,
					"x-logistack-delivery": event.id,
					"x-logistack-timestamp": String(ts),
					"x-logistack-signature": await signWebhook(config.secret, ts, body),
				},
			});
		});
	},
});
