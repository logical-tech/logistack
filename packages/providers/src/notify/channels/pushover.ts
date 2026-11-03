import { z } from "zod";
import { defineProvider, Http, secret } from "../../http.ts";
import { channel, type Rendered } from "../types.ts";

export const pushoverConfig = z.object({
	appToken: secret(),
	userKey: secret(),
});

export const pushoverPayload = (token: string, user: string, r: Rendered) => ({
	token,
	user,
	title: r.title.slice(0, 250),
	message: r.body.slice(0, 1024),
	priority: r.severity === "error" ? 1 : 0,
	...(r.url ? { url: r.url, url_title: "Open in LogiStack" } : {}),
});

export const pushover = defineProvider({
	configSchema: pushoverConfig,
	create(config, deps) {
		const http = new Http("pushover", deps);
		return channel((_event, r) =>
			http.postJson(
				"send",
				"https://api.pushover.net/1/messages.json",
				pushoverPayload(config.appToken, config.userKey, r),
			),
		);
	},
});
