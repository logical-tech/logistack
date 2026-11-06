import { createRoute, z } from "@hono/zod-openapi";
import {
	checkSponsorKey,
	SPONSOR_SANDBOX_PUBLIC_KEY,
	sponsorKeys,
} from "@logistack/core";
import { instanceSettings } from "@logistack/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure } from "../errors.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { inOrganization, requirePermission } from "../scope.ts";

const tags = ["settings"];

const SponsorStatus = z
	.object({
		/** `expired` keeps the details so the page can say which sponsorship ran out. */
		state: z.enum(["none", "active", "expired"]),
		kind: z.enum(["monthly", "once"]).nullable(),
		amount: z.number().nullable(),
		currency: z.string().nullable(),
		since: z.string().nullable(),
		expiresAt: z.string().nullable(),
		/** The key came from Stripe's sandbox; only test instances accept those. */
		sandbox: z.boolean(),
	})
	.openapi("SponsorStatus");

type SponsorStatus = z.infer<typeof SponsorStatus>;

const NONE: SponsorStatus = {
	state: "none",
	kind: null,
	amount: null,
	currency: null,
	since: null,
	expiresAt: null,
	sandbox: false,
};

const trusted = (c: Context<Env>) =>
	sponsorKeys(c.var.deps.config.LOGISTACK_SPONSOR_SANDBOX);

async function statusOf(
	c: Context<Env>,
	key: string | null | undefined,
): Promise<SponsorStatus> {
	if (!key) return NONE;
	const r = await checkSponsorKey(key, Date.now(), trusted(c));
	// A key that stopped verifying (rotated public key) reads as no sponsorship, never as an error.
	if (!r.ok) return NONE;
	return {
		state: r.expired ? "expired" : "active",
		kind: r.claims.kind,
		amount: r.claims.amount,
		currency: r.claims.currency,
		since: new Date(r.claims.iat * 1000).toISOString(),
		expiresAt: new Date(r.claims.exp * 1000).toISOString(),
		sandbox: r.sandbox,
	};
}

async function stored(c: Context<Env>) {
	const [s] = await c.var.deps.db
		.select({ key: instanceSettings.sponsorKey })
		.from(instanceSettings)
		.where(eq(instanceSettings.id, "singleton"));
	return s?.key ?? null;
}

const save = (c: Context<Env>, key: string | null) =>
	c.var.deps.db
		.update(instanceSettings)
		.set({ sponsorKey: key })
		.where(eq(instanceSettings.id, "singleton"));

export const sponsor = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/instance/sponsor",
			tags,
			security,
			summary: "Whether this instance carries a sponsor key, and until when",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(SponsorStatus, "Sponsor status"), ...errors },
		}),
		async (c) => c.json(await statusOf(c, await stored(c)), 200),
	)
	.openapi(
		mutation(
			"instance.sponsor",
			createRoute({
				method: "put",
				path: "/instance/sponsor",
				tags,
				security,
				summary:
					"Activate a sponsor key from the sponsorship email or the thank-you page",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(z.object({ key: z.string().min(1).max(2048) })),
				responses: { 200: json(SponsorStatus, "Sponsor status"), ...errors },
			}),
		),
		async (c) => {
			const key = c.req.valid("json").key.trim();
			const r = await checkSponsorKey(key, Date.now(), trusted(c));
			if (
				!r.ok &&
				(await checkSponsorKey(key, Date.now(), [SPONSOR_SANDBOX_PUBLIC_KEY]))
					.ok
			)
				throw new Failure(
					"bad_request",
					"This is a sandbox key from a test payment. Only an instance started with LOGISTACK_SPONSOR_SANDBOX=1 accepts it.",
				);
			if (!r.ok)
				throw new Failure(
					"bad_request",
					r.reason === "malformed"
						? "That isn't a sponsor key. Keys start with lss_ and come from the sponsorship email."
						: "This key wasn't signed by LogiStack.",
				);
			if (r.expired)
				throw new Failure(
					"bad_request",
					"This key has expired. Your latest key is in the most recent sponsorship email.",
				);
			await save(c, key);
			return c.json(await statusOf(c, key), 200);
		},
	)
	.openapi(
		mutation(
			"instance.sponsor_remove",
			createRoute({
				method: "delete",
				path: "/instance/sponsor",
				tags,
				security,
				summary: "Remove the sponsor key",
				middleware: [requirePermission("admin", inOrganization)],
				responses: { 200: json(SponsorStatus, "Sponsor status"), ...errors },
			}),
		),
		async (c) => {
			await save(c, null);
			return c.json(NONE, 200);
		},
	);
