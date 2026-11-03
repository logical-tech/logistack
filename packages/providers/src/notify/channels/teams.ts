import { z } from "zod";
import { defineProvider, Http, secret } from "../../http.ts";
import { channel, type Rendered, type Severity } from "../types.ts";

/** A Power Automate "When a Teams webhook request is received" workflow URL. */
export const teamsConfig = z.object({ webhookUrl: secret().pipe(z.url()) });

const colors: Record<Severity, string> = {
	info: "Accent",
	success: "Good",
	warning: "Warning",
	error: "Attention",
};

export const teamsPayload = (r: Rendered) => ({
	type: "message",
	attachments: [
		{
			contentType: "application/vnd.microsoft.card.adaptive",
			content: {
				$schema: "http://adaptivecards.io/schemas/adaptive-card.json",
				type: "AdaptiveCard",
				version: "1.4",
				body: [
					{
						type: "TextBlock",
						text: r.title,
						weight: "Bolder",
						size: "Medium",
						color: colors[r.severity],
						wrap: true,
					},
					{ type: "TextBlock", text: r.body, wrap: true },
				],
				...(r.url
					? {
							actions: [
								{
									type: "Action.OpenUrl",
									title: "Open in LogiStack",
									url: r.url,
								},
							],
						}
					: {}),
			},
		},
	],
});

export const teams = defineProvider({
	configSchema: teamsConfig,
	create(config, deps) {
		const http = new Http("teams", deps);
		return channel((_event, r) =>
			http.postJson("send", config.webhookUrl, teamsPayload(r)),
		);
	},
});
