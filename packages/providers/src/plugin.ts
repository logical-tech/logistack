import {
	dnsRecordTypes,
	PLUGIN_HEADERS,
	type PluginProviderKind,
} from "@logistack/contracts";
import { z } from "zod";
import type { DnsProvider } from "./dns/types.ts";
import { type Fetch, ProviderError } from "./http.ts";
import {
	signWebhook,
	verifyWebhookSignature,
} from "./notify/channels/webhook.ts";
import type { NotificationChannel } from "./notify/types.ts";
import type { SecretSource } from "./secrets/types.ts";

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

// Providers contributed by a plugin (docs/plans/plugins.md, "Providers"): each op of the provider
// interface is `POST /v1/providers/{kind}/{name}/{op}` with `{ config, args }`, answered
// `{ result }`. `args` are the interface method's arguments, in order.

/** Calls one op of one contributed provider. */
export type PluginProviderCall = (
	op: string,
	args: unknown[],
) => Promise<unknown>;

export function pluginProviderCall(
	target: PluginTarget,
	kind: PluginProviderKind,
	name: string,
	config: unknown,
	fetchFn?: Fetch,
): PluginProviderCall {
	return async (op, args) => {
		const reply = await callPlugin<{ result?: unknown } | undefined>(
			target,
			`/v1/providers/${kind}/${encodeURIComponent(name)}/${op}`,
			{ config, args },
			fetchFn ? { fetch: fetchFn } : {},
		);
		return reply?.result;
	};
}

/** The plugin's answers are external input (rule 7): checked before callers see them. */
function parsed<T>(schema: z.ZodType<T>, op: string, value: unknown): T {
	const r = schema.safeParse(value);
	if (!r.success)
		throw new ProviderError(
			"plugin",
			op,
			"the plugin answered an unexpected result",
		);
	return r.data;
}

const Zone = z.object({ id: z.string(), name: z.string() });
const Rec = z.object({
	id: z.string(),
	zoneId: z.string(),
	name: z.string(),
	type: z.enum(dnsRecordTypes),
	content: z.string(),
	ttl: z.number(),
	proxied: z.boolean().optional(),
	comment: z.string().optional(),
	readOnly: z.string().optional(),
});

export function pluginDnsProvider(call: PluginProviderCall): DnsProvider {
	return {
		async verify() {
			await call("verify", []);
		},
		listZones: async () =>
			parsed(z.array(Zone), "listZones", await call("listZones", [])),
		listRecords: async (zoneId, name) =>
			parsed(
				z.array(Rec),
				"listRecords",
				await call(
					"listRecords",
					name === undefined ? [zoneId] : [zoneId, name],
				),
			),
		upsertRecord: async (input) =>
			parsed(Rec, "upsertRecord", await call("upsertRecord", [input])),
		createRecord: async (input) =>
			parsed(z.array(Rec), "createRecord", await call("createRecord", [input])),
		updateRecord: async (recordId, input) =>
			parsed(
				z.array(Rec),
				"updateRecord",
				await call("updateRecord", [recordId, input]),
			),
		async deleteRecord(zoneId, recordId) {
			await call("deleteRecord", [zoneId, recordId]);
		},
	};
}

export function pluginNotificationChannel(
	call: PluginProviderCall,
): NotificationChannel {
	return {
		async test() {
			await call("test", []);
		},
		async send(event, rendered) {
			await call("send", [event, rendered]);
		},
	};
}

export function pluginSecretSource(call: PluginProviderCall): SecretSource {
	return {
		async test() {
			await call("test", []);
		},
		read: async (path, key) =>
			parsed(z.string(), "read", await call("read", [path, key])),
	};
}

/**
 * What a resource backed by a disabled or removed install fails with, instead of failing silently.
 * A 409, so deliveries are not retried against it.
 */
export const pluginDisabled = (plugin: string) =>
	new ProviderError("plugin", plugin, "plugin disabled", 409);
