import { z } from "zod";
import { type Deps, Http, ProviderError } from "../http.ts";
import { emailConfig, smtpTransport } from "./channels/email.ts";

/** The instance mailer: an email channel's transport without recipients (plan 14.3). */
export const instanceMailConfig = z.discriminatedUnion("transport", [
	emailConfig.options[0].omit({ to: true }),
	emailConfig.options[1].omit({ to: true }),
]);
export type InstanceMailConfig = z.infer<typeof instanceMailConfig>;

export type MailMessage = {
	to: string;
	subject: string;
	text: string;
	html?: string;
	/** Extra headers, e.g. `List-Unsubscribe`. */
	headers?: Record<string, string>;
};

/** Sends one message through SMTP or Resend; throws `ProviderError` on failure. */
export async function sendMail(
	config: InstanceMailConfig,
	message: MailMessage,
	deps?: Deps,
): Promise<void> {
	if (config.transport === "resend") {
		await new Http("resend", deps).postJson(
			"send",
			"https://api.resend.com/emails",
			{
				from: config.from,
				to: [message.to],
				subject: message.subject,
				text: message.text,
				...(message.html ? { html: message.html } : {}),
				...(message.headers ? { headers: message.headers } : {}),
			},
			{ authorization: `Bearer ${config.apiKey}` },
		);
		return;
	}
	let transport: Awaited<ReturnType<typeof smtpTransport>> | undefined;
	try {
		transport = await smtpTransport(config, deps);
		await transport.sendMail({ from: config.from, ...message });
	} catch (err) {
		const e = err as { message?: string; responseCode?: number };
		throw new ProviderError(
			"smtp",
			"send",
			e.message ?? String(err),
			e.responseCode,
		);
	} finally {
		transport?.close();
	}
}
