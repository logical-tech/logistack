import type { EventEnvelope } from "@logistack/contracts";
import { z } from "zod";
import { defineProvider, Http, secret } from "../../http.ts";
import { channel, type Rendered, severityColor } from "../types.ts";

export const discordConfig = z.object({ webhookUrl: secret().pipe(z.url()) });

export const discordPayload = (event: EventEnvelope, r: Rendered) => ({
	embeds: [
		{
			title: r.title.slice(0, 256),
			description: r.body.slice(0, 4096),
			color: severityColor[r.severity],
			timestamp: event.at.toISOString(),
			...(r.url ? { url: r.url } : {}),
			footer: { text: event.type },
		},
	],
});

export const discord = defineProvider({
	configSchema: discordConfig,
	create(config, deps) {
		const http = new Http("discord", deps);
		return channel((event, r) =>
			http.postJson("send", config.webhookUrl, discordPayload(event, r)),
		);
	},
});
