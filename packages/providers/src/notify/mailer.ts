import nodemailer from "nodemailer";
import { z } from "zod";
import { DEFAULT_TIMEOUT_MS, type Deps, Http, ProviderError } from "../http.ts";
import { emailConfig } from "./channels/email.ts";

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
	const timeout = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const transport = nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth: config.username
			? { user: config.username, pass: config.password }
			: undefined,
		connectionTimeout: timeout,
		greetingTimeout: timeout,
		socketTimeout: timeout,
	});
	try {
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
		transport.close();
	}
}
