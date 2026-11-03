import type { EventEnvelope } from "@logistack/contracts";
import { z } from "zod";
import { defineProvider, Http, secret } from "../../http.ts";
import { channel, type Rendered, type Severity } from "../types.ts";

export const ntfyConfig = z.object({
	serverUrl: z.url().default("https://ntfy.sh"),
	topic: z.string().regex(/^[\w-]{1,64}$/),
	/** Access token for protected topics. */
	token: secret().optional(),
});

const priority: Record<Severity, number> = {
	info: 3,
	success: 3,
	warning: 4,
	error: 5,
};

/** JSON publishing (POST to the server root) keeps non-ASCII titles out of HTTP headers. */
export const ntfyPayload = (
	topic: string,
	event: EventEnvelope,
	r: Rendered,
) => ({
	topic,
	title: r.title,
	message: r.body,
	priority: priority[r.severity],
	tags: [r.severity, event.type],
	...(r.url ? { click: r.url } : {}),
});

export const ntfy = defineProvider({
	configSchema: ntfyConfig,
	create(config, deps) {
		const http = new Http("ntfy", deps);
		const headers: Record<string, string> = config.token
			? { authorization: `Bearer ${config.token}` }
			: {};
		return channel((event, r) =>
			http.postJson(
				"send",
				config.serverUrl.replace(/\/+$/, ""),
				ntfyPayload(config.topic, event, r),
				headers,
			),
		);
	},
});
