import { createRoute, z } from "@hono/zod-openapi";
import {
	InstanceMail,
	InstanceMailInput,
	InstanceMailTest,
} from "@logistack/contracts";
import { encrypt } from "@logistack/core";
import { instanceSettings } from "@logistack/db";
import {
	type InstanceMailConfig,
	instanceMailConfig,
	ProviderError,
} from "@logistack/providers";
import { loadInstanceMail } from "@logistack/worker/work-mail";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { mutation } from "../../audit.ts";
import type { Env } from "../../env.ts";
import { Failure } from "../../errors.ts";
import { body, errors, json, router, security } from "../../openapi.ts";
import { requireInstanceAdmin } from "../../scope.ts";
import { hostPolicy } from "../../ssrf.ts";
import { mailer } from "../../work/notify.ts";

/**
 * Instance mail (plan 14.3): one SMTP or Resend transport for the whole instance, used for
 * Work notifications and invitations. Instance admins only; the secret never leaves the server.
 */

const view = (m: InstanceMailConfig | null): InstanceMail => ({
	configured: !!m,
	transport: m?.transport ?? null,
	host: m?.transport === "smtp" ? m.host : null,
	port: m?.transport === "smtp" ? m.port : null,
	secure: m?.transport === "smtp" ? m.secure : false,
	username: m?.transport === "smtp" ? (m.username ?? null) : null,
	from: m?.from ?? null,
	hasSecret: m ? (m.transport === "smtp" ? !!m.password : !!m.apiKey) : false,
});

/** The input with omitted secrets taken from the stored config of the same transport. */
function merge(
	input: z.output<typeof InstanceMailInput>,
	stored: InstanceMailConfig | null,
): InstanceMailConfig {
	const keep = stored?.transport === input.transport ? stored : null;
	const merged =
		input.transport === "smtp"
			? {
					...input,
					password:
						input.password ??
						(keep?.transport === "smtp" ? keep.password : undefined),
				}
			: {
					...input,
					apiKey:
						input.apiKey ??
						(keep?.transport === "resend" ? keep.apiKey : undefined),
				};
	const parsed = instanceMailConfig.safeParse(merged);
	if (!parsed.success)
		throw new Failure(
			"bad_request",
			input.transport === "resend"
				? "an API key is required"
				: "invalid mail settings",
		);
	return parsed.data;
}

const stored = (c: Context<Env>) =>
	loadInstanceMail(c.var.deps.db, c.var.deps.masterKey);

const tags = ["settings"];

export const instanceMail = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/api/instance/mail",
			tags,
			security,
			operationId: "instance_mail_get",
			summary: "Instance mail settings",
			middleware: [requireInstanceAdmin],
			responses: { 200: json(InstanceMail, "Settings"), ...errors },
		}),
		async (c) => c.json(view(await stored(c)), 200),
	)
	.openapi(
		mutation(
			"instance.mail_update",
			createRoute({
				method: "put",
				path: "/api/instance/mail",
				tags,
				security,
				operationId: "instance_mail_update",
				summary: "Set up instance mail",
				description:
					"SMTP or Resend. Omit the password or API key to keep the stored one.",
				middleware: [requireInstanceAdmin],
				request: body(InstanceMailInput),
				responses: { 200: json(InstanceMail, "Settings"), ...errors },
			}),
		),
		async (c) => {
			const config = merge(c.req.valid("json"), await stored(c));
			const { db, masterKey } = c.var.deps;
			await db
				.update(instanceSettings)
				.set({
					mailEncrypted: await encrypt(masterKey, JSON.stringify(config)),
				})
				.where(eq(instanceSettings.id, "singleton"));
			c.set("auditDiff", { after: view(config) });
			return c.json(view(config), 200);
		},
	)
	.openapi(
		mutation(
			"instance.mail_delete",
			createRoute({
				method: "delete",
				path: "/api/instance/mail",
				tags,
				security,
				operationId: "instance_mail_delete",
				summary: "Turn instance mail off",
				middleware: [requireInstanceAdmin],
				responses: { 200: json(InstanceMail, "Settings"), ...errors },
			}),
		),
		async (c) => {
			await c.var.deps.db
				.update(instanceSettings)
				.set({ mailEncrypted: null })
				.where(eq(instanceSettings.id, "singleton"));
			return c.json(view(null), 200);
		},
	)
	.openapi(
		mutation(
			"instance.mail_test",
			createRoute({
				method: "post",
				path: "/api/instance/mail/test",
				tags,
				security,
				operationId: "instance_mail_test",
				summary: "Send a test email",
				description:
					"Uses `config` when given (the wizard tests before saving), else the stored settings.",
				middleware: [requireInstanceAdmin],
				request: body(InstanceMailTest),
				responses: {
					200: json(
						z.object({ ok: z.boolean(), error: z.string().nullable() }),
						"Result",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const current = await stored(c);
			const config = input.config ? merge(input.config, current) : current;
			if (!config) throw new Failure("conflict", "instance mail is not set up");
			try {
				await mailer.send(
					config,
					{
						to: input.to,
						subject: "LogiStack test email",
						text: "Instance mail works. LogiStack will use this transport for notifications and invitations.",
					},
					{ hostPolicy: await hostPolicy(c.var.deps.db) },
				);
				return c.json({ ok: true, error: null }, 200);
			} catch (error) {
				return c.json(
					{
						ok: false,
						error:
							error instanceof ProviderError || error instanceof Error
								? error.message
								: String(error),
					},
					200,
				);
			}
		},
	);
