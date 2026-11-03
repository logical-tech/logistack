import { z } from "zod";
import { defineProvider, Http, secret } from "../../http.ts";
import { channel, type Rendered } from "../types.ts";

export const telegramConfig = z.object({
	botToken: secret(),
	chatId: z.string().min(1),
});

const escapeHtml = (s: string) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

export const telegramPayload = (chatId: string, r: Rendered) => ({
	chat_id: chatId,
	parse_mode: "HTML",
	disable_web_page_preview: true,
	text: [
		`<b>${escapeHtml(r.title)}</b>`,
		escapeHtml(r.body),
		...(r.url ? [`<a href="${escapeHtml(r.url)}">Open in LogiStack</a>`] : []),
	].join("\n\n"),
});

export const telegram = defineProvider({
	configSchema: telegramConfig,
	create(config, deps) {
		const http = new Http("telegram", deps);
		return channel((_event, r) =>
			http.postJson(
				"send",
				`https://api.telegram.org/bot${config.botToken}/sendMessage`,
				telegramPayload(config.chatId, r),
			),
		);
	},
});
