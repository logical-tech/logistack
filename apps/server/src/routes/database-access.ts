import { createRoute, z } from "@hono/zod-openapi";
import {
	DatabaseAccessList,
	DatabaseAccessView,
	type DatabaseEngine,
	DatabaseUpgradeInput,
	DatabaseUpgradeView,
	PortForwardInput,
	PublicAccessInput,
} from "@logistack/contracts";
import {
	connectionUri,
	FORWARD_PORT_RANGE,
	ingressPortHolder,
	isExposable,
	isLaterVersion,
	publishedPortConflicts,
	UPGRADABLE_ENGINES,
} from "@logistack/core";
import { databaseAccess, databaseUpgrade, node, service } from "@logistack/db";
import { and, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { clientIp, mutation } from "../audit.ts";
import { credentials, LOGIN } from "../database.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { portHolders } from "../host-settings.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { runQueues } from "../run-queues.ts";
import { byParam, requirePermission } from "../scope.ts";

// Public access, port forwards and major-version upgrades of a database service
// (docs/plans/database-ops.md). The worker converges gateways to these rows.

const tags = ["databases"];
const svc = byParam("service");
const Id = z.object({ id: z.string() });
const AccessParams = z.object({ id: z.string(), accessId: z.string() });
const UpgradeParams = z.object({ id: z.string(), upgradeId: z.string() });

type AccessRow = typeof databaseAccess.$inferSelect;

async function databaseRow(c: Context<Env>, id: string) {
	const [row] = await c.var.deps.db
		.select({
			id: service.id,
			spec: service.spec,
			nodeId: service.nodeId,
			dataVolumeId: service.dataVolumeId,
		})
		.from(service)
		.where(eq(service.id, id));
	if (!row) throw notFound("service");
	if (row.spec.kind !== "database")
		throw new Failure("bad_request", "not a database service");
	return { ...row, spec: row.spec };
}

/** Nudges the worker to converge gateways now instead of on its next 30 s pass. */
const converge = (c: Context<Env>) =>
	runQueues(c.var.deps.config.REDIS_URL)
		.maintenance.add("db-access", {}, { removeOnComplete: true })
		.catch(() => {});

/** Where a forward's clients connect: the database node's public address. */
async function nodeAddress(c: Context<Env>, nodeId: string | null) {
	if (nodeId) {
		const [n] = await c.var.deps.db
			.select({ address: node.address, publicAddress: node.publicAddress })
			.from(node)
			.where(eq(node.id, nodeId));
		if (n) return n.publicAddress ?? n.address;
	}
	return c.var.deps.config.PUBLIC_IP ?? null;
}

async function view(
	c: Context<Env>,
	row: AccessRow,
	db: { id: string; engine: DatabaseEngine; nodeId: string | null },
): Promise<DatabaseAccessView> {
	const host =
		row.kind === "public" ? row.hostname : await nodeAddress(c, db.nodeId);
	const login = LOGIN[db.engine]?.(await credentials(c.var.deps, db.id));
	return {
		id: row.id,
		kind: row.kind,
		hostname: row.hostname,
		port: row.port,
		allowedCidrs: row.allowedCidrs,
		tlsRequired: row.tlsRequired,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		status: row.status,
		statusMessage: row.statusMessage,
		createdAt: row.createdAt.toISOString(),
		host,
		uri:
			host && login
				? connectionUri({
						engine: db.engine,
						host,
						port: row.port,
						user: login.user,
						database: login.database,
						tls: !row.tlsRequired
							? false
							: row.kind === "public"
								? "verify"
								: "require",
					})
				: null,
	};
}

/** Refuses a port another service, Caddy or another gateway already publishes on that node. */
async function refusePortConflict(
	c: Context<Env>,
	candidate: { id: string; nodeId: string | null; port: number },
) {
	const [conflict] = publishedPortConflicts(
		{
			id: candidate.id,
			nodeId: candidate.nodeId,
			ports: [
				{ target: candidate.port, published: candidate.port, protocol: "tcp" },
			],
		},
		[...(await portHolders(c)), ingressPortHolder],
	);
	if (conflict)
		throw new Failure(
			"conflict",
			`port ${conflict.port} is already published on that node`,
			{ port: conflict.port },
		);
}

async function pickForwardPort(c: Context<Env>, nodeId: string | null) {
	const holders = [...(await portHolders(c)), ingressPortHolder];
	for (
		let port = FORWARD_PORT_RANGE.from;
		port <= FORWARD_PORT_RANGE.to;
		port++
	)
		if (
			!publishedPortConflicts(
				{
					id: "",
					nodeId,
					ports: [{ target: port, published: port, protocol: "tcp" }],
				},
				holders,
			).length
		)
			return port;
	throw new Failure("conflict", "every port forward port is taken");
}

const upgradeView = (
	u: typeof databaseUpgrade.$inferSelect,
): DatabaseUpgradeView => ({
	id: u.id,
	fromVersion: u.fromVersion,
	toVersion: u.toVersion,
	status: u.status,
	step: u.step,
	message: u.message,
	tables: u.counts ? Object.keys(u.counts).length : null,
	createdAt: u.createdAt.toISOString(),
	finishedAt: u.finishedAt?.toISOString() ?? null,
});

export const databaseAccessRoutes = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/databases/{id}/access",
			tags,
			security,
			summary: "Public access and port forwards of a database",
			description:
				"Each entry is a gateway on the database's node: public access (a hostname with a certificate, TLS required, an allowlist) or a temporary port forward. `uri` holds the engine's TLS parameter and `PASSWORD` in place of the password. `yourIp` is the address this request came from.",
			middleware: [requirePermission("read", svc)],
			request: { params: Id },
			responses: { 200: json(DatabaseAccessList, "Access"), ...errors },
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const db = await databaseRow(c, id);
			const rows = await c.var.deps.db
				.select()
				.from(databaseAccess)
				.where(eq(databaseAccess.serviceId, id))
				.orderBy(databaseAccess.createdAt);
			const live = rows.filter((r) => !r.expiresAt || r.expiresAt > new Date());
			return c.json(
				{
					access: await Promise.all(
						live.map((r) =>
							view(c, r, { id, engine: db.spec.engine, nodeId: db.nodeId }),
						),
					),
					yourIp: clientIp(c),
					exposable: isExposable(db.spec.engine),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"database.public_access",
			createRoute({
				method: "put",
				path: "/databases/{id}/access/public",
				tags,
				security,
				summary: "Expose a database publicly with TLS and an IP allowlist",
				description:
					"Creates or replaces the database's public access. Caddy issues a certificate for `hostname`, which must resolve to the database's node; once it exists the database restarts once to serve it, and the gateway starts on `port`. Only sources in `allowedCidrs` connect, and only with TLS. Needs `admin`.",
				middleware: [requirePermission("admin", svc)],
				request: { params: Id, ...body(PublicAccessInput) },
				responses: {
					200: json(DatabaseAccessView, "Public access"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const db = await databaseRow(c, id);
			if (!isExposable(db.spec.engine))
				throw new Failure(
					"bad_request",
					`${db.spec.engine} cannot be exposed: it has no TLS of its own`,
				);
			const [existing] = await c.var.deps.db
				.select()
				.from(databaseAccess)
				.where(
					and(
						eq(databaseAccess.serviceId, id),
						eq(databaseAccess.kind, "public"),
					),
				);
			await refusePortConflict(c, {
				id: existing?.id ?? "",
				nodeId: db.nodeId,
				port: input.port,
			});
			const values = {
				hostname: input.hostname,
				port: input.port,
				allowedCidrs: input.allowedCidrs,
				tlsRequired: true,
			};
			const [row] = existing
				? await c.var.deps.db
						.update(databaseAccess)
						.set({
							...values,
							// A new name needs a new certificate.
							...(existing.hostname !== input.hostname && {
								status: "pending" as const,
								certNotAfter: null,
							}),
						})
						.where(eq(databaseAccess.id, existing.id))
						.returning()
				: await c.var.deps.db
						.insert(databaseAccess)
						.values({
							...values,
							organizationId: actor.organizationId,
							serviceId: id,
							kind: "public",
							createdBy: actor.userId,
						})
						.returning();
			if (!row) throw new Failure("internal", "access not saved");
			c.set("auditResourceId", id);
			c.set("auditDiff", { accessId: row.id, ...values });
			await requestProxySync(
				c.var.deps.config.REDIS_URL,
				"database access",
			).catch(() => {});
			await converge(c);
			return c.json(
				await view(c, row, { id, engine: db.spec.engine, nodeId: db.nodeId }),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"database.public_access_delete",
			createRoute({
				method: "delete",
				path: "/databases/{id}/access/public",
				tags,
				security,
				summary: "Close a database's public access",
				description:
					"Removes the gateway; the port closes within seconds. The database keeps serving TLS beside plain until its next deploy. Needs `admin`.",
				middleware: [requirePermission("admin", svc)],
				request: { params: Id },
				responses: { 204: { description: "Closed" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			c.set("auditResourceId", id);
			await c.var.deps.db
				.delete(databaseAccess)
				.where(
					and(
						eq(databaseAccess.serviceId, id),
						eq(databaseAccess.kind, "public"),
					),
				);
			await converge(c);
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"database.port_forward",
			createRoute({
				method: "post",
				path: "/databases/{id}/forwards",
				tags,
				security,
				summary: "Open a temporary port forward to a database",
				description:
					"A port from 15000-15999 on the database's node, open to `allowedCidrs` (default: the caller's address) for `minutes`, then closed by the gateway itself and removed by the worker. TLS is required when the database serves a certificate (it has public access); otherwise the forward is plain. Needs `admin`.",
				middleware: [requirePermission("admin", svc)],
				request: { params: Id, ...body(PortForwardInput) },
				responses: {
					201: json(DatabaseAccessView, "Port forward"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const actor = requireActor(c);
			const db = await databaseRow(c, id);
			if (!isExposable(db.spec.engine))
				throw new Failure(
					"bad_request",
					`${db.spec.engine} cannot be forwarded`,
				);
			const ip = clientIp(c);
			const allowedCidrs = input.allowedCidrs ?? (ip ? [ip] : []);
			if (!allowedCidrs.length)
				throw new Failure(
					"bad_request",
					"your address is unknown; name the addresses to allow",
				);
			const [pub] = await c.var.deps.db
				.select({ certNotAfter: databaseAccess.certNotAfter })
				.from(databaseAccess)
				.where(
					and(
						eq(databaseAccess.serviceId, id),
						eq(databaseAccess.kind, "public"),
					),
				);
			const port = await pickForwardPort(c, db.nodeId);
			const [row] = await c.var.deps.db
				.insert(databaseAccess)
				.values({
					organizationId: actor.organizationId,
					serviceId: id,
					kind: "forward",
					port,
					allowedCidrs,
					tlsRequired: !!pub?.certNotAfter,
					expiresAt: new Date(Date.now() + input.minutes * 60_000),
					createdBy: actor.userId,
				})
				.returning();
			if (!row) throw new Failure("internal", "forward not saved");
			c.set("auditResourceId", id);
			c.set("auditDiff", {
				accessId: row.id,
				port,
				allowedCidrs,
				minutes: input.minutes,
			});
			await converge(c);
			return c.json(
				await view(c, row, { id, engine: db.spec.engine, nodeId: db.nodeId }),
				201,
			);
		},
	)
	.openapi(
		mutation(
			"database.port_forward_delete",
			createRoute({
				method: "delete",
				path: "/databases/{id}/forwards/{accessId}",
				tags,
				security,
				summary: "Close a port forward before it expires",
				middleware: [requirePermission("admin", svc)],
				request: { params: AccessParams },
				responses: { 204: { description: "Closed" }, ...errors },
			}),
		),
		async (c) => {
			const { id, accessId } = c.req.valid("param");
			c.set("auditResourceId", id);
			const gone = await c.var.deps.db
				.delete(databaseAccess)
				.where(
					and(
						eq(databaseAccess.id, accessId),
						eq(databaseAccess.serviceId, id),
						eq(databaseAccess.kind, "forward"),
					),
				)
				.returning({ id: databaseAccess.id });
			if (!gone.length) throw notFound("port forward");
			await converge(c);
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/databases/{id}/upgrades",
			tags,
			security,
			summary: "Major-version upgrades of a database, newest first",
			middleware: [requirePermission("read", svc)],
			request: { params: Id },
			responses: {
				200: json(z.array(DatabaseUpgradeView), "Upgrades"),
				...errors,
			},
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const rows = await c.var.deps.db
				.select()
				.from(databaseUpgrade)
				.where(eq(databaseUpgrade.serviceId, id))
				.orderBy(desc(databaseUpgrade.createdAt))
				.limit(20);
			return c.json(rows.map(upgradeView), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/databases/{id}/upgrades/{upgradeId}",
			tags,
			security,
			summary: "One upgrade and the step it is on",
			middleware: [requirePermission("read", svc)],
			request: { params: UpgradeParams },
			responses: { 200: json(DatabaseUpgradeView, "Upgrade"), ...errors },
		}),
		async (c) => {
			const { id, upgradeId } = c.req.valid("param");
			const [row] = await c.var.deps.db
				.select()
				.from(databaseUpgrade)
				.where(
					and(
						eq(databaseUpgrade.id, upgradeId),
						eq(databaseUpgrade.serviceId, id),
					),
				);
			if (!row) throw notFound("upgrade");
			return c.json(upgradeView(row), 200);
		},
	)
	.openapi(
		mutation(
			"database.upgrade",
			createRoute({
				method: "post",
				path: "/databases/{id}/upgrades",
				tags,
				security,
				summary: "Upgrade a database to a new major version",
				description:
					"Copies every database into a new instance on `version` with its own volume, checks exact row counts per table, switches the service to it and checks again; a failure after the switch rolls back to the old version and volume, which are never written. Postgres, MySQL, MariaDB and MongoDB. Writes made during the copy are not carried over: stop writers first. Needs `admin`.",
				middleware: [requirePermission("admin", svc)],
				request: { params: Id, ...body(DatabaseUpgradeInput) },
				responses: {
					202: json(DatabaseUpgradeView, "Upgrade started"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { version } = c.req.valid("json");
			const actor = requireActor(c);
			const db = await databaseRow(c, id);
			const engine = db.spec.engine;
			if (!(UPGRADABLE_ENGINES as readonly string[]).includes(engine))
				throw new Failure(
					"bad_request",
					`${engine} upgrades go through a volume backup, not the assistant`,
				);
			if (!isLaterVersion(db.spec.version, version))
				throw new Failure(
					"bad_request",
					`${version} is not later than ${db.spec.version}`,
				);
			const [running] = await c.var.deps.db
				.select({ id: databaseUpgrade.id })
				.from(databaseUpgrade)
				.where(
					and(
						eq(databaseUpgrade.serviceId, id),
						eq(databaseUpgrade.status, "running"),
					),
				);
			if (running)
				throw new Failure(
					"conflict",
					"an upgrade of this database is running",
					{
						upgradeId: running.id,
					},
				);
			const [row] = await c.var.deps.db
				.insert(databaseUpgrade)
				.values({
					organizationId: actor.organizationId,
					serviceId: id,
					fromVersion: db.spec.version,
					toVersion: version,
					previousDataVolumeId: db.dataVolumeId,
					createdBy: actor.userId,
				})
				.returning();
			if (!row) throw new Failure("internal", "upgrade not saved");
			c.set("auditResourceId", id);
			c.set("auditDiff", {
				upgradeId: row.id,
				from: db.spec.version,
				to: version,
			});
			await runQueues(c.var.deps.config.REDIS_URL).dbops.add(
				"upgrade",
				{ upgradeId: row.id },
				{ jobId: row.id, removeOnComplete: true, removeOnFail: true },
			);
			return c.json(upgradeView(row), 202);
		},
	);
