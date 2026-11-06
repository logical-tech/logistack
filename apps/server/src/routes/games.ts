import { createRoute, z } from "@hono/zod-openapi";
import {
	GAMES,
	GameHostname,
	GameKind,
	GameSettings,
	GameStatus,
	gamePorts,
	playerAddress,
} from "@logistack/contracts";
import { GAME_ENV, ingressPortHolder, suggestGamePort } from "@logistack/core";
import { gameEndpoint } from "@logistack/db";
import {
	findZoneForHostname,
	rcon,
	teamspeakAdminKey,
} from "@logistack/providers";
import { and, asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import {
	managedZones,
	openProvider,
	providerRow,
	viaProvider,
} from "../dns.ts";
import type { Env } from "../env.ts";
import { Failure, notFound, one } from "../errors.ts";
import {
	adminDial,
	endpointRecords,
	nodeAddress,
	openGame,
	probeGame,
	recordTarget,
} from "../games.ts";
import { portHolders } from "../host-settings.ts";
import { log } from "../log.ts";
import { body, errors, IdParam, json, router, security } from "../openapi.ts";
import { byParam, inOrganization, requirePermission } from "../scope.ts";

const tags = ["games"];
const svc = byParam("service");

const Record = z.object({
	name: z.string(),
	type: z.enum(["A", "AAAA", "SRV"]),
	value: z.string(),
});

const Endpoint = z
	.object({
		id: z.string(),
		hostname: z.string(),
		dnsProviderId: z.string().nullable(),
		status: z.enum(["pending", "active", "error"]),
		statusMessage: z.string().nullable(),
		/** What the records should be now; set them by hand when there is no DNS provider. */
		records: z.array(Record),
		/** false when the node address or port moved since the records were written. */
		inSync: z.boolean(),
		/** What players type to join through this hostname. */
		playerAddress: z.string(),
	})
	.openapi("GameEndpoint");

const GameView = z
	.object({
		game: GameKind,
		settings: GameSettings,
		port: z.int(),
		ports: z.array(
			z.object({
				published: z.int(),
				protocol: z.enum(["tcp", "udp"]),
				label: z.string(),
			}),
		),
		node: z.object({ id: z.string(), hostname: z.string() }).nullable(),
		/** The node address players reach; null when it cannot be told. */
		address: z.string().nullable(),
		/** Address players type without a hostname: `address:port` unless the port is the default. */
		directAddress: z.string().nullable(),
		status: GameStatus,
		endpoints: z.array(Endpoint),
		/** RCON (Minecraft Java, CS2) runs commands from the panel. */
		console: z.boolean(),
	})
	.openapi("GameServer");

type EndpointRow = typeof gameEndpoint.$inferSelect;

function endpointView(
	row: EndpointRow,
	game: GameKind,
	address: string | null,
	port: number,
): z.infer<typeof Endpoint> {
	return {
		id: row.id,
		hostname: row.hostname,
		dnsProviderId: row.dnsProviderId,
		status: row.status,
		statusMessage: row.statusMessage,
		records: endpointRecords(game, row.hostname, address, port),
		inSync:
			!row.dnsProviderId ||
			(!!address && row.syncedTarget === recordTarget(address, port)),
		playerAddress: playerAddress(game, row.hostname, port, true),
	};
}

/**
 * Upserts the endpoint's records (DNS-only, always) and stores their ids; records a failure on the
 * row instead of throwing, so the endpoint stays and can be re-synced.
 */
async function syncRecords(
	c: Context<Env>,
	row: EndpointRow,
	game: GameKind,
	address: string | null,
	port: number,
): Promise<EndpointRow> {
	const { db, masterKey } = c.var.deps;
	const save = async (set: Partial<EndpointRow>) =>
		one(
			await db
				.update(gameEndpoint)
				.set(set)
				.where(eq(gameEndpoint.id, row.id))
				.returning(),
		);
	if (!row.dnsProviderId)
		return save({ status: "active", statusMessage: null });
	if (!address)
		return save({
			status: "error",
			statusMessage: "The node has no address to point records at.",
		});
	try {
		const p = await providerRow(
			db,
			requireActor(c).organizationId,
			row.dnsProviderId,
		);
		const zone = findZoneForHostname(row.hostname, managedZones(p));
		if (!zone)
			throw new Failure(
				"bad_request",
				`no zone of this DNS provider holds ${row.hostname}`,
			);
		const provider = await openProvider(masterKey, p);
		const ids: Partial<EndpointRow> = {};
		for (const r of endpointRecords(game, row.hostname, address, port)) {
			const saved = await viaProvider(() =>
				provider.upsertRecord({
					zoneId: zone.id,
					name: r.name,
					type: r.type,
					content: r.value,
					ttl: 300,
					// Cloudflare's proxy only carries HTTP: game traffic must reach the node itself.
					proxied: false,
				}),
			);
			if (r.type === "SRV") ids.srvRecordId = saved.id;
			else ids.addressRecordId = saved.id;
		}
		return save({
			...ids,
			syncedTarget: recordTarget(address, port),
			status: "active",
			statusMessage: null,
		});
	} catch (e) {
		return save({
			status: "error",
			statusMessage: e instanceof Error ? e.message : String(e),
		});
	}
}

/** Best effort: the records LogiStack created go away with the endpoint. */
async function deleteRecords(c: Context<Env>, row: EndpointRow) {
	if (!row.dnsProviderId) return;
	const { db, masterKey } = c.var.deps;
	try {
		const p = await providerRow(
			db,
			requireActor(c).organizationId,
			row.dnsProviderId,
		);
		const zone = findZoneForHostname(row.hostname, managedZones(p));
		if (!zone) return;
		const provider = await openProvider(masterKey, p);
		for (const id of [row.srvRecordId, row.addressRecordId])
			if (id) await provider.deleteRecord(zone.id, id);
	} catch (err) {
		log("warn", "game dns record cleanup failed", {
			endpointId: row.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function endpointWithService(c: Context<Env>, id: string) {
	const [row] = await c.var.deps.db
		.select()
		.from(gameEndpoint)
		.where(eq(gameEndpoint.id, id));
	if (!row) throw notFound("game endpoint");
	return row;
}

let versions: { at: number; list: Promise<string[]> } | undefined;

/** Minecraft Java releases, newest first, from Mojang's manifest; cached for an hour. */
function minecraftVersions(): Promise<string[]> {
	if (versions && Date.now() - versions.at < 3_600_000) return versions.list;
	const list = fetch(
		"https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
		{ signal: AbortSignal.timeout(5000) },
	)
		.then((r) => {
			if (!r.ok) throw new Error(`Mojang answered ${r.status}`);
			return r.json() as Promise<{ versions: { id: string; type: string }[] }>;
		})
		.then((m) =>
			m.versions
				.filter((v) => v.type === "release")
				.map((v) => v.id)
				.slice(0, 60),
		);
	versions = { at: Date.now(), list };
	list.catch(() => {
		versions = undefined;
	});
	return list;
}

export const games = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/game",
			tags,
			security,
			summary: "A game server's live status, addresses and DNS endpoints",
			description:
				"Status comes from the game's own protocol (Server List Ping, RakNet, A2S, Mumble ping, ServerQuery) over ls-game.",
			middleware: [requirePermission("read", svc)],
			request: { params: IdParam },
			responses: { 200: json(GameView, "Game server"), ...errors },
		}),
		async (c) => {
			const g = await openGame(c, c.req.valid("param").id);
			const { game } = g.spec.settings;
			const [n, status, rows] = await Promise.all([
				nodeAddress(c, g.nodeId),
				probeGame(g),
				c.var.deps.db
					.select()
					.from(gameEndpoint)
					.where(eq(gameEndpoint.serviceId, g.id))
					.orderBy(asc(gameEndpoint.hostname)),
			]);
			const address = n?.address ?? null;
			const labels = [
				...GAMES[game].ports.map((p) => p.label),
				"Bedrock (Geyser)",
			];
			return c.json(
				{
					game,
					settings: g.spec.settings,
					port: g.spec.port,
					ports: gamePorts(g.spec.settings, g.spec.port).map((p, i) => ({
						published: p.published,
						protocol: p.protocol,
						label: labels[i] ?? "",
					})),
					node: n?.id ? { id: n.id, hostname: n.hostname } : null,
					address,
					directAddress: address
						? playerAddress(game, address, g.spec.port, false)
						: null,
					status,
					endpoints: rows.map((r) =>
						endpointView(r, game, address, g.spec.port),
					),
					console: game === "minecraft-java" || game === "cs2",
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"game.command",
			createRoute({
				method: "post",
				path: "/services/{id}/game/command",
				tags,
				security,
				summary: "Run a console command over RCON (Minecraft Java, CS2)",
				description:
					"The command text is audited; the RCON password never leaves the server.",
				middleware: [requirePermission("exec", svc)],
				request: {
					params: IdParam,
					...body(
						z.object({
							command: z
								.string()
								.trim()
								.min(1)
								.max(1000)
								.refine((s) => !/[\r\n\0]/.test(s), "one line"),
						}),
					),
				},
				responses: {
					200: json(z.object({ output: z.string() }), "Output"),
					...errors,
				},
			}),
		),
		async (c) => {
			const g = await openGame(c, c.req.valid("param").id);
			const { game } = g.spec.settings;
			if (game !== "minecraft-java" && game !== "cs2")
				throw new Failure(
					"bad_request",
					`${GAMES[game].label} has no RCON console`,
				);
			const { host, port, password } = adminDial(g);
			const command = c.req.valid("json").command.replace(/^\//, "");
			try {
				const [output = ""] = await rcon(host, port, password, [command]);
				return c.json({ output }, 200);
			} catch (e) {
				throw new Failure(
					"unprocessable",
					`RCON: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	)
	.openapi(
		mutation(
			"game.admin_key",
			createRoute({
				method: "post",
				path: "/services/{id}/game/admin-key",
				tags,
				security,
				summary: "Create a TeamSpeak Server Admin privilege key",
				description:
					"Through ServerQuery as serveradmin. The key is shown once; using it in the client grants Server Admin.",
				middleware: [requirePermission("write", svc)],
				request: { params: IdParam },
				responses: {
					201: json(z.object({ key: z.string() }), "Created"),
					...errors,
				},
			}),
		),
		async (c) => {
			const g = await openGame(c, c.req.valid("param").id);
			if (g.spec.settings.game !== "teamspeak3")
				throw new Failure("bad_request", "only TeamSpeak has privilege keys");
			const { host, port, password } = adminDial(g);
			try {
				return c.json(
					{ key: await teamspeakAdminKey(host, port, password) },
					201,
				);
			} catch (e) {
				throw new Failure(
					"unprocessable",
					`ServerQuery: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/game/credentials",
			tags,
			security,
			summary: "The game server's admin and join passwords",
			middleware: [requirePermission("read:secrets", svc)],
			request: { params: IdParam },
			responses: {
				200: json(
					z.object({
						/** RCON, ServerQuery `serveradmin` or Mumble SuperUser. */
						admin: z.string().nullable(),
						/** What players type to join a private server. */
						join: z.string().nullable(),
					}),
					"Credentials",
				),
				...errors,
			},
		}),
		async (c) => {
			const g = await openGame(c, c.req.valid("param").id);
			return c.json(
				{
					admin: g.env[GAME_ENV.admin] ?? null,
					join: g.env[GAME_ENV.join] ?? null,
				},
				200,
			);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/games/port",
			tags,
			security,
			summary: "The first free primary port for a new game server on a node",
			middleware: [requirePermission("read", inOrganization)],
			request: {
				query: z.object({
					game: GameKind,
					nodeId: z.string().optional(),
					geyser: z.enum(["true", "false"]).optional(),
				}),
			},
			responses: {
				200: json(z.object({ port: z.int().nullable() }), "Port"),
				...errors,
			},
		}),
		async (c) => {
			const q = c.req.valid("query");
			const port = suggestGamePort(
				{ game: q.game, geyser: q.geyser === "true" },
				q.nodeId ?? null,
				[...(await portHolders(c)), ingressPortHolder],
			);
			return c.json({ port }, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/games/minecraft/versions",
			tags,
			security,
			summary: "Minecraft Java releases, newest first",
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.object({ versions: z.array(z.string()) }), "Versions"),
				...errors,
			},
		}),
		async (c) => {
			try {
				return c.json({ versions: await minecraftVersions() }, 200);
			} catch (e) {
				throw new Failure(
					"unprocessable",
					`could not read Mojang's version list: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	)
	.openapi(
		mutation(
			"game_endpoint.create",
			createRoute({
				method: "post",
				path: "/services/{id}/game/endpoints",
				tags,
				security,
				summary: "Give a game server a hostname",
				description:
					"With a DNS provider, LogiStack writes the A/AAAA record (DNS-only) and, for games that read one, the SRV that carries the port. Without one, the response lists the records to create by hand.",
				middleware: [requirePermission("write", svc)],
				request: {
					params: IdParam,
					...body(
						z.object({
							hostname: GameHostname,
							dnsProviderId: z.string().nullable(),
						}),
					),
				},
				responses: { 201: json(Endpoint, "Created"), ...errors },
			}),
		),
		async (c) => {
			const g = await openGame(c, c.req.valid("param").id);
			const input = c.req.valid("json");
			const { db } = c.var.deps;
			if (input.dnsProviderId)
				await providerRow(
					db,
					requireActor(c).organizationId,
					input.dnsProviderId,
				);
			const [taken] = await db
				.select({ id: gameEndpoint.id })
				.from(gameEndpoint)
				.where(eq(gameEndpoint.hostname, input.hostname));
			if (taken)
				throw new Failure(
					"conflict",
					`${input.hostname} already points at a game server`,
				);
			const row = one(
				await db
					.insert(gameEndpoint)
					.values({
						serviceId: g.id,
						hostname: input.hostname,
						dnsProviderId: input.dnsProviderId,
					})
					.returning(),
			);
			const address = (await nodeAddress(c, g.nodeId))?.address ?? null;
			const synced = await syncRecords(
				c,
				row,
				g.spec.settings.game,
				address,
				g.spec.port,
			);
			c.set("auditResourceId", row.id);
			return c.json(
				endpointView(synced, g.spec.settings.game, address, g.spec.port),
				201,
			);
		},
	)
	.openapi(
		mutation(
			"game_endpoint.sync",
			createRoute({
				method: "post",
				path: "/game-endpoints/{id}/sync",
				tags,
				security,
				summary:
					"Rewrite a game hostname's records to the current node and port",
				middleware: [requirePermission("write", byParam("gameEndpoint"))],
				request: { params: IdParam },
				responses: { 200: json(Endpoint, "Synced"), ...errors },
			}),
		),
		async (c) => {
			const row = await endpointWithService(c, c.req.valid("param").id);
			const g = await openGame(c, row.serviceId);
			const address = (await nodeAddress(c, g.nodeId))?.address ?? null;
			const synced = await syncRecords(
				c,
				row,
				g.spec.settings.game,
				address,
				g.spec.port,
			);
			return c.json(
				endpointView(synced, g.spec.settings.game, address, g.spec.port),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"game_endpoint.delete",
			createRoute({
				method: "delete",
				path: "/game-endpoints/{id}",
				tags,
				security,
				summary:
					"Remove a game hostname and the records LogiStack wrote for it",
				middleware: [requirePermission("write", byParam("gameEndpoint"))],
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const row = await endpointWithService(c, c.req.valid("param").id);
			await deleteRecords(c, row);
			await c.var.deps.db
				.delete(gameEndpoint)
				.where(
					and(
						eq(gameEndpoint.id, row.id),
						eq(gameEndpoint.serviceId, row.serviceId),
					),
				);
			return c.body(null, 204);
		},
	);
