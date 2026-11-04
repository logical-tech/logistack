import { createRoute, z } from "@hono/zod-openapi";
import { decrypt, encrypt } from "@logistack/core";
import { cloudflareTunnel, dnsProvider, domain } from "@logistack/db";
import { cloudflareTunnels } from "@logistack/providers";
import { and, asc, count, eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { providerRow, viaProvider } from "../dns.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import { log } from "../log.ts";
import {
	body,
	errors,
	IdParam,
	json,
	Name,
	router,
	security,
} from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { inOrganization, requirePermission } from "../scope.ts";

export const TunnelView = z
	.object({
		id: z.string(),
		name: z.string(),
		dnsProviderId: z.string(),
		dnsProviderName: z.string(),
		accountId: z.string(),
		tunnelId: z.string(),
		/** Cloudflare's view of the connector; null when the API could not be reached. */
		status: z.enum(["inactive", "degraded", "healthy", "down"]).nullable(),
		connections: z.int(),
		statusMessage: z.string().nullable(),
		/** Domains served through it; a tunnel in use cannot be deleted. */
		usedBy: z.int(),
		createdAt: z.string(),
	})
	.openapi("CloudflareTunnel");

const CreateTunnel = z.object({
	dnsProviderId: z.string().min(1),
	accountId: z.string().trim().min(1),
	name: Name,
});

/** The Cloudflare provider's API token; tunnels reuse the DNS credentials. */
async function tokenOf(c: Context<Env>, dnsProviderId: string) {
	const row = await providerRow(
		c.var.deps.db,
		requireActor(c).organizationId,
		dnsProviderId,
	);
	if (row.kind !== "cloudflare")
		throw new Failure("bad_request", "tunnels need a Cloudflare provider");
	const creds = JSON.parse(
		await decrypt(c.var.deps.masterKey, row.credentialsEncrypted),
	) as { apiToken: string };
	return { row, token: creds.apiToken };
}

const sync = (c: Context<Env>, reason: string) =>
	requestProxySync(c.var.deps.config.REDIS_URL, reason).catch((err: unknown) =>
		log("warn", "proxy sync request failed", { error: String(err) }),
	);

export const tunnels = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/tunnels",
			tags: ["networking"],
			security,
			summary: "Cloudflare Tunnels with their live connector status",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(TunnelView), "Tunnels"), ...errors },
		}),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const org = requireActor(c).organizationId;
			const rows = await db
				.select({
					t: cloudflareTunnel,
					providerName: dnsProvider.name,
					credentials: dnsProvider.credentialsEncrypted,
					usedBy: count(domain.id),
				})
				.from(cloudflareTunnel)
				.innerJoin(
					dnsProvider,
					eq(dnsProvider.id, cloudflareTunnel.dnsProviderId),
				)
				.leftJoin(
					domain,
					and(
						eq(domain.dnsProviderId, cloudflareTunnel.dnsProviderId),
						eq(domain.tunnel, true),
					),
				)
				.where(eq(cloudflareTunnel.organizationId, org))
				.groupBy(cloudflareTunnel.id, dnsProvider.id)
				.orderBy(asc(cloudflareTunnel.name));
			const items = await Promise.all(
				rows.map(async ({ t, providerName, credentials, usedBy }) => {
					const live = await (async () => {
						const { apiToken } = JSON.parse(
							await decrypt(masterKey, credentials),
						) as { apiToken: string };
						return cloudflareTunnels(apiToken, { timeoutMs: 6_000 }).status(
							t.accountId,
							t.tunnelId,
						);
					})().catch(() => null);
					return {
						id: t.id,
						name: t.name,
						dnsProviderId: t.dnsProviderId,
						dnsProviderName: providerName,
						accountId: t.accountId,
						tunnelId: t.tunnelId,
						status: live?.status ?? null,
						connections: live?.connections ?? 0,
						statusMessage: t.statusMessage,
						usedBy,
						createdAt: t.createdAt.toISOString(),
					};
				}),
			);
			return c.json(items, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/dns-providers/{id}/cloudflare-accounts",
			tags: ["networking"],
			security,
			summary: "Cloudflare accounts the provider's token can see",
			middleware: [requirePermission("admin", inOrganization)],
			request: { params: IdParam },
			responses: {
				200: json(
					z.array(z.object({ id: z.string(), name: z.string() })),
					"Accounts",
				),
				...errors,
			},
		}),
		async (c) => {
			const { token } = await tokenOf(c, c.req.valid("param").id);
			const accounts = await viaProvider(() =>
				cloudflareTunnels(token).accounts(),
			);
			return c.json(
				accounts.map((a) => ({ id: a.id, name: a.name })),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"tunnel.create",
			createRoute({
				method: "post",
				path: "/tunnels",
				tags: ["networking"],
				security,
				summary: "Create a Cloudflare Tunnel and run its connector",
				description:
					"Creates a remotely managed tunnel in the account; the worker runs cloudflared with its token and keeps its ingress in step with the tunnel domains.",
				middleware: [requirePermission("admin", inOrganization)],
				request: body(CreateTunnel),
				responses: { 201: json(TunnelView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const { row, token } = await tokenOf(c, input.dnsProviderId);
			const [taken] = await db
				.select({ id: cloudflareTunnel.id })
				.from(cloudflareTunnel)
				.where(eq(cloudflareTunnel.dnsProviderId, row.id));
			if (taken)
				throw new Failure("conflict", "this provider already has a tunnel");
			const created = await viaProvider(() =>
				cloudflareTunnels(token).create(input.accountId, input.name),
			);
			const t = one(
				await db
					.insert(cloudflareTunnel)
					.values({
						organizationId: requireActor(c).organizationId,
						dnsProviderId: row.id,
						name: input.name,
						accountId: input.accountId,
						tunnelId: created.tunnelId,
						tokenEncrypted: await encrypt(masterKey, created.token),
					})
					.returning(),
			);
			c.set("auditResourceId", t.id);
			await sync(c, "tunnel created");
			return c.json(
				{
					id: t.id,
					name: t.name,
					dnsProviderId: t.dnsProviderId,
					dnsProviderName: row.name,
					accountId: t.accountId,
					tunnelId: t.tunnelId,
					status: "inactive" as const,
					connections: 0,
					statusMessage: null,
					usedBy: 0,
					createdAt: t.createdAt.toISOString(),
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"tunnel.delete",
			createRoute({
				method: "delete",
				path: "/tunnels/{id}",
				tags: ["networking"],
				security,
				summary: "Delete a tunnel no domain uses",
				middleware: [requirePermission("admin", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { db } = c.var.deps;
			const id = c.req.valid("param").id;
			const [t] = await db
				.select()
				.from(cloudflareTunnel)
				.where(
					and(
						eq(cloudflareTunnel.id, id),
						eq(cloudflareTunnel.organizationId, requireActor(c).organizationId),
					),
				);
			if (!t) throw notFound("tunnel");
			c.set("auditResourceId", t.id);
			const [used] = await db
				.select({ n: count() })
				.from(domain)
				.where(
					and(
						eq(domain.dnsProviderId, t.dnsProviderId),
						eq(domain.tunnel, true),
					),
				);
			if (used && used.n > 0)
				throw new Failure(
					"conflict",
					`${used.n} domain(s) are served through this tunnel; move or delete them first`,
				);
			const { token } = await tokenOf(c, t.dnsProviderId);
			// Row first: the worker then stops cloudflared, so Cloudflare sees no live connection.
			await db.delete(cloudflareTunnel).where(eq(cloudflareTunnel.id, t.id));
			await sync(c, "tunnel deleted");
			await viaProvider(() =>
				cloudflareTunnels(token).remove(t.accountId, t.tunnelId),
			).catch((e: unknown) =>
				log("warn", "tunnel removal at Cloudflare failed", {
					error: String(e),
				}),
			);
			return c.body(null, 204);
		},
	);
