import { createRoute, z } from "@hono/zod-openapi";
import {
	HomeDns,
	HomeDnsBlocking,
	HomeDnsConsole,
	HomeDnsDomainInput,
	HomeDnsEnableInput,
	HomeDnsLogPage,
	HomeDnsLogQuery,
	HomeDnsRecord,
	HomeDnsRecordInput,
	type HomeDnsSettings,
	HomeDnsStats,
	HomeDnsStatsRange,
	HomeDnsTestInput,
	HomeDnsTestResult,
	HomeDnsUpdateInput,
	HomeDnsZone,
	HomeDnsZoneInput,
	parseHomeDnsRecordId,
	TECHNITIUM_PORT,
} from "@logistack/contracts";
import { decrypt, encrypt } from "@logistack/core";
import { homeNetwork, node } from "@logistack/db";
import { ProviderError, QUERY_LOG_APP, technitium } from "@logistack/providers";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { mutation } from "../audit.ts";
import type { Env } from "../env.ts";
import { Failure, notFound } from "../errors.ts";
import { log } from "../log.ts";
import { body, errors, json, router, security } from "../openapi.ts";
import { requestProxySync } from "../redis.ts";
import { requireInstanceAdmin } from "../scope.ts";

const tags = ["networking"];
// One Technitium per installation: no organization owns it, so every route is the instance's.
const middleware = [requireInstanceAdmin];

const sync = (c: Context<Env>, reason: string) =>
	requestProxySync(c.var.deps.config.REDIS_URL, reason).catch((err: unknown) =>
		log("warn", "proxy sync request failed", { error: String(err) }),
	);

async function load(c: Context<Env>) {
	const [row] = await c.var.deps.db.select().from(homeNetwork);
	return row?.desiredState === "removed" ? undefined : row;
}

async function nodeOf(c: Context<Env>, id: string) {
	const [n] = await c.var.deps.db.select().from(node).where(eq(node.id, id));
	if (!n) throw notFound("node");
	return n;
}

async function view(c: Context<Env>): Promise<HomeDns> {
	const row = await load(c);
	if (!row)
		return {
			enabled: false,
			nodeId: null,
			nodeHostname: null,
			lanAddress: null,
			desiredState: null,
			status: null,
			statusMessage: null,
			settings: null,
			version: null,
			updatedAt: null,
		};
	const [n] = await c.var.deps.db
		.select({ hostname: node.hostname })
		.from(node)
		.where(eq(node.id, row.nodeId));
	return {
		enabled: true,
		nodeId: row.nodeId,
		nodeHostname: n?.hostname ?? null,
		lanAddress: row.lanAddress,
		desiredState: row.desiredState,
		status: row.status,
		statusMessage: row.statusMessage,
		settings: row.settings,
		version: row.version,
		updatedAt: row.updatedAt.toISOString(),
	};
}

async function enabled(c: Context<Env>) {
	const row = await load(c);
	if (!row) throw new Failure("conflict", "home DNS is off; enable it first");
	c.set("auditResourceId", row.id);
	return row;
}

/** Technitium's API for pass-through routes; a typed 409 until the worker reports `ready`. */
async function api(c: Context<Env>) {
	const row = await enabled(c);
	if (row.status !== "ready" || !row.tokenEncrypted)
		throw new Failure(
			"conflict",
			`home DNS is not ready (status ${row.status}${row.statusMessage ? `: ${row.statusMessage}` : ""})`,
		);
	const n = await nodeOf(c, row.nodeId);
	const { deps } = c.var;
	return technitium(
		deps.homeDnsUrl ?? `http://${n.address}:${TECHNITIUM_PORT}`,
		await decrypt(deps.masterKey, row.tokenEncrypted),
	);
}

/** Technitium's refusals (an existing zone, a bad record) are the caller's to fix, not a 500. */
async function pass<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (e) {
		if (e instanceof ProviderError) throw new Failure("conflict", e.message);
		throw e;
	}
}

async function updateSettings(
	c: Context<Env>,
	row: { id: string; settings: HomeDnsSettings },
	settings: HomeDnsSettings,
) {
	await c.var.deps.db
		.update(homeNetwork)
		.set({ settings })
		.where(eq(homeNetwork.id, row.id));
	c.set("auditDiff", { before: row.settings, after: settings });
	await sync(c, "home dns settings changed");
}

const ZoneParam = z.object({ zone: z.string().min(1).max(253) });
const DomainParam = z.object({ domain: z.string().min(1).max(253) });
const RecordParam = ZoneParam.extend({ id: z.string().min(1).max(2000) });

function inZone(zone: string, name: string) {
	if (name !== zone && !name.endsWith(`.${zone}`))
		throw new Failure("validation_failed", `${name} is not inside ${zone}`);
}

function recordOf(id: string) {
	const key = parseHomeDnsRecordId(id);
	if (!key) throw notFound("record");
	return key;
}

/** Allowed and blocked domains share one shape. */
function domainList(kind: "allowed" | "blocked") {
	const [add, remove] =
		kind === "allowed"
			? (["home_dns.allow", "home_dns.disallow"] as const)
			: (["home_dns.block", "home_dns.unblock"] as const);
	const verb = kind === "allowed" ? "Allow" : "Block";
	return router()
		.openapi(
			createRoute({
				method: "get",
				path: `/network/dns/${kind}`,
				tags,
				security,
				summary: `Domains the home DNS always ${kind === "allowed" ? "answers, even when a block list has them" : "blocks"}`,
				middleware,
				responses: { 200: json(z.array(z.string()), "Domains"), ...errors },
			}),
			async (c) => {
				const t = await api(c);
				return c.json(
					await pass(kind === "allowed" ? t.allowed() : t.blocked()),
					200,
				);
			},
		)
		.openapi(
			mutation(
				add,
				createRoute({
					method: "post",
					path: `/network/dns/${kind}`,
					tags,
					security,
					summary: `${verb} a domain and its subdomains on the home DNS`,
					middleware,
					request: body(HomeDnsDomainInput),
					responses: { 204: { description: "Added" }, ...errors },
				}),
			),
			async (c) => {
				const { domain } = c.req.valid("json");
				const t = await api(c);
				await pass(kind === "allowed" ? t.allow(domain) : t.block(domain));
				return c.body(null, 204);
			},
		)
		.openapi(
			mutation(
				remove,
				createRoute({
					method: "delete",
					path: `/network/dns/${kind}/{domain}`,
					tags,
					security,
					summary: `Remove a domain from the ${kind} list`,
					middleware,
					request: { params: DomainParam },
					responses: { 204: { description: "Removed" }, ...errors },
				}),
			),
			async (c) => {
				const { domain } = c.req.valid("param");
				const t = await api(c);
				await pass(kind === "allowed" ? t.disallow(domain) : t.unblock(domain));
				return c.body(null, 204);
			},
		);
}

export const homeDns = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/network/dns",
			tags,
			security,
			summary: "Home DNS: whether it is on, where it runs and its status",
			middleware,
			responses: {
				200: json(HomeDns, "Home DNS"),
				...errors,
			},
		}),
		async (c) => c.json(await view(c), 200),
	)
	.openapi(
		mutation(
			"home_dns.enable",
			createRoute({
				method: "post",
				path: "/network/dns",
				tags,
				security,
				summary: "Turn on the home DNS (Technitium DNS Server) on a node",
				description:
					"The worker runs Technitium on the node's host network and configures it. Devices use `lanAddress` as their DNS server; port 53 on that node must be free (`install.sh --enable-dns` frees it from systemd-resolved).",
				middleware,
				request: body(HomeDnsEnableInput),
				responses: { 201: json(HomeDns, "Home DNS"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			await nodeOf(c, input.nodeId);
			const [existing] = await db.select().from(homeNetwork);
			if (existing)
				throw new Failure(
					"conflict",
					existing.desiredState === "removed"
						? "the previous home DNS is still being removed; try again in a minute"
						: "home DNS is already on",
				);
			const password = crypto
				.getRandomValues(new Uint8Array(24))
				.toBase64({ alphabet: "base64url", omitPadding: true });
			const [row] = await db
				.insert(homeNetwork)
				.values({
					nodeId: input.nodeId,
					lanAddress: input.lanAddress,
					settings: input.settings,
					adminPasswordEncrypted: await encrypt(masterKey, password),
				})
				.returning({ id: homeNetwork.id });
			c.set("auditResourceId", row?.id);
			await sync(c, "home dns enabled");
			return c.json(await view(c), 201);
		},
	)
	.openapi(
		mutation(
			"home_dns.update",
			createRoute({
				method: "patch",
				path: "/network/dns",
				tags,
				security,
				summary:
					"Change the home DNS settings, move it to another node, or stop and start it",
				description:
					"Moving to another node starts Technitium there with a fresh data volume: zones and records made by hand stay on the old node's volume.",
				middleware,
				request: body(HomeDnsUpdateInput),
				responses: { 200: json(HomeDns, "Home DNS"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const row = await enabled(c);
			if (input.nodeId) await nodeOf(c, input.nodeId);
			const settings = { ...row.settings, ...input.settings };
			await c.var.deps.db
				.update(homeNetwork)
				.set({
					...(input.nodeId ? { nodeId: input.nodeId } : {}),
					...(input.lanAddress ? { lanAddress: input.lanAddress } : {}),
					...(input.desiredState ? { desiredState: input.desiredState } : {}),
					settings,
				})
				.where(eq(homeNetwork.id, row.id));
			await sync(c, "home dns updated");
			return c.json(await view(c), 200);
		},
	)
	.openapi(
		mutation(
			"home_dns.disable",
			createRoute({
				method: "delete",
				path: "/network/dns",
				tags,
				security,
				summary: "Turn off the home DNS",
				description:
					"Removes the Technitium service and deletes its data volume (zones, records, lists, logs) for good. To keep the data, stop it instead (`desiredState: stopped`).",
				middleware,
				responses: { 204: { description: "Turned off" }, ...errors },
			}),
		),
		async (c) => {
			const row = await load(c);
			if (!row) throw notFound("home DNS");
			c.set("auditResourceId", row.id);
			const { db } = c.var.deps;
			// The row outlives the request until the worker has removed the service and the volume.
			await db
				.update(homeNetwork)
				.set({ desiredState: "removed" })
				.where(eq(homeNetwork.id, row.id));
			await sync(c, "home dns disabled");
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"home_dns.test",
			createRoute({
				method: "post",
				path: "/network/dns/test",
				tags,
				security,
				summary:
					"Resolve a name through the home DNS and say whether it was blocked",
				middleware,
				request: body(HomeDnsTestInput),
				responses: { 200: json(HomeDnsTestResult, "Answer"), ...errors },
			}),
		),
		async (c) =>
			c.json(await pass((await api(c)).resolve(c.req.valid("json").name)), 200),
	)
	.openapi(
		mutation(
			"home_dns.console",
			createRoute({
				method: "post",
				path: "/network/dns/console",
				tags,
				security,
				summary: "The Technitium console's address and admin password",
				description:
					"For what LogiStack does not manage itself (cluster, cache, advanced zone options). Every call is recorded in the audit log.",
				middleware,
				responses: { 200: json(HomeDnsConsole, "Console"), ...errors },
			}),
		),
		async (c) => {
			const row = await enabled(c);
			return c.json(
				{
					url: `http://${row.lanAddress}:${TECHNITIUM_PORT}/`,
					username: "admin",
					password: await decrypt(
						c.var.deps.masterKey,
						row.adminPasswordEncrypted,
					),
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/network/dns/stats",
			tags,
			security,
			summary:
				"Query counts, a chart and the top clients, domains and blocked domains",
			middleware,
			request: {
				query: z.object({ range: HomeDnsStatsRange.default("day") }),
			},
			responses: { 200: json(HomeDnsStats, "Stats"), ...errors },
		}),
		async (c) =>
			c.json(await pass((await api(c)).stats(c.req.valid("query").range)), 200),
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/network/dns/logs",
			tags,
			security,
			summary: "The query log, newest first",
			description:
				"Served by Technitium's Query Logs (Sqlite) extension, which the worker installs after the first start.",
			middleware,
			request: { query: HomeDnsLogQuery },
			responses: { 200: json(HomeDnsLogPage, "Log page"), ...errors },
		}),
		async (c) => {
			const t = await api(c);
			if (!(await pass(t.apps())).some((a) => a.name === QUERY_LOG_APP.name))
				throw new Failure(
					"conflict",
					"the query log extension is not installed yet; the worker is installing it",
				);
			return c.json(await pass(t.queryLogs(c.req.valid("query"))), 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/network/dns/blocking",
			tags,
			security,
			summary: "Whether blocking is on and the block lists in use",
			middleware,
			responses: { 200: json(HomeDnsBlocking, "Blocking"), ...errors },
		}),
		async (c) => c.json((await enabled(c)).settings.blocking, 200),
	)
	.openapi(
		mutation(
			"home_dns.blocking_update",
			createRoute({
				method: "put",
				path: "/network/dns/blocking",
				tags,
				security,
				summary: "Turn blocking on or off and set the block lists",
				middleware,
				request: body(HomeDnsBlocking),
				responses: { 200: json(HomeDnsBlocking, "Blocking"), ...errors },
			}),
		),
		async (c) => {
			const blocking = c.req.valid("json");
			const row = await enabled(c);
			await updateSettings(c, row, { ...row.settings, blocking });
			return c.json(blocking, 200);
		},
	)
	.openapi(
		mutation(
			"home_dns.blocklists_refresh",
			createRoute({
				method: "post",
				path: "/network/dns/blocking/refresh",
				tags,
				security,
				summary: "Download the block lists again now",
				middleware,
				responses: { 204: { description: "Refresh started" }, ...errors },
			}),
		),
		async (c) => {
			await pass((await api(c)).forceUpdateBlockLists());
			return c.body(null, 204);
		},
	)
	.route("/", domainList("allowed"))
	.route("/", domainList("blocked"))
	.openapi(
		createRoute({
			method: "get",
			path: "/network/dns/zones",
			tags,
			security,
			summary: "Zones the home DNS answers for",
			middleware,
			responses: { 200: json(z.array(HomeDnsZone), "Zones"), ...errors },
		}),
		async (c) => c.json(await pass((await api(c)).zones()), 200),
	)
	.openapi(
		mutation(
			"home_dns_zone.create",
			createRoute({
				method: "post",
				path: "/network/dns/zones",
				tags,
				security,
				summary: "Create a primary zone on the home DNS",
				middleware,
				request: body(HomeDnsZoneInput),
				responses: { 201: json(HomeDnsZone, "Zone"), ...errors },
			}),
		),
		async (c) => {
			const { name } = c.req.valid("json");
			const t = await api(c);
			await pass(t.createZone(name));
			return c.json({ name, type: "Primary", disabled: false }, 201);
		},
	)
	.openapi(
		mutation(
			"home_dns_zone.delete",
			createRoute({
				method: "delete",
				path: "/network/dns/zones/{zone}",
				tags,
				security,
				summary: "Delete a zone and every record in it",
				middleware,
				request: { params: ZoneParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { zone } = c.req.valid("param");
			const row = await enabled(c);
			if (row.settings.localZone === zone)
				throw new Failure(
					"conflict",
					`${zone} is the local zone in the home DNS settings; clear it there first`,
				);
			await pass((await api(c)).deleteZone(zone));
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/network/dns/zones/{zone}/records",
			tags,
			security,
			summary: "A zone's A, AAAA, CNAME, TXT, MX, SRV and PTR records",
			middleware,
			request: { params: ZoneParam },
			responses: { 200: json(z.array(HomeDnsRecord), "Records"), ...errors },
		}),
		async (c) =>
			c.json(
				await pass((await api(c)).records(c.req.valid("param").zone)),
				200,
			),
	)
	.openapi(
		mutation(
			"home_dns_record.create",
			createRoute({
				method: "post",
				path: "/network/dns/zones/{zone}/records",
				tags,
				security,
				summary: "Add a record to a zone",
				middleware,
				request: { params: ZoneParam, ...body(HomeDnsRecordInput) },
				responses: { 204: { description: "Added" }, ...errors },
			}),
		),
		async (c) => {
			const { zone } = c.req.valid("param");
			const record = c.req.valid("json");
			inZone(zone, record.name);
			await pass((await api(c)).addRecord(zone, record));
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"home_dns_record.update",
			createRoute({
				method: "put",
				path: "/network/dns/zones/{zone}/records/{id}",
				tags,
				security,
				summary: "Replace a record",
				description:
					"`id` comes from the record list; it changes with the record.",
				middleware,
				request: { params: RecordParam, ...body(HomeDnsRecordInput) },
				responses: { 204: { description: "Replaced" }, ...errors },
			}),
		),
		async (c) => {
			const { zone, id } = c.req.valid("param");
			const record = c.req.valid("json");
			inZone(zone, record.name);
			await pass((await api(c)).updateRecord(zone, recordOf(id), record));
			return c.body(null, 204);
		},
	)
	.openapi(
		mutation(
			"home_dns_record.delete",
			createRoute({
				method: "delete",
				path: "/network/dns/zones/{zone}/records/{id}",
				tags,
				security,
				summary: "Delete a record",
				middleware,
				request: { params: RecordParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { zone, id } = c.req.valid("param");
			await pass((await api(c)).deleteRecord(zone, recordOf(id)));
			return c.body(null, 204);
		},
	);
