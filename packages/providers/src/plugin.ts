import { PLUGIN_HEADERS } from "@logistack/contracts";
import { type Fetch, ProviderError } from "./http.ts";
import {
	signWebhook,
	verifyWebhookSignature,
} from "./notify/channels/webhook.ts";

// Requests LogiStack sends a plugin (docs/plans/plugins.md, "Runtime"): signed like the webhook
// channel, over `<timestamp>.<body>`, with the install's own HMAC key.

export type PluginTarget = {
	/** `http://ls-plg-…:8080` or a dev URL, without a trailing slash. */
	baseUrl: string;
	installId: string;
	signingSecret: string;
};

/** What is signed: the user claims (when a page made the request) and the raw body. */
const signedPayload = (body: string, user: string | null | undefined) =>
	user ? `${user}\n${body}` : body;

/**
 * Headers that authenticate a request to a plugin. `user` is the JSON of `PluginUserClaims` the
 * proxy forwards for a page's request; it is covered by the signature, so it cannot be swapped.
 */
export async function pluginHeaders(
	t: Pick<PluginTarget, "installId" | "signingSecret">,
	body: string,
	user?: string,
	nowS = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
	return {
		[PLUGIN_HEADERS.install]: t.installId,
		[PLUGIN_HEADERS.timestamp]: String(nowS),
		[PLUGIN_HEADERS.signature]: await signWebhook(
			t.signingSecret,
			nowS,
			signedPayload(body, user),
		),
		...(user ? { [PLUGIN_HEADERS.user]: user } : {}),
	};
}

/** The plugin side's check of a request from LogiStack; the SDK does the same. */
export const verifyPluginRequest = (
	secret: string,
	headers: Headers,
	body: string,
	nowS?: number,
) =>
	verifyWebhookSignature(
		secret,
		headers,
		signedPayload(body, headers.get(PLUGIN_HEADERS.user)),
		nowS,
	);

/**
 * POSTs JSON to a contract path (`/v1/events`, `/v1/config/validate`, …) and returns the parsed
 * reply. Non-2xx answers throw a `ProviderError` carrying the status.
 */
export async function callPlugin<T = unknown>(
	t: PluginTarget,
	path: string,
	payload: unknown,
	opts: { fetch?: Fetch; timeoutMs?: number; method?: "GET" | "POST" } = {},
): Promise<T> {
	const method = opts.method ?? "POST";
	const body = method === "GET" ? "" : JSON.stringify(payload ?? {});
	const res = await (opts.fetch ?? fetch)(`${t.baseUrl}${path}`, {
		method,
		...(method === "GET" ? {} : { body }),
		headers: {
			"content-type": "application/json",
			"user-agent": "LogiStack-Plugin",
			...(await pluginHeaders(t, body)),
		},
		signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
		redirect: "manual",
	});
	const text = await res.text();
	if (!res.ok)
		throw new ProviderError(
			"plugin",
			path,
			`the plugin answered ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
			res.status,
		);
	if (!text) return undefined as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new ProviderError("plugin", path, "the plugin answered non-JSON");
	}
}
