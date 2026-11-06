import {
	GAMES,
	type GameKind,
	type GameSpec,
	gamePorts,
	gameRecords,
	playerAddress,
	primaryPort,
} from "@logistack/contracts";
import { ApiError } from "../adapter";
import type { GameEndpoint, GameServer, GamesApi } from "../games";
import { mockDb as db } from ".";

const delay = <T>(value: T, ms = 160 + Math.random() * 260): Promise<T> =>
	new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const PLAYERS = ["alex", "steve_42", "Noor", "kiki", "Matteo", "zed"];
const endpoints = new Map<string, (GameEndpoint & { serviceId: string })[]>();
const ADDRESS = "203.0.113.7";

function spec(id: string): GameSpec {
	const s = db.services.find((x) => x.id === id);
	if (!s) throw new ApiError(404, "Service not found");
	if (s.spec.kind !== "game") throw new ApiError(400, "not a game server");
	return s.spec;
}

const view = (id: string): GameServer => {
	const sp = spec(id);
	const { game } = sp.settings;
	const running =
		db.services.find((x) => x.id === id)?.status.observed === "running";
	const max =
		"maxPlayers" in sp.settings
			? sp.settings.maxPlayers
			: "maxUsers" in sp.settings
				? sp.settings.maxUsers
				: 32;
	const online = running ? Math.min(max, 1 + (id.length % 5)) : 0;
	const labels = [...GAMES[game].ports.map((p) => p.label), "Bedrock (Geyser)"];
	return {
		game,
		settings: sp.settings,
		port: sp.port,
		ports: gamePorts(sp.settings, sp.port).map((p, i) => ({
			published: p.published,
			protocol: p.protocol,
			label: labels[i] ?? "",
		})),
		node: { id: "nod_mock", hostname: "fra-1" },
		address: ADDRESS,
		directAddress: playerAddress(game, ADDRESS, sp.port, false),
		status: running
			? {
					online: true,
					name:
						"motd" in sp.settings
							? sp.settings.motd
							: "serverName" in sp.settings
								? sp.settings.serverName
								: "TeamSpeak ]I[ Server",
					version:
						game === "minecraft-java"
							? "Paper 1.21.4"
							: game === "cs2"
								? "1.40.4.5"
								: game === "mumble"
									? "1.5.915"
									: game === "teamspeak3"
										? "3.13.7"
										: "1.21.40",
					...(game === "cs2" ? { map: "de_dust2" } : {}),
					players: online,
					maxPlayers: max,
					playerNames: PLAYERS.slice(0, online),
					latencyMs: 2,
				}
			: { online: false, error: "stopped" },
		endpoints: (endpoints.get(id) ?? []).map(({ serviceId: _, ...e }) => e),
		console: game === "minecraft-java" || game === "cs2",
	};
};

const MC_REPLIES: Record<string, (args: string) => string> = {
	list: () => "There are 3 of a max of 20 players online: alex, steve_42, Noor",
	say: () => "",
	"whitelist add": (a) => `Added ${a} to the whitelist`,
	op: (a) => `Made ${a} a server operator`,
	time: (a) => `Set the time to ${a.split(" ")[1] ?? "1000"}`,
};

export const mockGames: GamesApi = {
	get: (id) => delay(view(id), 120),
	credentials: (id) => {
		const s = spec(id).settings;
		return delay({
			admin: s.game === "minecraft-bedrock" ? null : "hV4mQp2zKcR8sW3yTnB7xLdE",
			join: "private" in s && s.private ? "Kq7mR2xP9a" : null,
		});
	},
	command: (id, command) => {
		spec(id);
		const c = command.replace(/^\//, "");
		const verb = Object.keys(MC_REPLIES)
			.sort((a, b) => b.length - a.length)
			.find((k) => c === k || c.startsWith(`${k} `));
		return delay({
			output: verb
				? (MC_REPLIES[verb]?.(c.slice(verb.length).trim()) ?? "")
				: `Unknown or incomplete command, see below for error\n${c}<--[HERE]`,
		});
	},
	adminKey: () => delay({ key: "kQ9p+Y7o2mXk3nV5wQ1rT8sZ4eHd6bJcA0LfGu" }, 500),
	suggestPort: (game: GameKind) =>
		delay({
			port:
				primaryPort(game) +
				db.services.filter(
					(s) => s.spec.kind === "game" && s.spec.settings.game === game,
				).length,
		}),
	minecraftVersions: () =>
		delay({
			versions: [
				"1.21.10",
				"1.21.9",
				"1.21.8",
				"1.21.4",
				"1.20.6",
				"1.20.4",
				"1.19.4",
				"1.18.2",
				"1.16.5",
				"1.12.2",
			],
		}),
	endpoints: {
		create: (id, input) => {
			const sp = spec(id);
			if (
				[...endpoints.values()]
					.flat()
					.some((e) => e.hostname === input.hostname)
			)
				return Promise.reject(
					new ApiError(
						409,
						`${input.hostname} already points at a game server`,
					),
				);
			const row = {
				serviceId: id,
				id: rid("gep"),
				hostname: input.hostname.toLowerCase(),
				dnsProviderId: input.dnsProviderId,
				status: "active" as const,
				statusMessage: null,
				records: gameRecords(
					sp.settings.game,
					input.hostname,
					ADDRESS,
					sp.port,
				),
				inSync: true,
				playerAddress: playerAddress(
					sp.settings.game,
					input.hostname,
					sp.port,
					true,
				),
			};
			endpoints.set(id, [...(endpoints.get(id) ?? []), row]);
			const { serviceId: _, ...out } = row;
			return delay(out, 600);
		},
		sync: (endpointId) => {
			const row = [...endpoints.values()]
				.flat()
				.find((e) => e.id === endpointId);
			if (!row)
				return Promise.reject(new ApiError(404, "Game endpoint not found"));
			const { serviceId: _, ...out } = row;
			return delay(out, 500);
		},
		remove: (endpointId) => {
			for (const [k, list] of endpoints)
				endpoints.set(
					k,
					list.filter((e) => e.id !== endpointId),
				);
			return delay(undefined);
		},
	},
};
