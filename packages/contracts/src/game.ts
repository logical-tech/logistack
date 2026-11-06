import { z } from "zod";

/** Game and voice servers LogiStack deploys with their own wizard and panel. */
export const gameKinds = [
	"minecraft-java",
	"minecraft-bedrock",
	"cs2",
	"teamspeak3",
	"mumble",
] as const;
export const GameKind = z.enum(gameKinds);
export type GameKind = z.infer<typeof GameKind>;

/** A port the game listens on; `primary` is the one players type, the others shift with it. */
export type GamePort = {
	target: number;
	protocol: "tcp" | "udp";
	label: string;
	primary?: boolean;
};

/** An SRV record clients read to find host and port: `_<service>._<proto>.<name>`. */
export type GameSrv = { service: string; proto: "tcp" | "udp" };

export type GameInfo = {
	label: string;
	group: "game" | "voice";
	summary: string;
	ports: GamePort[];
	/** null: the client ignores SRV, so a hostname without a port only works on the default port. */
	srv: GameSrv | null;
	/** Players connect through this protocol; used in the address shown to players. */
	scheme?: string;
	/** The server listens on the published port itself, because it advertises it (Steam). */
	listenOnPublished?: boolean;
	/** The image only ships for x86_64. */
	amd64Only?: boolean;
	/** Disk the first start needs, in GB; the wizard warns below it. */
	diskGb: number;
	/** Memory to start from, in MB. */
	memoryMb: number;
};

export const GAMES: Record<GameKind, GameInfo> = {
	"minecraft-java": {
		label: "Minecraft: Java Edition",
		group: "game",
		summary: "Vanilla, Paper, Fabric, Forge or NeoForge, with RCON console.",
		ports: [{ target: 25565, protocol: "tcp", label: "Game", primary: true }],
		srv: { service: "minecraft", proto: "tcp" },
		diskGb: 2,
		memoryMb: 4096,
	},
	"minecraft-bedrock": {
		label: "Minecraft: Bedrock Edition",
		group: "game",
		summary: "For consoles, phones and Windows. Bedrock clients ignore SRV.",
		ports: [{ target: 19132, protocol: "udp", label: "Game", primary: true }],
		srv: null,
		diskGb: 1,
		memoryMb: 2048,
	},
	cs2: {
		label: "Counter-Strike 2",
		group: "game",
		summary: "Dedicated server through SteamCMD, with RCON and game modes.",
		// RCON's TCP port stays unpublished: LogiStack reaches it over ls-game.
		ports: [{ target: 27015, protocol: "udp", label: "Game", primary: true }],
		srv: null,
		amd64Only: true,
		listenOnPublished: true,
		diskGb: 60,
		memoryMb: 4096,
	},
	teamspeak3: {
		label: "TeamSpeak 3",
		group: "voice",
		summary: "Voice server with ServerQuery admin and file transfer.",
		ports: [
			{ target: 9987, protocol: "udp", label: "Voice", primary: true },
			{ target: 30033, protocol: "tcp", label: "File transfer" },
		],
		srv: { service: "ts3", proto: "udp" },
		scheme: "ts3server",
		amd64Only: true,
		diskGb: 1,
		memoryMb: 512,
	},
	mumble: {
		label: "Mumble",
		group: "voice",
		summary: "Open-source, low-latency voice chat with encrypted audio.",
		ports: [
			{ target: 64738, protocol: "tcp", label: "Control", primary: true },
			{ target: 64738, protocol: "udp", label: "Voice" },
		],
		srv: { service: "mumble", proto: "tcp" },
		scheme: "mumble",
		diskGb: 1,
		memoryMb: 256,
	},
};

export const primaryPort = (game: GameKind): number =>
	(GAMES[game].ports.find((p) => p.primary) ?? GAMES[game].ports[0])
		?.target as number;

/** Geyser's Bedrock listener inside a Paper container. */
export const GEYSER_PORT = 19132;

/**
 * The published ports of a game server whose primary port is published on `port`: every port
 * shifts by the same offset, so a second server on a node is the first one moved up by N.
 */
export function gamePorts(
	settings: { game: GameKind; geyser?: boolean },
	port: number,
) {
	const offset = port - primaryPort(settings.game);
	const ports = [
		...GAMES[settings.game].ports,
		...(settings.geyser
			? [
					{
						target: GEYSER_PORT,
						protocol: "udp" as const,
						label: "Bedrock (Geyser)",
					},
				]
			: []),
	];
	const same = GAMES[settings.game].listenOnPublished;
	return ports.map((p) => ({
		target: same ? p.target + offset : p.target,
		published: p.target + offset,
		protocol: p.protocol,
		mode: "host" as const,
	}));
}

const Motd = z.string().trim().max(120);
const Players = z.int().min(1).max(1000);

export const minecraftFlavours = [
	"vanilla",
	"paper",
	"fabric",
	"forge",
	"neoforge",
] as const;
export const MinecraftFlavour = z.enum(minecraftFlavours);
export type MinecraftFlavour = z.infer<typeof MinecraftFlavour>;

/** `LATEST`, or a release like `1.21.4`; snapshots are left out on purpose. */
const MinecraftVersion = z
	.string()
	.regex(/^(LATEST|\d+\.\d+(\.\d+)?)$/, "LATEST or a release like 1.21.4");

const Difficulty = z.enum(["peaceful", "easy", "normal", "hard"]);
const Gamemode = z.enum(["survival", "creative", "adventure", "spectator"]);

export const MinecraftJavaSettings = z.object({
	game: z.literal("minecraft-java"),
	/** The Minecraft EULA; never accepted on the user's behalf. */
	eula: z.literal(true),
	flavour: MinecraftFlavour,
	version: MinecraftVersion,
	motd: Motd,
	maxPlayers: Players,
	difficulty: Difficulty,
	gamemode: Gamemode,
	/** Off lets cracked clients in; only for LAN-like setups. */
	onlineMode: z.boolean(),
	whitelist: z.boolean(),
	pvp: z.boolean(),
	seed: z.string().max(64).optional(),
	/** Paper only: Geyser + Floodgate so Bedrock players join, on an extra UDP port. */
	geyser: z.boolean().optional(),
});

export const MinecraftBedrockSettings = z.object({
	game: z.literal("minecraft-bedrock"),
	eula: z.literal(true),
	version: z.string().regex(/^(LATEST|PREVIEW|\d+(\.\d+){1,3})$/),
	serverName: Motd,
	maxPlayers: Players,
	difficulty: Difficulty,
	gamemode: z.enum(["survival", "creative", "adventure"]),
	allowCheats: z.boolean(),
	allowList: z.boolean(),
	onlineMode: z.boolean(),
});

export const cs2Modes = [
	"competitive",
	"casual",
	"deathmatch",
	"wingman",
	"armsrace",
] as const;
export const Cs2Mode = z.enum(cs2Modes);
export type Cs2Mode = z.infer<typeof Cs2Mode>;

/** game_type / game_mode pairs Valve documents for each mode. */
export const CS2_MODES: Record<
	Cs2Mode,
	{ label: string; type: number; mode: number; mapGroup: string }
> = {
	competitive: {
		label: "Competitive",
		type: 0,
		mode: 1,
		mapGroup: "mg_active",
	},
	casual: { label: "Casual", type: 0, mode: 0, mapGroup: "mg_casual" },
	deathmatch: { label: "Deathmatch", type: 1, mode: 2, mapGroup: "mg_dm" },
	wingman: { label: "Wingman", type: 0, mode: 2, mapGroup: "mg_wingman" },
	armsrace: { label: "Arms Race", type: 1, mode: 0, mapGroup: "mg_armsrace" },
};

const CsMap = z.string().regex(/^[a-z0-9_]{2,64}$/, "a map like de_dust2");

export const Cs2Settings = z.object({
	game: z.literal("cs2"),
	serverName: Motd.min(1),
	maxPlayers: z.int().min(2).max(64),
	mode: Cs2Mode,
	map: CsMap,
	/** Steam Workshop collection hosted on the server; maps load from it. */
	workshopCollection: z
		.string()
		.regex(/^\d{1,20}$/)
		.optional(),
	/** Players need the server password (stored as a secret env var) to join. */
	private: z.boolean(),
});

export const Teamspeak3Settings = z.object({
	game: z.literal("teamspeak3"),
	/** TeamSpeak's server license; never accepted on the user's behalf. */
	license: z.literal(true),
});

export const MumbleSettings = z.object({
	game: z.literal("mumble"),
	serverName: Motd,
	welcomeText: z.string().max(500),
	maxUsers: Players,
	/** Players need the server password (stored as a secret env var) to join. */
	private: z.boolean(),
});

export const GameSettings = z.discriminatedUnion("game", [
	MinecraftJavaSettings,
	MinecraftBedrockSettings,
	Cs2Settings,
	Teamspeak3Settings,
	MumbleSettings,
]);
export type GameSettings = z.infer<typeof GameSettings>;
export type GameSettingsOf<G extends GameKind> = Extract<
	GameSettings,
	{ game: G }
>;

/** A game hostname: the A record players resolve, plus the SRV when the game reads one. */
export const GameHostname = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
		"a hostname like play.example.com",
	);

/** Live state a protocol probe reads from the server itself. */
export const GameStatus = z.object({
	online: z.boolean(),
	/** Why the probe failed, when `online` is false. */
	error: z.string().optional(),
	name: z.string().optional(),
	version: z.string().optional(),
	map: z.string().optional(),
	players: z.int().optional(),
	maxPlayers: z.int().optional(),
	/** Names when the protocol lists them (Minecraft sample, RCON `list`, ServerQuery). */
	playerNames: z.array(z.string()).optional(),
	latencyMs: z.number().optional(),
});
export type GameStatus = z.infer<typeof GameStatus>;

/** The records an endpoint wants; `value` in the presentation format of contracts/dns.ts. */
export type GameRecord = {
	name: string;
	type: "A" | "AAAA" | "SRV";
	value: string;
};

/**
 * Pure: the DNS records that make `hostname` reach a game server on `address:port`. The SRV
 * lives on `_<service>._<proto>.<hostname>` and points at the hostname's own A record.
 */
export function gameRecords(
	game: GameKind,
	hostname: string,
	address: string,
	port: number,
): GameRecord[] {
	const host = hostname.toLowerCase();
	const a: GameRecord = {
		name: host,
		type: address.includes(":") ? "AAAA" : "A",
		value: address,
	};
	const srv = GAMES[game].srv;
	return srv
		? [
				a,
				{
					name: `_${srv.service}._${srv.proto}.${host}`,
					type: "SRV",
					value: `0 5 ${port} ${host}`,
				},
			]
		: [a];
}

/** What players type: no port when SRV carries it or it is the default one. */
export function playerAddress(
	game: GameKind,
	host: string,
	port: number,
	viaSrv: boolean,
): string {
	const bare =
		(viaSrv && GAMES[game].srv !== null) || port === primaryPort(game);
	return bare ? host : `${host}:${port}`;
}
