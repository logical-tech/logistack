import { isIP } from "node:net";
import nodemailer from "nodemailer";
import { z } from "zod";
import {
	DEFAULT_TIMEOUT_MS,
	type Deps,
	defineProvider,
	Http,
	ProviderError,
	secret,
} from "../../http.ts";
import { resolvePublic } from "../../ssrf.ts";
import { channel, type Rendered } from "../types.ts";

const addressing = {
	from: z.string().min(3),
	to: z.array(z.email()).min(1),
};

export const emailConfig = z.discriminatedUnion("transport", [
	z.object({
		transport: z.literal("smtp"),
		host: z.string().min(1),
		port: z.int().min(1).max(65535).default(587),
		/** Implicit TLS (port 465). Otherwise STARTTLS is used when the server offers it. */
		secure: z.boolean().default(false),
		username: z.string().optional(),
		password: secret().optional(),
		...addressing,
	}),
	z.object({
		transport: z.literal("resend"),
		apiKey: secret(),
		...addressing,
	}),
]);
export type EmailConfig = z.infer<typeof emailConfig>;

type Smtp = Omit<Extract<EmailConfig, { transport: "smtp" }>, "to">;

/**
 * A transport dialling the checked address of the user-chosen SMTP host, so a second DNS answer
 * cannot point it elsewhere; TLS still verifies the certificate against the name.
 */
export async function smtpTransport(config: Smtp, deps?: Deps) {
	const timeout = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const address = await resolvePublic(
		config.host,
		deps?.hostPolicy ?? { allowPrivateHosts: false },
	);
	return nodemailer.createTransport({
		host: address,
		port: config.port,
		secure: config.secure,
		tls: isIP(config.host) ? {} : { servername: config.host },
		auth: config.username
			? { user: config.username, pass: config.password }
			: undefined,
		connectionTimeout: timeout,
		greetingTimeout: timeout,
		socketTimeout: timeout,
	});
}

export const emailMessage = (r: Rendered) => ({
	subject: `[${r.severity}] ${r.title}`,
	text: r.url ? `${r.body}\n\n${r.url}` : r.body,
});

export const email = defineProvider({
	configSchema: emailConfig,
	create(config, deps) {
		if (config.transport === "resend") {
			const http = new Http("resend", deps);
			return channel((_event, r) =>
				http.postJson(
					"send",
					"https://api.resend.com/emails",
					{ from: config.from, to: config.to, ...emailMessage(r) },
					{ authorization: `Bearer ${config.apiKey}` },
				),
			);
		}
		return channel(async (_event, r) => {
			try {
				const transport = await smtpTransport(config, deps);
				await transport.sendMail({
					from: config.from,
					to: config.to,
					...emailMessage(r),
				});
			} catch (err) {
				const e = err as { message?: string; responseCode?: number };
				throw new ProviderError(
					"smtp",
					"send",
					e.message ?? String(err),
					e.responseCode,
				);
			}
		});
	},
});
