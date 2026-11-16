import { createRoute, z } from "@hono/zod-openapi";
import {
	HomeProxy,
	HomeProxyEnableInput,
	HomeProxyRoute,
	HomeProxyRouteInput,
	HomeProxyRouteUpdateInput,
	HomeProxyTestInput,
	HomeProxyTestResult,
	HomeProxyUpdateInput,
} from "@logistack/contracts";
import {
	dnsProvider,
	domain,
	homeNetwork,
	homeProxy,
	homeProxyRoute,
} from "@logistack/db";
import { findZoneForHostname } from "@logistack/providers";
import { asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { log } from "../log.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { requireInstanceAdmin } from "../scope.ts";

const tags = ["networking"];
// One local proxy per installation, like the home DNS: no organization owns it.
const middleware = [requireInstanceAdmin];
const TEST_TIMEOUT_MS = 5000;

const sync = (c: Context<Env>, reason: string) =>
	requestProxySync(c.var.deps.config.REDIS_URL, reason).catch((err: unknown) =>
		log("warn", "proxy sync request failed", { error: String(err) }),
	);

const ZoneList = z.array(z.object({ id: z.string(), name: z.string() }));

/** The DNS provider (any organization's) holding the zone, as the instance wildcard finds its own. */
async function providerFor(c: Context<Env>, zone: string) {
	const providers = await c.var.deps.db
		.select({ name: dnsProvider.name, zones: dnsProvider.zonesCache })
		.from(dnsProvider);
	return providers.find((p) =>
		findZoneForHostname(zone, ZoneList.catch([]).parse(p.zones)),
	);
}

async function load(c: Context<Env>) {
	const [row] = await c.var.deps.db.select().from(homeProxy);
	return row;
}

async function enabled(c: Context<Env>) {
	const row = await load(c);
	if (!row)
		throw new Failure("conflict", "the local proxy is off; enable it first");
	c.set("auditResourceId", row.id);
	return row;
}

async function view(c: Context<Env>): Promise<HomeProxy> {
	const row = await load(c);
	const [dns] = await c.var.deps.db
		.select({
			lanAddress: homeNetwork.lanAddress,
			desiredState: homeNetwork.desiredState,
		})
		.from(homeNetwork);
	const dnsOn = dns && dns.desiredState !== "removed";
	return {
		enabled: !!row,
		zone: row?.zone ?? null,
		tls: row?.tls ?? null,
		dnsProvider:
			row?.tls === "acme"
				? ((await providerFor(c, row.zone))?.name ?? null)
				: null,
		lanAddress: dnsOn ? dns.lanAddress : null,
		automaticRecords: !!dnsOn,
		caRootPem: row?.caRootPem ?? null,
		statusMessage: row?.statusMessage ?? null,
		updatedAt: row?.updatedAt.toISOString() ?? null,
	};
}

/** `acme` needs a connected DNS provider holding the zone, or Caddy could never solve DNS-01. */
async function checkSettings(
	c: Context<Env>,
	s: { zone: string; tls: "acme" | "internal" },
) {
	if (s.tls === "acme" && !(await providerFor(c, s.zone)))
		throw new Failure(
			"validation_failed",
			`no connected DNS provider holds ${s.zone}; connect one, or use the internal certificate authority`,
		);
}

/** Caddy routes are global: a name a service domain already has would shadow one or the other. */
async function checkHostname(c: Context<Env>, hostname: string) {
	const [taken] = await c.var.deps.db
		.select({ id: domain.id })
		.from(domain)
		.where(eq(domain.hostname, hostname))
		.limit(1);
	if (taken)
		throw new Failure(
			"conflict",
			`${hostname} is already a domain of a service`,
		);
}

const routeView = (
	r: typeof homeProxyRoute.$inferSelect,
	zone: string,
): HomeProxyRoute => ({
	id: r.id,
	name: r.name,
	hostname: `${r.name}.${zone}`,
	upstream: r.upstream,
	insecure: r.insecure,
	createdAt: r.createdAt.toISOString(),
});

function unique<T>(call: Promise<T>, name: string): Promise<T> {
	return call.catch((e: unknown) => {
		if (String((e as { code?: string }).code) === "23505")
			throw new Failure("conflict", `a route named ${name} already exists`);
		throw e;
	});
}

const IdParam = z.object({ id: z.string().min(1).max(64) });

export const homeProxyRoutes = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/network/proxy",
			tags,
			security,
			summary: "Local proxy: whether it is on, its zone and certificate",
			middleware,
			responses: { 200: json(HomeProxy, "Local proxy"), ...errors },
		}),
		async (c) => c.json(await view(c), 200),
	)
	.openapi(
		mutation(
			"home_proxy.enable",
			createRoute({
				method: "post",
				path: "/network/proxy",
				tags,
				security,
				summary: "Turn on the local proxy: HTTPS names for devices on the LAN",
				description:
					"Routes answer at `<name>.<zone>` and only to private addresses. With tls `acme` one `*.<zone>` certificate comes from Let's Encrypt over DNS-01 through the DNS provider holding the zone, so no public record is needed. With `internal` Caddy signs it with its own CA, which devices must trust.",
				middleware,
				request: body(HomeProxyEnableInput),
				responses: { 201: json(HomeProxy, "Local proxy"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			if (await load(c))
				throw new Failure("conflict", "the local proxy is already on");
			await checkSettings(c, input);
			const [row] = await c.var.deps.db
				.insert(homeProxy)
				.values(input)
				.onConflictDoNothing()
				.returning({ id: homeProxy.id });
			if (!row) throw new Failure("conflict", "the local proxy is already on");
			c.set("auditResourceId", row.id);
			await sync(c, "local proxy enabled");
			return c.json(await view(c), 201);
		},
	)
	.openapi(
		mutation(
			"home_proxy.update",
			createRoute({
				method: "patch",
				path: "/network/proxy",
				tags,
				security,
				summary: "Change the local proxy's zone or certificate",
				description:
					"Changing the zone renames every route (`<name>.<new zone>`) and needs a new certificate.",
				middleware,
				request: body(HomeProxyUpdateInput),
				responses: { 200: json(HomeProxy, "Local proxy"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const row = await enabled(c);
			const next = { zone: input.zone ?? row.zone, tls: input.tls ?? row.tls };
			await checkSettings(c, next);
			if (next.zone !== row.zone)
				for (const r of await c.var.deps.db.select().from(homeProxyRoute))
					await checkHostname(c, `${r.name}.${next.zone}`);
			await c.var.deps.db
				.update(homeProxy)
				.set({
					...next,
					...(next.tls !== row.tls && { caRootPem: null }),
				})
				.where(eq(homeProxy.id, row.id));
			c.set("auditDiff", {
				before: { zone: row.zone, tls: row.tls },
				after: next,
			});
			await sync(c, "local proxy updated");
			return c.json(await view(c), 200);
		},
	)
	.openapi(
		mutation(
			"home_proxy.disable",
			createRoute({
				method: "delete",
				path: "/network/proxy",
				tags,
				security,
				summary: "Turn off the local proxy and delete its routes",
				middleware,
				responses: { 204: { description: "Turned off" }, ...errors },
			}),
		),
		async (c) => {
			const row = await load(c);
			if (!row) throw notFound("local proxy");
			c.set("auditResourceId", row.id);
			await c.var.deps.db.transaction(async (tx) => {
				await tx.delete(homeProxyRoute);
				await tx.delete(homeProxy).where(eq(homeProxy.id, row.id));
			});
			await sync(c, "local proxy disabled");
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"home_proxy.test",
			createRoute({
				method: "post",
				path: "/network/proxy/test",
				tags,
				security,
				summary: "Check that an upstream answers HTTP from the server",
				description:
					"Any HTTP status counts as reachable; a refused connection, a timeout or a TLS failure does not.",
				middleware,
				request: body(HomeProxyTestInput),
				responses: { 200: json(HomeProxyTestResult, "Result"), ...errors },
			}),
		),
		async (c) => {
			const { upstream, insecure } = c.req.valid("json");
			const started = performance.now();
			try {
				const res = await fetch(upstream, {
					redirect: "manual",
					signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
					...(insecure && { tls: { rejectUnauthorized: false } }),
				});
				await res.body?.cancel();
				return c.json(
					{
						ok: true,
						status: res.status,
						error: null,
						ms: Math.round(performance.now() - started),
					},
					200,
				);
			} catch (e) {
				return c.json(
					{
						ok: false,
						status: null,
						error: e instanceof Error ? e.message : String(e),
						ms: Math.round(performance.now() - started),
					},
					200,
				);
			}
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/network/proxy/routes",
			tags,
			security,
			summary: "Local proxy routes, by name",
			middleware,
			responses: { 200: json(z.array(HomeProxyRoute), "Routes"), ...errors },
		}),
		async (c) => {
			const row = await load(c);
			if (!row) return c.json([], 200);
			const rows = await c.var.deps.db
				.select()
				.from(homeProxyRoute)
				.orderBy(asc(homeProxyRoute.name));
			return c.json(
				rows.map((r) => routeView(r, row.zone)),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"home_proxy.route_create",
			createRoute({
				method: "post",
				path: "/network/proxy/routes",
				tags,
				security,
				summary: "Add a route: `<name>.<zone>` to an address on the LAN",
				middleware,
				request: body(HomeProxyRouteInput),
				responses: { 201: json(HomeProxyRoute, "Route"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const proxy = await enabled(c);
			await checkHostname(c, `${input.name}.${proxy.zone}`);
			const [row] = await unique(
				c.var.deps.db.insert(homeProxyRoute).values(input).returning(),
				input.name,
			);
			if (!row) throw new Error("insert returned no row");
			c.set("auditResourceId", row.id);
			await sync(c, "local proxy route added");
			return c.json(routeView(row, proxy.zone), 201);
		},
	)
	.openapi(
		mutation(
			"home_proxy.route_update",
			createRoute({
				method: "patch",
				path: "/network/proxy/routes/{id}",
				tags,
				security,
				summary: "Change a local proxy route",
				middleware,
				request: { params: IdParam, ...body(HomeProxyRouteUpdateInput) },
				responses: { 200: json(HomeProxyRoute, "Route"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const proxy = await enabled(c);
			c.set("auditResourceId", id);
			const { db } = c.var.deps;
			const [before] = await db
				.select()
				.from(homeProxyRoute)
				.where(eq(homeProxyRoute.id, id));
			if (!before) throw notFound("route");
			if (input.name && input.name !== before.name)
				await checkHostname(c, `${input.name}.${proxy.zone}`);
			const [row] = await unique(
				db
					.update(homeProxyRoute)
					.set(input)
					.where(eq(homeProxyRoute.id, id))
					.returning(),
				input.name ?? before.name,
			);
			if (!row) throw notFound("route");
			c.set("auditDiff", {
				before: {
					name: before.name,
					upstream: before.upstream,
					insecure: before.insecure,
				},
				after: {
					name: row.name,
					upstream: row.upstream,
					insecure: row.insecure,
				},
			});
			await sync(c, "local proxy route updated");
			return c.json(routeView(row, proxy.zone), 200);
		},
	)
	.openapi(
		mutation(
			"home_proxy.route_delete",
			createRoute({
				method: "delete",
				path: "/network/proxy/routes/{id}",
				tags,
				security,
				summary: "Remove a local proxy route",
				middleware,
				request: { params: IdParam },
				responses: { 204: { description: "Removed" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			const [row] = await c.var.deps.db
				.delete(homeProxyRoute)
				.where(eq(homeProxyRoute.id, id))
				.returning({ id: homeProxyRoute.id });
			if (!row) throw notFound("route");
			await sync(c, "local proxy route removed");
			return c.body(null, 204);
		},
	);
