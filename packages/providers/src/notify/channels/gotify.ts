import { z } from "zod";
import { defineProvider, Http, secret } from "../../http.ts";
import { channel, type Rendered, type Severity } from "../types.ts";

export const gotifyConfig = z.object({
	serverUrl: z.url(),
	appToken: secret(),
});

const priority: Record<Severity, number> = {
	info: 2,
	success: 2,
	warning: 5,
	error: 8,
};

export const gotifyPayload = (r: Rendered) => ({
	title: r.title,
	message: r.body,
	priority: priority[r.severity],
	...(r.url
		? { extras: { "client::notification": { click: { url: r.url } } } }
		: {}),
});

export const gotify = defineProvider({
	configSchema: gotifyConfig,
	create(config, deps) {
		const http = new Http("gotify", deps);
		return channel((_event, r) =>
			http.postJson(
				"send",
				`${config.serverUrl.replace(/\/+$/, "")}/message`,
				gotifyPayload(r),
				{ "x-gotify-key": config.appToken },
			),
		);
	},
});
