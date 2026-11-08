import type { EventEnvelope } from "@logistack/contracts";
import { overallStatus, totalUptime, windowActive } from "@logistack/core";
import {
	type Db,
	instanceSettings,
	maintenanceWindow,
	monitor,
	monitorDaily,
	statusPage,
} from "@logistack/db";
import { recordResult } from "@logistack/worker/uptime-record";
import { and, eq, gte, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { Deps, Env } from "./env.ts";
import { envelope } from "./events.ts";
import { pushTokenHash } from "./routes/uptime.ts";
import {
	type PageData,
	renderStatusPage,
	statusBadge,
	uptimeBadge,
} from "./status-render.ts";
import { dailyBars, incidentsWithUpdates } from "./uptime-query.ts";

// Public, unauthenticated: status pages (`/status/<slug>` on the dashboard host, `/` on a page's
// own hostname), their badges and JSON, and the push endpoint cron jobs ping.

type Page = typeof statusPage.$inferSelect;

const CACHE = "public, max-age=30";

/** Mean of the days with data: each day weighs the same, as the bars show them. */
function meanUptime(days: { uptime: number | null }[]) {
	const known = days.flatMap((d) => (d.uptime === null ? [] : [d.uptime]));
	return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

const pageMonitorIds = (p: Page) =>
	p.sections.flatMap((s) => s.monitors.map((m) => m.monitorId));

export async function loadPageData(
	db: Db,
	page: Page,
	now = new Date(),
): Promise<PageData> {
	const ids = pageMonitorIds(page);
	const [mons, bars, incidents, windows] = await Promise.all([
		ids.length
			? db
					.select({
						id: monitor.id,
						name: monitor.name,
						status: monitor.status,
					})
					.from(monitor)
					.where(
						and(
							inArray(monitor.id, ids),
							eq(monitor.organizationId, page.organizationId),
						),
					)
			: [],
		dailyBars(db, ids, page.historyDays, now),
		incidentsWithUpdates(db, page.organizationId, {
			monitorIds: ids,
			since: new Date(now.getTime() - page.historyDays * 86_400_000),
			limit: 20,
		}),
		db
			.select()
			.from(maintenanceWindow)
			.where(eq(maintenanceWindow.organizationId, page.organizationId)),
	]);
	const byId = new Map(mons.map((m) => [m.id, m]));
	const sections = page.sections.map((s) => ({
		name: s.name,
		monitors: s.monitors.flatMap((m) => {
			const row = byId.get(m.monitorId);
			if (!row) return [];
			const days = bars.get(m.monitorId) ?? [];
			return [
				{
					id: row.id,
					label: m.label || row.name,
					status: row.status,
					uptime: meanUptime(days),
					bars: days,
				},
			];
		}),
	}));
	const week = 7 * 86_400_000;
	const maintenance = windows
		.filter((w) => w.monitorIds.some((id) => ids.includes(id)))
		.flatMap((w) => {
			const active = windowActive(w, now);
			const upcoming =
				w.repeat === "none" &&
				w.startsAt > now &&
				w.startsAt.getTime() - now.getTime() < week;
			return active || upcoming
				? [
						{
							title: w.title,
							description: w.description,
							startsAt: w.startsAt,
							endsAt: w.endsAt,
							active,
						},
					]
				: [];
		});
	return {
		title: page.title,
		description: page.description,
		theme: page.theme,
		overall: overallStatus(
			sections.flatMap((s) => s.monitors.map((m) => m.status)),
		),
		sections,
		incidents: incidents.map((i) => ({
			title: i.title,
			status: i.status,
			impact: i.impact,
			startedAt: i.startedAt,
			resolvedAt: i.resolvedAt,
			updates: i.updates.map((u) => ({
				status: u.status,
				message: u.message,
				createdAt: u.createdAt,
			})),
		})),
		maintenance,
		historyDays: page.historyDays,
		generatedAt: now,
	};
}

async function pageBy(db: Db, where: ReturnType<typeof eq>) {
	const [p] = await db
		.select()
		.from(statusPage)
		.where(and(where, eq(statusPage.published, true)));
	return p;
}

/** Monitor uptime over `days` from the daily rollups. */
async function uptimeOver(db: Db, monitorId: string, days: number) {
	const rows = await db
		.select()
		.from(monitorDaily)
		.where(
			and(
				eq(monitorDaily.monitorId, monitorId),
				gte(
					monitorDaily.day,
					new Date(Date.now() - (days - 1) * 86_400_000)
						.toISOString()
						.slice(0, 10),
				),
			),
		);
	return totalUptime(rows);
}

/** Routes under one page: `/`, `/summary.json`, `/badge/<monitorId>.svg`. */
function pageRoutes(
	find: (
		c: {
			req: {
				param(k: string): string | undefined;
				header(k: string): string | undefined;
			};
		},
		db: Db,
	) => Promise<Page | undefined>,
) {
	const app = new Hono<Env>();
	app.get("/", async (c) => {
		const page = await find(c, c.var.deps.db);
		if (!page) return c.text("status page not found", 404);
		c.header("cache-control", CACHE);
		c.header(
			"content-security-policy",
			"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors *",
		);
		return c.html(renderStatusPage(await loadPageData(c.var.deps.db, page)));
	});
	app.get("/summary.json", async (c) => {
		const page = await find(c, c.var.deps.db);
		if (!page)
			return c.json(
				{ error: { code: "not_found", message: "status page not found" } },
				404,
			);
		const d = await loadPageData(c.var.deps.db, page);
		c.header("cache-control", CACHE);
		c.header("access-control-allow-origin", "*");
		return c.json({
			title: d.title,
			status: d.overall,
			monitors: d.sections.flatMap((s) =>
				s.monitors.map((m) => ({
					id: m.id,
					name: m.label,
					status: m.status,
					uptime: m.uptime,
				})),
			),
			incidents: d.incidents
				.filter((i) => !i.resolvedAt)
				.map((i) => ({
					title: i.title,
					status: i.status,
					startedAt: i.startedAt,
				})),
		});
	});
	app.get("/badge/:file", async (c) => {
		const file = c.req.param("file");
		const id = file.endsWith(".svg") ? file.slice(0, -4) : file;
		const page = await find(c, c.var.deps.db);
		// Only monitors the page lists: a badge never reveals another monitor of the org.
		const listed = page && pageMonitorIds(page).includes(id);
		const db = c.var.deps.db;
		const type = c.req.query("type") === "uptime" ? "uptime" : "status";
		const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 90);
		let svg: string;
		if (!listed) svg = statusBadge(undefined);
		else if (type === "uptime")
			svg = uptimeBadge(await uptimeOver(db, id, days), days);
		else {
			const [m] = await db
				.select({ status: monitor.status })
				.from(monitor)
				.where(eq(monitor.id, id));
			svg = statusBadge(m?.status);
		}
		c.header("content-type", "image/svg+xml; charset=utf-8");
		c.header("cache-control", "public, max-age=60");
		return c.body(svg, listed ? 200 : 404);
	});
	return app;
}

/** `/status/<slug>/...` on the dashboard host. */
export const statusBySlug = pageRoutes((c, db) =>
	pageBy(db, eq(statusPage.slug, c.req.param("slug") ?? "")),
);

const hostOf = (h: string | undefined) =>
	(h ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

/** `/...` on a page's own hostname. */
export const statusByHost = pageRoutes((c, db) =>
	pageBy(db, eq(statusPage.hostname, hostOf(c.req.header("host")))),
);

let hosts: { at: number; set: Set<string>; dashboard?: string } = {
	at: 0,
	set: new Set(),
};

/** Status page hostnames, refreshed every 15 s (a new page's route waits on Caddy anyway). */
async function statusHosts(db: Db) {
	if (Date.now() - hosts.at > 15_000) {
		const [rows, [s]] = await Promise.all([
			db
				.select({ hostname: statusPage.hostname })
				.from(statusPage)
				.where(eq(statusPage.published, true)),
			db.select().from(instanceSettings),
		]);
		hosts = {
			at: Date.now(),
			set: new Set(rows.flatMap((r) => (r.hostname ? [r.hostname] : []))),
			dashboard:
				s?.primaryDomain ??
				(s?.publicUrl ? new URL(s.publicUrl).hostname : undefined),
		};
	}
	return hosts;
}

/** Test hook: forget cached hostnames. */
export const resetStatusHosts = () => {
	hosts = { at: 0, set: new Set() };
};

/**
 * A request whose Host is a status page's own hostname is answered by that page and nothing
 * else: no API, no dashboard, so a custom domain never exposes the app.
 */
export function statusHostRouter(deps: Deps): MiddlewareHandler<Env> {
	const byHost = new Hono<Env>()
		.use(async (c, n) => {
			c.set("deps", deps);
			await n();
		})
		.route("/", statusByHost);
	return async (c, next) => {
		const host = hostOf(c.req.header("host"));
		const h = await statusHosts(deps.db).catch(() => undefined);
		if (!h?.set.has(host) || host === h.dashboard) return next();
		const path = new URL(c.req.url).pathname;
		if (c.req.method !== "GET" && c.req.method !== "HEAD")
			return c.text("method not allowed", 405);
		if (path === "/" || path === "/summary.json" || path.startsWith("/badge/"))
			return byHost.fetch(c.req.raw, c.env);
		return c.text("not found", 404);
	};
}

export const push = new Hono<Env>().on(
	["GET", "POST"],
	"/:token",
	async (c) => {
		const { db, bus } = c.var.deps;
		const hash = await pushTokenHash(c.req.param("token"));
		const [m] = await db
			.select({ id: monitor.id, enabled: monitor.enabled })
			.from(monitor)
			.where(and(eq(monitor.pushTokenHash, hash), eq(monitor.kind, "push")));
		if (!m) return c.json({ ok: false, error: "unknown push token" }, 404);
		if (!m.enabled)
			return c.json({ ok: false, error: "monitor is paused" }, 409);
		const down = c.req.query("status") === "down";
		const msg = c.req.query("msg")?.slice(0, 500);
		const ping = Number(c.req.query("ping"));
		await db
			.update(monitor)
			.set({ lastPingAt: new Date() })
			.where(eq(monitor.id, m.id));
		await recordResult(
			db,
			(type, org, resource, payload) =>
				bus.publishEvent(
					envelope(type, org, resource, payload as EventEnvelope["payload"]),
				),
			m.id,
			{
				ok: !down,
				...(Number.isFinite(ping) &&
					ping >= 0 && { latencyMs: Math.round(ping) }),
				...(down && { error: msg || "reported down" }),
			},
		);
		return c.json({ ok: true });
	},
);
