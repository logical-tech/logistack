import { createRoute } from "@hono/zod-openapi";
import {
	DomainEdge,
	emptyDomainEdge,
	ServiceMaintenance,
} from "@logistack/contracts";
import { domain, serviceMaintenance } from "@logistack/db";
import { eq } from "drizzle-orm";
import { mutation } from "../audit.ts";
import { Failure, notFound } from "../errors.ts";
import { log } from "../log.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { byParam, requirePermission } from "../scope.ts";

const EdgeView = DomainEdge.meta({ id: "DomainEdge" });
const MaintenanceView = ServiceMaintenance.meta({ id: "ServiceMaintenance" });

const offMaintenance: ServiceMaintenance = {
	enabled: false,
	allowCidrs: [],
	message: null,
};

const syncProxy = (redisUrl: string, reason: string) =>
	requestProxySync(redisUrl, reason).catch((err: unknown) =>
		log("warn", "proxy sync request failed", { error: String(err) }),
	);

export const edge = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/domains/{id}/edge",
			tags: ["domains"],
			security,
			summary: "Rate limit, block rules and error page of a domain",
			middleware: [requirePermission("read", byParam("domain"))],
			request: { params: IdParam },
			responses: { 200: json(EdgeView, "Edge settings"), ...errors },
		}),
		async (c) => {
			const [row] = await c.var.deps.db
				.select({ edge: domain.edge })
				.from(domain)
				.where(eq(domain.id, c.req.valid("param").id));
			if (!row) throw notFound("domain");
			return c.json({ ...emptyDomainEdge, ...row.edge }, 200);
		},
	)
	.openapi(
		mutation(
			"domain.edge",
			createRoute({
				method: "put",
				path: "/domains/{id}/edge",
				tags: ["domains"],
				security,
				summary: "Replace the domain's rate limit, block rules and error page",
				description:
					"Checked in this order before the access rules: block rules (403 for a path glob such as `/wp-admin*` or a User-Agent containing a fragment, case-insensitive), then the rate limit (429 above `requestsPerSecond` per client IP, with `burst` requests allowed at once; `exemptCidrs` skip it). `errorPage` is HTML shown when the proxy cannot reach the service (502, 503, 504); null shows the organization's branded page. A null field turns that feature off. No redeploy is needed.",
				middleware: [requirePermission("write", byParam("domain"))],
				request: { params: IdParam, ...body(DomainEdge) },
				responses: { 200: json(EdgeView, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db, config } = c.var.deps;
			c.set("auditResourceId", id);
			const [row] = await db
				.select({ tunnel: domain.tunnel, redirectTo: domain.redirectTo })
				.from(domain)
				.where(eq(domain.id, id));
			if (!row) throw notFound("domain");
			if (row.redirectTo && (input.rateLimit || input.block))
				throw new Failure(
					"bad_request",
					"A redirect domain sends visitors on before any check; set the rules on the domain it redirects to",
				);
			if (row.tunnel && input.rateLimit)
				throw new Failure(
					"bad_request",
					"Through a Cloudflare Tunnel every request comes from cloudflared, so a per-IP rate limit would limit every visitor at once",
				);
			await db.update(domain).set({ edge: input }).where(eq(domain.id, id));
			await syncProxy(config.REDIS_URL, "domain edge changed");
			return c.json(input, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/maintenance",
			tags: ["services"],
			security,
			summary: "Whether the service is in maintenance mode",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam },
			responses: { 200: json(MaintenanceView, "Maintenance mode"), ...errors },
		}),
		async (c) => {
			const [row] = await c.var.deps.db
				.select()
				.from(serviceMaintenance)
				.where(eq(serviceMaintenance.serviceId, c.req.valid("param").id));
			return c.json(row?.settings ?? offMaintenance, 200);
		},
	)
	.openapi(
		mutation(
			"service.maintenance",
			createRoute({
				method: "put",
				path: "/services/{id}/maintenance",
				tags: ["services"],
				security,
				summary:
					"Turn maintenance mode on or off for every domain of the service",
				description:
					"While enabled the proxy answers every domain of the service with 503 and a page carrying the organization's name and logo, plus `message` when set. Clients in `allowCidrs` reach the service as usual, so the team can check it before reopening. The service keeps running; no redeploy is needed. Through a Cloudflare Tunnel the allowlist cannot see the visitor's address.",
				middleware: [requirePermission("write", byParam("service"))],
				request: { params: IdParam, ...body(ServiceMaintenance) },
				responses: { 200: json(MaintenanceView, "Saved"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const settings = c.req.valid("json");
			const { db, config } = c.var.deps;
			c.set("auditResourceId", id);
			await db
				.insert(serviceMaintenance)
				.values({ serviceId: id, settings })
				.onConflictDoUpdate({
					target: serviceMaintenance.serviceId,
					set: { settings },
				});
			await syncProxy(
				config.REDIS_URL,
				settings.enabled ? "maintenance on" : "maintenance off",
			);
			return c.json(settings, 200);
		},
	);
