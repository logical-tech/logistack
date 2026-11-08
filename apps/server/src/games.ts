import {
	GAMES,
	type GameKind,
	type GameRecord,
	type GameSpec,
	type GameStatus,
	gamePorts,
	gameRecords,
} from "@logistack/contracts";
import { dockerName, GAME_ENV, gameAdminPort } from "@logistack/core";
import { node, service } from "@logistack/db";
import {
	a2sInfo,
	minecraftBedrockStatus,
	minecraftJavaStatus,
	mumbleStatus,
	teamspeakStatus,
} from "@logistack/providers";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Deps, Env } from "./env.ts";
import { Failure, notFound } from "./errors.ts";
import { publicIp } from "./probe.ts";
import { serviceEnvValues } from "./secret-refs.ts";
import { isPrivateAddress } from "./ssrf.ts";

/**
 * Where the api dials a game server's container port: its Swarm service name, which resolves on
 * `ls-game` (the api joins it in the stack, game servers join it when they deploy). Tests override it.
 */
export const defaultGameEndpoint = (serviceId: string, port: number) => ({
	host: dockerName("svc", serviceId),
	port,
});

export type GameService = {
	id: string;
	desiredState: string;
	spec: GameSpec;
	nodeId: string | null;
	env: Record<string, string>;
	dial: (port: number) => { host: string; port: number };
};

/** The game service behind `serviceId`, with its secrets decrypted. */
export async function openGame(
	c: Context<Env>,
	serviceId: string,
): Promise<GameService> {
	const deps = c.var.deps;
	const [row] = await deps.db
		.select({
			id: service.id,
			spec: service.spec,
			nodeId: service.nodeId,
			desiredState: service.desiredState,
		})
		.from(service)
		.where(eq(service.id, serviceId));
	if (!row) throw notFound("service");
	if (row.spec.kind !== "game")
		throw new Failure("bad_request", "not a game server");
	return {
		...row,
		spec: row.spec,
		env: await gameEnv(deps, serviceId),
		dial: (port) => (deps.gameEndpoint ?? defaultGameEndpoint)(serviceId, port),
	};
}

async function gameEnv(deps: Deps, serviceId: string) {
	return serviceEnvValues(deps, serviceId, Object.values(GAME_ENV));
}

/** The container port the status probe dials: the game port, or ServerQuery for TeamSpeak. */
function probePort(spec: GameSpec): number {
	const primary = gamePorts(spec.settings, spec.port)[0];
	if (spec.settings.game === "teamspeak3") return 10011;
	return primary?.target ?? spec.port;
}

/** Live status straight from the game's own protocol; never throws. */
export async function probeGame(g: GameService): Promise<GameStatus> {
	if (g.desiredState === "stopped") return { online: false, error: "stopped" };
	try {
		const { host, port } = g.dial(probePort(g.spec));
		switch (g.spec.settings.game) {
			case "minecraft-java":
				return await minecraftJavaStatus(host, port);
			case "minecraft-bedrock":
				return await minecraftBedrockStatus(host, port);
			case "cs2":
				return await a2sInfo(host, port);
			case "teamspeak3":
				return await teamspeakStatus(host, port, g.env[GAME_ENV.admin] ?? "");
			case "mumble":
				return await mumbleStatus(host, port);
		}
	} catch (e) {
		return {
			online: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/** Where RCON / ServerQuery listen, or a 400 for games without one. */
export function adminDial(g: GameService) {
	const port = gameAdminPort(g.spec);
	if (!port)
		throw new Failure(
			"bad_request",
			`${GAMES[g.spec.settings.game].label} has no admin console`,
		);
	const password = g.env[GAME_ENV.admin];
	if (!password)
		throw new Failure(
			"conflict",
			`the admin password (${GAME_ENV.admin}) is missing from the service env`,
		);
	return { ...g.dial(port), password };
}

/**
 * The address players reach the node on: its public override, else its Swarm address unless that
 * is private, else the instance's public IP.
 */
export async function nodeAddress(
	c: Context<Env>,
	nodeId: string | null,
): Promise<{
	id: string;
	hostname: string;
	address: string | null;
} | null> {
	const [n] = nodeId
		? await c.var.deps.db
				.select({
					id: node.id,
					hostname: node.hostname,
					address: node.address,
					publicAddress: node.publicAddress,
				})
				.from(node)
				.where(eq(node.id, nodeId))
		: [];
	const fallback = await publicIp(c.var.deps.config);
	if (!n) return fallback ? { id: "", hostname: "", address: fallback } : null;
	return {
		id: n.id,
		hostname: n.hostname,
		address:
			n.publicAddress ??
			(isPrivateAddress(n.address) ? (fallback ?? n.address) : n.address),
	};
}

/** `<address> <port>`: what an endpoint's records point at; a change means a re-sync. */
export const recordTarget = (address: string, port: number) =>
	`${address} ${port}`;

export const endpointRecords = (
	game: GameKind,
	hostname: string,
	address: string | null,
	port: number,
): GameRecord[] => (address ? gameRecords(game, hostname, address, port) : []);
