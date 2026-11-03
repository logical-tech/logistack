import { z } from "zod";
import { defineProvider, Http, secret } from "../../http.ts";
import { channel, type Rendered } from "../types.ts";

export const slackConfig = z.object({ webhookUrl: secret().pipe(z.url()) });

export const slackPayload = (r: Rendered) => ({
	text: r.title,
	blocks: [
		{
			type: "header",
			text: { type: "plain_text", text: r.title.slice(0, 150) },
		},
		{ type: "section", text: { type: "mrkdwn", text: r.body } },
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: r.url
						? `${r.severity} · <${r.url}|Open in LogiStack>`
						: r.severity,
				},
			],
		},
	],
});

export const slack = defineProvider({
	configSchema: slackConfig,
	create(config, deps) {
		const http = new Http("slack", deps);
		return channel((_event, r) =>
			http.postJson("send", config.webhookUrl, slackPayload(r)),
		);
	},
});
