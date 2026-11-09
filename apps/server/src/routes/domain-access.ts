import { isIP } from "node:net";
import { createRoute, z } from "@hono/zod-openapi";
import {
	type AccessRule,
	AccessRulesInput,
	AccessRuleView,
} from "@logistack/contracts";
import { domain } from "@logistack/db";
import { eq } from "drizzle-orm";
import { mutation } from "../audit.ts";
import { hashUsers } from "../basic-auth.ts";
import { Failure, notFound } from "../errors.ts";
import { log } from "../log.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { byParam, requirePermission } from "../scope.ts";
import { guardedFetch, hostPolicy, resolvePublic } from "../ssrf.ts";

const AccessView = z
	.object({ rules: z.array(AccessRuleView) })
	.openapi("DomainAccess");

const ForwardAuthProbe = z
	.object({
		outcome: z.enum(["protected", "open", "error"]),
		status: z.int().nullable(),
		message: z.string(),
	})
	.openapi("ForwardAuthProbe");

export const accessView = (
	rules: AccessRule[],
): z.infer<typeof AccessView> => ({
	rules: rules.map((r) =>
		r.type === "basic_auth"
			? { type: r.type, users: r.users.map((u) => ({ username: u.username })) }
			: r,
	),
});

/** What an anonymous request to the auth endpoint says about the protection it would give. */
export function probeOutcome(status: number): z.infer<typeof ForwardAuthProbe> {
	if (status >= 200 && status < 300)
		return {
			outcome: "open",
			status,
			message: `It answered ${status} to a request without credentials, so every visitor would get through.`,
		};
	if (status === 401 || status === 403 || (status >= 300 && status < 400))
		return {
			outcome: "protected",
			status,
			message: `It refused an anonymous request with ${status}. Visitors it signs in get through once it answers 2xx.`,
		};
	return {
		outcome: "error",
		status,
		message: `It answered ${status}. The proxy lets a request through only on 2xx, so nobody would get in.`,
	};
}

const loadDomain = async (db: Parameters<typeof hostPolicy>[0], id: string) => {
	const [row] = await db
		.select({
			hostname: domain.hostname,
			access: domain.access,
			tunnel: domain.tunnel,
			redirectTo: domain.redirectTo,
		})
		.from(domain)
		.where(eq(domain.id, id));
	if (!row) throw notFound("domain");
	return row;
};

/** Control-plane names on the proxy's networks; the proxy would ask them whatever the policy says. */
const CONTROL_PLANE =
	/^(tasks\.|ls-)|^(postgres|redis|caddy|logistack[-_][a-z0-9_-]+)$/;

/** Why the proxy must not call this forward-auth URL, or null. Caddy's admin API listens on 2019. */
export function forwardAuthRefusal(url: URL): string | null {
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (url.port === "2019") return "port 2019 is the proxy's admin API";
	if (CONTROL_PLANE.test(host))
		return `${host} is a LogiStack internal service`;
	return null;
}

const tags = ["domains"];

export const domainAccess = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/domains/{id}/access",
			tags,
			security,
			summary: "Access rules the proxy checks before the domain's upstream",
			middleware: [requirePermission("read", byParam("domain"))],
			request: { params: IdParam },
			responses: {
				200: json(
					AccessView,
					"Rules; basic auth lists usernames, never hashes",
				),
				...errors,
			},
		}),
		async (c) => {
			const row = await loadDomain(c.var.deps.db, c.req.valid("param").id);
			return c.json(accessView(row.access), 200);
		},
	)
	.openapi(
		mutation(
			"domain.access",
			createRoute({
				method: "put",
				path: "/domains/{id}/access",
				tags,
				security,
				summary: "Replace the domain's access rules",
				description:
					"At most one rule per type, checked in a fixed order: ip_allow (403 outside the ranges), then forward_auth, then basic_auth. ip_allow reads the connection address; X-Forwarded-For counts only from the rule's trustedProxies. A basic_auth user sent without a password keeps the one it has. The service's own basic auth (/services/{id}/basic-auth) still applies; its users and the domain's are merged. A forward_auth URL must resolve to an address the instance allows (private hosts follow its setting) and never to a LogiStack internal service. An empty list removes every rule.",
				middleware: [requirePermission("write", byParam("domain"))],
				request: {
					params: IdParam,
					...body(z.object({ rules: AccessRulesInput })),
				},
				responses: { 200: json(AccessView, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { rules } = c.req.valid("json");
			const { db, config } = c.var.deps;
			c.set("auditResourceId", id);
			const row = await loadDomain(db, id);
			if (rules.length && row.redirectTo)
				throw new Failure(
					"bad_request",
					"A redirect domain sends visitors on before any check; protect the domain it redirects to",
				);
			if (row.tunnel && rules.some((r) => r.type === "ip_allow"))
				throw new Failure(
					"bad_request",
					"Through a Cloudflare Tunnel every request comes from cloudflared, so an IP allowlist cannot see the visitor",
				);
			const fa = rules.find((r) => r.type === "forward_auth");
			if (fa) {
				const url = new URL(fa.url);
				const refused = forwardAuthRefusal(url);
				if (refused) throw new Failure("bad_request", refused);
				await resolvePublic(url.hostname, await hostPolicy(db)).catch(
					(err: unknown) => {
						throw new Failure(
							"bad_request",
							err instanceof Error ? err.message : String(err),
						);
					},
				);
			}
			const kept = row.access.find((r) => r.type === "basic_auth")?.users ?? [];
			const stored: AccessRule[] = await Promise.all(
				rules.map(async (r) =>
					r.type === "basic_auth"
						? { type: r.type, users: await hashUsers(r.users, kept) }
						: r,
				),
			);
			await db.update(domain).set({ access: stored }).where(eq(domain.id, id));
			await requestProxySync(config.REDIS_URL, "domain access changed").catch(
				(err: unknown) =>
					log("warn", "proxy sync request failed", { error: String(err) }),
			);
			return c.json(accessView(stored), 200);
		},
	)
	.openapi(
		mutation(
			"domain.forward_auth_test",
			createRoute({
				method: "post",
				path: "/domains/{id}/access/forward-auth-test",
				tags,
				security,
				summary: "Ask a forward-auth endpoint about an anonymous request",
				description:
					"Sends one GET from the server, with the X-Forwarded-* headers the proxy would send for this domain and no credentials. A 401, 403 or redirect means visitors are asked to sign in; a 2xx means everyone would pass. Private addresses follow the instance's private-host setting.",
				middleware: [requirePermission("write", byParam("domain"))],
				request: {
					params: IdParam,
					...body(z.object({ url: z.url({ protocol: /^https?$/ }).max(2048) })),
				},
				responses: { 200: json(ForwardAuthProbe, "Probe result"), ...errors },
			}),
		),
		async (c) => {
			const row = await loadDomain(c.var.deps.db, c.req.valid("param").id);
			const url = new URL(c.req.valid("json").url);
			const refused = forwardAuthRefusal(url);
			if (refused) throw new Failure("bad_request", refused);
			const policy = await hostPolicy(c.var.deps.db);
			const init = {
				headers: {
					"X-Forwarded-Method": "GET",
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": row.hostname.replace(/^\*\./, "ls-check."),
					"X-Forwarded-Uri": "/",
				},
				redirect: "manual" as const,
				signal: AbortSignal.timeout(5000),
			};
			try {
				let res: Response;
				if (url.protocol === "https:")
					res = await guardedFetch(url, init, policy);
				else {
					// Auth servers often sit on the private network over plain HTTP; the same address check applies.
					const address = await resolvePublic(url.hostname, policy);
					const pinned = new URL(url);
					pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
					res = await fetch(pinned, {
						...init,
						headers: { ...init.headers, host: url.host },
					});
				}
				await res.body?.cancel();
				return c.json(probeOutcome(res.status), 200);
			} catch (err) {
				return c.json(
					{
						outcome: "error" as const,
						status: null,
						message: `The server could not reach it: ${err instanceof Error ? err.message : String(err)}. A name that resolves only on the proxy's network can still work for the proxy.`,
					},
					200,
				);
			}
		},
	);
