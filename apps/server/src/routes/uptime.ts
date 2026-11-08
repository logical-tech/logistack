import { createRoute, z } from "@hono/zod-openapi";
import {
	IncidentImpact,
	IncidentStatus,
	MaintenanceRepeat,
	MonitorConfig,
	MonitorStatus,
	StatusPageSection,
	StatusPageTheme,
	UptimeDay,
} from "@logistack/contracts";
import { type Resource, windowActive } from "@logistack/core";
import {
	type Db,
	domain,
	environment,
	incident,
	incidentUpdate,
	instanceSettings,
	maintenanceWindow,
	monitor,
	project,
	service,
	statusPage,
} from "@logistack/db";
import { runCheck } from "@logistack/worker/uptime-checks";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { type Actor, requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import {
	body,
	errors,
	IdParam,
	json,
	Name,
	patchOf,
	router,
	Slug,
	security,
} from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import {
	actorCan,
	check,
	inOrganization,
	locate,
	organizationResource,
	requirePermission,
} from "../scope.ts";
import { hostPolicy } from "../ssrf.ts";
import {
	dailyBars,
	hourlyLatency,
	incidentsWithUpdates,
	monitorStats,
	recentChecks,
} from "../uptime-query.ts";

// Uptime monitors, incidents, maintenance windows and status pages (authenticated side).
// The public pages, badges and the push endpoint live in ../status-pages.ts.

const tags = ["uptime"];

const Timestamp = z.string();
const Int = (min: number, max: number) => z.int().min(min).max(max);

const MonitorInput = z.object({
	name: Name,
	config: MonitorConfig,
	projectId: z.string().nullable().optional(),
	serviceId: z.string().nullable().optional(),
	domainId: z.string().nullable().optional(),
	intervalSec: Int(20, 86_400).optional(),
	retryIntervalSec: Int(5, 3_600).optional(),
	timeoutMs: Int(1_000, 60_000).optional(),
	downAfter: Int(1, 10).optional(),
	upAfter: Int(1, 10).optional(),
	resendMinutes: Int(0, 10_080).optional(),
	autoIncident: z.boolean().optional(),
	enabled: z.boolean().optional(),
});
type MonitorInput = z.infer<typeof MonitorInput>;

const Check = z.object({
	at: Timestamp,
	ok: z.boolean(),
	latencyMs: z.number().nullable(),
});

const MonitorView = z
	.object({
		id: z.string(),
		name: z.string(),
		kind: z.string(),
		config: MonitorConfig,
		projectId: z.string().nullable(),
		serviceId: z.string().nullable(),
		domainId: z.string().nullable(),
		intervalSec: z.number(),
		retryIntervalSec: z.number(),
		timeoutMs: z.number(),
		downAfter: z.number(),
		upAfter: z.number(),
		resendMinutes: z.number(),
		autoIncident: z.boolean(),
		enabled: z.boolean(),
		status: MonitorStatus,
		statusChangedAt: Timestamp,
		lastCheckAt: Timestamp.nullable(),
		lastPingAt: Timestamp.nullable(),
		lastLatencyMs: z.number().nullable(),
		lastError: z.string().nullable(),
		certExpiresAt: Timestamp.nullable(),
		uptime24h: z.number().nullable(),
		uptime30d: z.number().nullable(),
		recent: z.array(Check),
		createdAt: Timestamp,
	})
	.openapi("Monitor");

const MonitorCreated = MonitorView.extend({
	/** Push monitors: shown once; rotate to get a new one. */
	pushToken: z.string().optional(),
});

const MonitorDetail = MonitorView.extend({
	bars: z.array(UptimeDay),
	latency: z.array(
		z.object({
			hour: Timestamp,
			avgMs: z.number().nullable(),
			maxMs: z.number(),
			checks: z.number(),
			failures: z.number(),
		}),
	),
	checks: z.array(
		Check.extend({
			maintenance: z.boolean(),
			error: z.string().nullable(),
			region: z.string(),
		}),
	),
});

const Suggestion = z.object({
	domainId: z.string(),
	hostname: z.string(),
	url: z.string(),
	serviceId: z.string(),
	serviceName: z.string(),
	projectId: z.string(),
	projectName: z.string(),
});

const TestResult = z.object({
	ok: z.boolean(),
	latencyMs: z.number().optional(),
	error: z.string().optional(),
	certExpiresAt: Timestamp.optional(),
});

const IncidentUpdateView = z.object({
	id: z.string(),
	status: IncidentStatus,
	message: z.string(),
	createdAt: Timestamp,
});
const IncidentView = z
	.object({
		id: z.string(),
		title: z.string(),
		status: IncidentStatus,
		impact: IncidentImpact,
		monitorIds: z.array(z.string()),
		openedByMonitorId: z.string().nullable(),
		startedAt: Timestamp,
		resolvedAt: Timestamp.nullable(),
		updates: z.array(IncidentUpdateView),
	})
	.openapi("Incident");

const IncidentInput = z.object({
	title: z.string().trim().min(1).max(200),
	status: IncidentStatus.default("investigating"),
	impact: IncidentImpact.default("major"),
	monitorIds: z.array(z.string()).max(100).default([]),
	message: z.string().trim().min(1).max(10_000),
});
const IncidentUpdateInput = z.object({
	status: IncidentStatus,
	message: z.string().trim().min(1).max(10_000),
});

const MaintenanceInput = z
	.object({
		title: z.string().trim().min(1).max(200),
		description: z.string().max(5_000).default(""),
		monitorIds: z.array(z.string()).min(1).max(100),
		startsAt: z.iso.datetime({ offset: true }),
		endsAt: z.iso.datetime({ offset: true }),
		repeat: MaintenanceRepeat.default("none"),
	})
	.refine((m) => new Date(m.endsAt) > new Date(m.startsAt), {
		message: "the window must end after it starts",
		path: ["endsAt"],
	});
const MaintenanceView = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string(),
	monitorIds: z.array(z.string()),
	startsAt: Timestamp,
	endsAt: Timestamp,
	repeat: MaintenanceRepeat,
	active: z.boolean(),
});

const Hostname = z
	.string()
	.trim()
	.toLowerCase()
	.max(253)
	.regex(
		/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
		"a domain name like status.example.com",
	);
const StatusPageInput = z.object({
	title: z.string().trim().min(1).max(100),
	slug: Slug,
	description: z.string().max(2_000).default(""),
	projectId: z.string().nullable().optional(),
	hostname: Hostname.nullable().optional(),
	sections: z.array(StatusPageSection).max(20).default([]),
	theme: StatusPageTheme.default({ accent: "#2563eb", appearance: "auto" }),
	historyDays: z
		.union([z.literal(30), z.literal(60), z.literal(90)])
		.default(90),
	published: z.boolean().default(true),
});
const StatusPageView = z
	.object({
		id: z.string(),
		title: z.string(),
		slug: z.string(),
		description: z.string(),
		projectId: z.string().nullable(),
		hostname: z.string().nullable(),
		sections: z.array(StatusPageSection),
		theme: StatusPageTheme,
		historyDays: z.number(),
		published: z.boolean(),
		createdAt: Timestamp,
	})
	.openapi("StatusPage");

type MonitorRow = typeof monitor.$inferSelect;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function views(db: Db, rows: MonitorRow[]) {
	const stats = await monitorStats(
		db,
		rows.map((r) => r.id),
	);
	return rows.map((r) => {
		const { pushTokenHash: _, ...m } = r;
		const s = stats.get(r.id);
		return {
			...m,
			statusChangedAt: r.statusChangedAt.toISOString(),
			lastCheckAt: iso(r.lastCheckAt),
			lastPingAt: iso(r.lastPingAt),
			certExpiresAt: iso(r.certExpiresAt),
			createdAt: r.createdAt.toISOString(),
			uptime24h: s?.uptime24h ?? null,
			uptime30d: s?.uptime30d ?? null,
			recent: (s?.recent ?? []).map((x) => ({
				...x,
				at: x.at.toISOString(),
			})),
		};
	});
}

/** The scope a monitor or page belongs to: its project when it has one, else the organization. */
async function scopeOf(db: Db, orgId: string, projectId: string | null) {
	return projectId
		? locate(db, orgId, "project", projectId)
		: organizationResource(orgId);
}

/** Reads, filtered to what the actor may see. */
async function visible<T extends { projectId: string | null }>(
	db: Db,
	actor: Actor,
	rows: T[],
): Promise<T[]> {
	const scopes = new Map<string | null, Resource>();
	const out: T[] = [];
	for (const r of rows) {
		let s = scopes.get(r.projectId);
		if (!s) {
			s = await scopeOf(db, actor.organizationId, r.projectId).catch(() =>
				organizationResource(actor.organizationId),
			);
			scopes.set(r.projectId, s);
		}
		if (actorCan(actor, "read", s)) out.push(r);
	}
	return out;
}

async function ownMonitor(
	c: Context<Env>,
	id: string,
	action: "read" | "write" | "delete",
) {
	const { db } = c.var.deps;
	const orgId = requireActor(c).organizationId;
	const [row] = await db
		.select()
		.from(monitor)
		.where(and(eq(monitor.id, id), eq(monitor.organizationId, orgId)));
	if (!row) throw notFound("monitor");
	check(c, action, await scopeOf(db, orgId, row.projectId));
	return row;
}

/** Resolves and checks the project/service/domain a monitor is tied to; the service implies its project. */
async function placement(c: Context<Env>, input: Partial<MonitorInput>) {
	const { db } = c.var.deps;
	const orgId = requireActor(c).organizationId;
	let projectId = input.projectId;
	if (input.serviceId) {
		const s = await locate(db, orgId, "service", input.serviceId);
		projectId = s.projectId ?? null;
	}
	if (input.domainId) {
		const [d] = await db
			.select({ serviceId: domain.serviceId, projectId: project.id })
			.from(domain)
			.innerJoin(service, eq(service.id, domain.serviceId))
			.innerJoin(environment, eq(environment.id, service.environmentId))
			.innerJoin(project, eq(project.id, environment.projectId))
			.where(
				and(eq(domain.id, input.domainId), eq(project.organizationId, orgId)),
			);
		if (!d) throw notFound("domain");
		projectId = d.projectId;
	}
	if (projectId !== undefined)
		check(c, "write", await scopeOf(db, orgId, projectId));
	else check(c, "write", organizationResource(orgId));
	return projectId;
}

async function memberMonitorIds(db: Db, orgId: string, ids: string[]) {
	if (ids.length === 0) return;
	const found = await db
		.select({ id: monitor.id })
		.from(monitor)
		.where(and(eq(monitor.organizationId, orgId), inArray(monitor.id, ids)));
	if (found.length !== new Set(ids).size)
		throw new Failure("bad_request", "unknown monitor in the list");
}

const tokenHash = async (token: string) =>
	new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
	).toHex();

export const pushTokenHash = tokenHash;

function newPushToken() {
	return `lsp_${crypto.getRandomValues(new Uint8Array(24)).toHex()}`;
}

/** First deadline of a push monitor: one interval plus grace from now. */
const pushDeadline = (intervalSec: number, config: MonitorConfig) =>
	new Date(
		Date.now() +
			(intervalSec + (config.kind === "push" ? config.push.graceSec : 0)) *
				1000,
	);

async function dashboardHost(db: Db) {
	const [s] = await db.select().from(instanceSettings);
	return (
		s?.primaryDomain ??
		(s?.publicUrl ? new URL(s.publicUrl).hostname : undefined)
	);
}

/** A status page hostname must not be the dashboard's nor a service domain's. */
async function assertFreeHostname(db: Db, hostname: string) {
	if (hostname === (await dashboardHost(db)))
		throw new Failure("conflict", "that is the dashboard's own hostname");
	const [taken] = await db
		.select({ id: domain.id })
		.from(domain)
		.where(eq(domain.hostname, hostname))
		.limit(1);
	if (taken)
		throw new Failure("conflict", `${hostname} already routes to a service`);
}

async function assertSections(
	db: Db,
	orgId: string,
	sections: z.infer<typeof StatusPageSection>[],
) {
	await memberMonitorIds(
		db,
		orgId,
		sections.flatMap((s) => s.monitors.map((m) => m.monitorId)),
	);
}

function pageView(r: typeof statusPage.$inferSelect) {
	return { ...r, createdAt: r.createdAt.toISOString() };
}

function incidentView(
	r: Awaited<ReturnType<typeof incidentsWithUpdates>>[number],
) {
	return {
		id: r.id,
		title: r.title,
		status: r.status,
		impact: r.impact,
		monitorIds: r.monitorIds,
		openedByMonitorId: r.openedByMonitorId,
		startedAt: r.startedAt.toISOString(),
		resolvedAt: iso(r.resolvedAt),
		updates: r.updates.map((u) => ({
			id: u.id,
			status: u.status,
			message: u.message,
			createdAt: u.createdAt.toISOString(),
		})),
	};
}

async function oneIncident(db: Db, orgId: string, id: string) {
	const [r] = (await incidentsWithUpdates(db, orgId, { limit: 1000 })).filter(
		(i) => i.id === id,
	);
	if (!r) throw notFound("incident");
	return incidentView(r);
}

const syncProxy = (c: Context<Env>, reason: string) =>
	requestProxySync(c.var.deps.config.REDIS_URL, reason).catch(() => {});

export const uptime = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/monitors",
			tags,
			security,
			summary: "Uptime monitors with their status and recent checks",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(MonitorView), "Monitors"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const rows = await db
				.select()
				.from(monitor)
				.where(eq(monitor.organizationId, actor.organizationId))
				.orderBy(asc(monitor.name));
			return c.json(await views(db, await visible(db, actor, rows)), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/monitors/suggestions",
			tags,
			security,
			summary: "Domains without a monitor, each with a ready HTTP monitor",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(Suggestion), "Suggestions"), ...errors },
		}),
		async (c) => {
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const rows = await db
				.select({
					domainId: domain.id,
					hostname: domain.hostname,
					https: domain.https,
					pathPrefix: domain.pathPrefix,
					redirectTo: domain.redirectTo,
					serviceId: service.id,
					serviceName: service.name,
					projectId: project.id,
					projectName: project.name,
				})
				.from(domain)
				.innerJoin(service, eq(service.id, domain.serviceId))
				.innerJoin(environment, eq(environment.id, service.environmentId))
				.innerJoin(project, eq(project.id, environment.projectId))
				.where(
					and(
						eq(project.organizationId, actor.organizationId),
						isNull(project.archivedAt),
					),
				)
				.orderBy(asc(domain.hostname));
			const covered = new Set(
				(
					await db
						.select({ domainId: monitor.domainId })
						.from(monitor)
						.where(eq(monitor.organizationId, actor.organizationId))
				).map((m) => m.domainId),
			);
			const open = rows.filter(
				(r) =>
					!covered.has(r.domainId) &&
					!r.redirectTo &&
					!r.hostname.startsWith("*."),
			);
			return c.json(
				(await visible(db, actor, open)).map((r) => ({
					domainId: r.domainId,
					hostname: r.hostname,
					url: `${r.https ? "https" : "http"}://${r.hostname}${r.pathPrefix ?? "/"}`,
					serviceId: r.serviceId,
					serviceName: r.serviceName,
					projectId: r.projectId,
					projectName: r.projectName,
				})),
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/monitors/test",
			tags,
			security,
			summary: "Run a check once without saving it (the wizard's test step)",
			middleware: [requirePermission("write", inOrganization)],
			request: body(
				z.object({
					config: MonitorConfig,
					timeoutMs: Int(1_000, 60_000).optional(),
				}),
			),
			responses: { 200: json(TestResult, "Result"), ...errors },
		}),
		async (c) => {
			const { config, timeoutMs } = c.req.valid("json");
			if (config.kind === "push") return c.json({ ok: true }, 200);
			const r = await runCheck(config, timeoutMs ?? 10_000, {
				policy: await hostPolicy(c.var.deps.db),
			});
			return c.json(
				{
					ok: r.ok,
					...(r.latencyMs !== undefined && { latencyMs: r.latencyMs }),
					...(r.error && { error: r.error }),
					...(r.certExpiresAt && {
						certExpiresAt: r.certExpiresAt.toISOString(),
					}),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"monitor.create",
			createRoute({
				method: "post",
				path: "/monitors",
				tags,
				security,
				request: body(MonitorInput),
				responses: { 201: json(MonitorCreated, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const projectId = await placement(c, input);
			const token = input.config.kind === "push" ? newPushToken() : undefined;
			const row = one(
				await db
					.insert(monitor)
					.values({
						...input,
						organizationId: orgId,
						projectId: projectId ?? null,
						kind: input.config.kind,
						status: input.enabled === false ? "paused" : "pending",
						...(token && {
							pushTokenHash: await tokenHash(token),
							nextCheckAt: pushDeadline(input.intervalSec ?? 60, input.config),
						}),
					})
					.returning(),
			);
			c.set("auditResourceId", row.id);
			const [view] = await views(db, [row]);
			return c.json({ ...view!, ...(token && { pushToken: token }) }, 201);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/monitors/{id}",
			tags,
			security,
			summary:
				"A monitor with its 90-day bars, hourly latency and recent checks",
			request: { params: IdParam },
			responses: { 200: json(MonitorDetail, "Monitor"), ...errors },
		}),
		async (c) => {
			const row = await ownMonitor(c, c.req.valid("param").id, "read");
			const { db } = c.var.deps;
			const [view] = await views(db, [row]);
			const [bars, latency, checks] = await Promise.all([
				dailyBars(db, [row.id], 90),
				hourlyLatency(db, row.id, 24 * 7),
				recentChecks(db, row.id, 50),
			]);
			return c.json(
				{
					...view!,
					bars: bars.get(row.id) ?? [],
					latency: latency.map((l) => ({ ...l, hour: l.hour.toISOString() })),
					checks: checks.map((x) => ({ ...x, at: x.at.toISOString() })),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"monitor.update",
			createRoute({
				method: "patch",
				path: "/monitors/{id}",
				tags,
				security,
				summary: "Edit, pause or resume a monitor",
				request: { params: IdParam, ...body(patchOf(MonitorInput)) },
				responses: { 200: json(MonitorView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const prev = await ownMonitor(c, c.req.valid("param").id, "write");
			const { db } = c.var.deps;
			const moved =
				input.projectId !== undefined ||
				input.serviceId !== undefined ||
				input.domainId !== undefined;
			const projectId = moved ? await placement(c, input) : undefined;
			const config = input.config ?? prev.config;
			// A new target or new timing starts over: the old streak says nothing about it.
			const restart =
				input.config !== undefined ||
				input.intervalSec !== undefined ||
				(input.enabled === true && !prev.enabled);
			if (config.kind === "push" && prev.kind !== "push")
				throw new Failure(
					"bad_request",
					"a monitor cannot become a push monitor; create a new one",
				);
			const row = one(
				await db
					.update(monitor)
					.set({
						...input,
						...(projectId !== undefined && { projectId }),
						kind: config.kind,
						...(input.enabled === false && { status: "paused" as const }),
						...(restart && {
							status: "pending" as const,
							streak: 0,
							statusChangedAt: new Date(),
							nextCheckAt:
								config.kind === "push"
									? pushDeadline(input.intervalSec ?? prev.intervalSec, config)
									: new Date(),
						}),
					})
					.where(eq(monitor.id, prev.id))
					.returning(),
			);
			const [view] = await views(db, [row]);
			return c.json(view!, 200);
		},
	)
	.openapi(
		mutation(
			"monitor.push_token",
			createRoute({
				method: "post",
				path: "/monitors/{id}/push-token",
				tags,
				security,
				summary: "Issue a new push token; the old one stops working",
				request: { params: IdParam },
				responses: {
					200: json(z.object({ pushToken: z.string() }), "New token"),
					...errors,
				},
			}),
		),
		async (c) => {
			const prev = await ownMonitor(c, c.req.valid("param").id, "write");
			if (prev.kind !== "push")
				throw new Failure("bad_request", "only push monitors have a token");
			const token = newPushToken();
			await c.var.deps.db
				.update(monitor)
				.set({ pushTokenHash: await tokenHash(token) })
				.where(eq(monitor.id, prev.id));
			return c.json({ pushToken: token }, 200);
		},
	)
	.openapi(
		mutation(
			"monitor.delete",
			createRoute({
				method: "delete",
				path: "/monitors/{id}",
				tags,
				security,
				summary: "Delete a monitor and its history",
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const prev = await ownMonitor(c, c.req.valid("param").id, "delete");
			await c.var.deps.db.delete(monitor).where(eq(monitor.id, prev.id));
			return c.body(null, 204);
		},
	)
	// Incidents
	.openapi(
		createRoute({
			method: "get",
			path: "/incidents",
			tags,
			security,
			summary: "Incidents, newest first, with their updates",
			middleware: [requirePermission("read", inOrganization)],
			responses: { 200: json(z.array(IncidentView), "Incidents"), ...errors },
		}),
		async (c) => {
			const rows = await incidentsWithUpdates(
				c.var.deps.db,
				requireActor(c).organizationId,
				{ limit: 200 },
			);
			return c.json(rows.map(incidentView), 200);
		},
	)
	.openapi(
		mutation(
			"incident.create",
			createRoute({
				method: "post",
				path: "/incidents",
				tags,
				security,
				middleware: [requirePermission("write", inOrganization)],
				request: body(IncidentInput),
				responses: { 201: json(IncidentView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			await memberMonitorIds(db, actor.organizationId, input.monitorIds);
			const now = new Date();
			const row = await db.transaction(async (tx) => {
				const r = one(
					await tx
						.insert(incident)
						.values({
							organizationId: actor.organizationId,
							title: input.title,
							status: input.status,
							impact: input.impact,
							monitorIds: input.monitorIds,
							startedAt: now,
							...(input.status === "resolved" && { resolvedAt: now }),
						})
						.returning(),
				);
				await tx.insert(incidentUpdate).values({
					incidentId: r.id,
					status: input.status,
					message: input.message,
					authorId: actor.userId ?? null,
					createdAt: now,
				});
				return r;
			});
			c.set("auditResourceId", row.id);
			return c.json(await oneIncident(db, actor.organizationId, row.id), 201);
		},
	)
	.openapi(
		mutation(
			"incident.update",
			createRoute({
				method: "post",
				path: "/incidents/{id}/updates",
				tags,
				security,
				summary: "Post an update; its status becomes the incident's",
				middleware: [requirePermission("write", inOrganization)],
				request: { params: IdParam, ...body(IncidentUpdateInput) },
				responses: { 200: json(IncidentView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const now = new Date();
			await db.transaction(async (tx) => {
				const [r] = await tx
					.update(incident)
					.set({
						status: input.status,
						resolvedAt: input.status === "resolved" ? now : null,
					})
					.where(
						and(
							eq(incident.id, id),
							eq(incident.organizationId, actor.organizationId),
						),
					)
					.returning({ id: incident.id });
				if (!r) throw notFound("incident");
				await tx.insert(incidentUpdate).values({
					incidentId: id,
					status: input.status,
					message: input.message,
					authorId: actor.userId ?? null,
					createdAt: now,
				});
			});
			return c.json(await oneIncident(db, actor.organizationId, id), 200);
		},
	)
	.openapi(
		mutation(
			"incident.delete",
			createRoute({
				method: "delete",
				path: "/incidents/{id}",
				tags,
				security,
				middleware: [requirePermission("delete", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			await c.var.deps.db
				.delete(incident)
				.where(
					and(
						eq(incident.id, c.req.valid("param").id),
						eq(incident.organizationId, requireActor(c).organizationId),
					),
				);
			return c.body(null, 204);
		},
	)
	// Maintenance windows
	.openapi(
		createRoute({
			method: "get",
			path: "/maintenance-windows",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.array(MaintenanceView), "Maintenance windows"),
				...errors,
			},
		}),
		async (c) => {
			const now = new Date();
			const rows = await c.var.deps.db
				.select()
				.from(maintenanceWindow)
				.where(
					eq(maintenanceWindow.organizationId, requireActor(c).organizationId),
				)
				.orderBy(desc(maintenanceWindow.startsAt));
			return c.json(
				rows.map((r) => ({
					id: r.id,
					title: r.title,
					description: r.description,
					monitorIds: r.monitorIds,
					startsAt: r.startsAt.toISOString(),
					endsAt: r.endsAt.toISOString(),
					repeat: r.repeat,
					active: windowActive(r, now),
				})),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"maintenance.create",
			createRoute({
				method: "post",
				path: "/maintenance-windows",
				tags,
				security,
				middleware: [requirePermission("write", inOrganization)],
				request: body(MaintenanceInput),
				responses: { 201: json(MaintenanceView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			await memberMonitorIds(db, orgId, input.monitorIds);
			const r = one(
				await db
					.insert(maintenanceWindow)
					.values({
						...input,
						organizationId: orgId,
						startsAt: new Date(input.startsAt),
						endsAt: new Date(input.endsAt),
					})
					.returning(),
			);
			c.set("auditResourceId", r.id);
			return c.json(
				{
					id: r.id,
					title: r.title,
					description: r.description,
					monitorIds: r.monitorIds,
					startsAt: r.startsAt.toISOString(),
					endsAt: r.endsAt.toISOString(),
					repeat: r.repeat,
					active: windowActive(r, new Date()),
				},
				201,
			);
		},
	)
	.openapi(
		mutation(
			"maintenance.delete",
			createRoute({
				method: "delete",
				path: "/maintenance-windows/{id}",
				tags,
				security,
				middleware: [requirePermission("delete", inOrganization)],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			await c.var.deps.db
				.delete(maintenanceWindow)
				.where(
					and(
						eq(maintenanceWindow.id, c.req.valid("param").id),
						eq(
							maintenanceWindow.organizationId,
							requireActor(c).organizationId,
						),
					),
				);
			return c.body(null, 204);
		},
	)
	// Status pages
	.openapi(
		createRoute({
			method: "get",
			path: "/status-pages",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.array(StatusPageView), "Status pages"),
				...errors,
			},
		}),
		async (c) => {
			const { db } = c.var.deps;
			const actor = requireActor(c);
			const rows = await db
				.select()
				.from(statusPage)
				.where(eq(statusPage.organizationId, actor.organizationId))
				.orderBy(asc(statusPage.title));
			return c.json((await visible(db, actor, rows)).map(pageView), 200);
		},
	)
	.openapi(
		mutation(
			"status_page.create",
			createRoute({
				method: "post",
				path: "/status-pages",
				tags,
				security,
				request: body(StatusPageInput),
				responses: { 201: json(StatusPageView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			check(c, "write", await scopeOf(db, orgId, input.projectId ?? null));
			await assertSections(db, orgId, input.sections);
			if (input.hostname) await assertFreeHostname(db, input.hostname);
			const r = one(
				await db
					.insert(statusPage)
					.values({ ...input, organizationId: orgId })
					.returning(),
			);
			c.set("auditResourceId", r.id);
			if (r.hostname) await syncProxy(c, "status page created");
			return c.json(pageView(r), 201);
		},
	)
	.openapi(
		mutation(
			"status_page.update",
			createRoute({
				method: "patch",
				path: "/status-pages/{id}",
				tags,
				security,
				request: { params: IdParam, ...body(patchOf(StatusPageInput)) },
				responses: { 200: json(StatusPageView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const [prev] = await db
				.select()
				.from(statusPage)
				.where(
					and(eq(statusPage.id, id), eq(statusPage.organizationId, orgId)),
				);
			if (!prev) throw notFound("status page");
			check(c, "write", await scopeOf(db, orgId, prev.projectId));
			if (input.projectId !== undefined)
				check(c, "write", await scopeOf(db, orgId, input.projectId));
			if (input.sections) await assertSections(db, orgId, input.sections);
			if (input.hostname && input.hostname !== prev.hostname)
				await assertFreeHostname(db, input.hostname);
			const r = one(
				await db
					.update(statusPage)
					.set(input)
					.where(
						and(eq(statusPage.id, id), eq(statusPage.organizationId, orgId)),
					)
					.returning(),
			);
			if (r.hostname !== prev.hostname || r.published !== prev.published)
				await syncProxy(c, "status page changed");
			return c.json(pageView(r), 200);
		},
	)
	.openapi(
		mutation(
			"status_page.delete",
			createRoute({
				method: "delete",
				path: "/status-pages/{id}",
				tags,
				security,
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			const orgId = requireActor(c).organizationId;
			const [prev] = await db
				.select()
				.from(statusPage)
				.where(
					and(eq(statusPage.id, id), eq(statusPage.organizationId, orgId)),
				);
			if (!prev) throw notFound("status page");
			check(c, "delete", await scopeOf(db, orgId, prev.projectId));
			await db.delete(statusPage).where(eq(statusPage.id, id));
			if (prev.hostname) await syncProxy(c, "status page deleted");
			return c.body(null, 204);
		},
	);
