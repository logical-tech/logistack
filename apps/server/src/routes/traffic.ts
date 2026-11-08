import { createRoute, z } from "@hono/zod-openapi";
import {
	MetricRange,
	TrafficOverview,
	TrafficQuery,
	TrafficReport,
} from "@logistack/contracts";
import { domain, environment, project, service } from "@logistack/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import { notFound } from "../errors.ts";
import { log } from "../log.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { byParam, inOrganization, requirePermission } from "../scope.ts";
import {
	trafficByService,
	trafficRanked,
	trafficSeries,
	trafficTotals,
	trafficWindow,
} from "../traffic-query.ts";

const tags = ["monitoring"];

export const traffic = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/traffic",
			tags,
			security,
			summary:
				"Traffic from the proxy's access log: requests, status, latency, visitors, top paths and referrers",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam, query: TrafficQuery },
			responses: { 200: json(TrafficReport, "Report"), ...errors },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { range, domainId } = c.req.valid("query");
			const { db } = c.var.deps;
			const domains = await db
				.select({
					id: domain.id,
					hostname: domain.hostname,
					pathPrefix: domain.pathPrefix,
					webAnalytics: domain.webAnalytics,
				})
				.from(domain)
				.where(eq(domain.serviceId, id))
				.orderBy(domain.hostname);
			if (domainId && !domains.some((d) => d.id === domainId))
				throw notFound("domain");
			const sql = db.$client;
			const w = await trafficWindow(sql, range);
			const scope = { serviceId: id, domainId };
			const [totals, series, ranked] = await Promise.all([
				trafficTotals(sql, scope, w),
				trafficSeries(sql, scope, w),
				trafficRanked(sql, scope, w),
			]);
			return c.json(
				{
					range,
					step: w.step,
					totals,
					series,
					paths: ranked.paths,
					referrers: ranked.referrers,
					countries: ranked.countries,
					utmSources: ranked.utm_sources,
					events: ranked.events,
					domains: domains.map((d) => ({
						id: d.id,
						hostname: `${d.hostname}${d.pathPrefix ?? ""}`,
						webAnalytics: d.webAnalytics,
					})),
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/traffic",
			tags,
			security,
			summary: "Traffic across the organization's services",
			middleware: [requirePermission("read", inOrganization)],
			request: { query: z.object({ range: MetricRange.default("24h") }) },
			responses: { 200: json(TrafficOverview, "Overview"), ...errors },
		}),
		async (c) => {
			const { range } = c.req.valid("query");
			const organizationId = requireActor(c).organizationId;
			const { db } = c.var.deps;
			const sql = db.$client;
			const w = await trafficWindow(sql, range);
			const [series, byService] = await Promise.all([
				trafficSeries(sql, { organizationId }, w),
				trafficByService(sql, organizationId, w),
			]);
			const ids = byService.map((s) => s.serviceId);
			// Rows outlive a deleted service until retention; only live ones of this org are listed.
			const names = ids.length
				? await db
						.select({
							id: service.id,
							name: service.name,
							projectId: project.id,
						})
						.from(service)
						.innerJoin(environment, eq(environment.id, service.environmentId))
						.innerJoin(project, eq(project.id, environment.projectId))
						.where(
							and(
								inArray(service.id, ids),
								eq(project.organizationId, organizationId),
							),
						)
				: [];
			const byId = new Map(names.map((n) => [n.id, n]));
			return c.json(
				{
					range,
					step: w.step,
					series,
					services: byService
						.flatMap((s) => {
							const n = byId.get(s.serviceId);
							return n ? [{ ...s, name: n.name, projectId: n.projectId }] : [];
						})
						.sort((a, b) => b.requests - a.requests),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"domain.update",
			createRoute({
				method: "put",
				path: "/domains/{id}/web-analytics",
				tags,
				security,
				summary:
					"Serve the first-party analytics script (/_ls/a.js) and its beacon on this domain",
				middleware: [requirePermission("write", byParam("domain"))],
				request: {
					params: IdParam,
					...body(z.object({ enabled: z.boolean() })),
				},
				responses: {
					200: json(
						z.object({ id: z.string(), webAnalytics: z.boolean() }),
						"Saved",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { enabled } = c.req.valid("json");
			const [row] = await c.var.deps.db
				.update(domain)
				.set({ webAnalytics: enabled })
				.where(eq(domain.id, id))
				.returning({ id: domain.id, webAnalytics: domain.webAnalytics });
			if (!row) throw notFound("domain");
			c.set("auditResourceId", id);
			await requestProxySync(
				c.var.deps.config.REDIS_URL,
				"web analytics toggled",
			).catch((e: unknown) =>
				log("warn", "proxy sync request failed", { error: String(e) }),
			);
			return c.json(row, 200);
		},
	);
