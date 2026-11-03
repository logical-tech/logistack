import { z } from "zod";
import { defineProvider, Http, secret } from "../../http.ts";
import { channel, type Rendered, severityColor } from "../types.ts";

export const mattermostConfig = z.object({
	webhookUrl: secret().pipe(z.url()),
});

/** Mattermost incoming webhooks take Slack-style attachments, not blocks. */
export const mattermostPayload = (r: Rendered) => ({
	text: r.title,
	attachments: [
		{
			fallback: r.title,
			color: `#${severityColor[r.severity].toString(16).padStart(6, "0")}`,
			title: r.title,
			...(r.url ? { title_link: r.url } : {}),
			text: r.body,
		},
	],
});

export const mattermost = defineProvider({
	configSchema: mattermostConfig,
	create(config, deps) {
		const http = new Http("mattermost", deps);
		return channel((_event, r) =>
			http.postJson("send", config.webhookUrl, mattermostPayload(r)),
		);
	},
});
