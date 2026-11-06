import {
	CS2_MODES,
	GAMES,
	type GameKind,
	type GameSettings,
	type GameSettingsOf,
	type GameSpec,
	gamePorts,
} from "@logistack/contracts";

/** Service env vars (secret, service scope) a game server is created with; minted at creation. */
export const GAME_ENV = {
	/** RCON (Minecraft Java, CS2), ServerQuery `serveradmin` (TeamSpeak), SuperUser (Mumble). */
	admin: "GAME_ADMIN_PASSWORD",
	/** The join password of a private server (CS2, Mumble). */
	join: "GAME_JOIN_PASSWORD",
	/** CS2's Steam Game Server Login Token; the user pastes it, nothing mints it. */
	gslt: "GAME_STEAM_TOKEN",
} as const;

/**
 * The admin port LogiStack dials over ls-game (RCON, ServerQuery); never published. CS2 listens
 * for RCON on the TCP twin of its game port, which is the published one.
 */
export function gameAdminPort(spec: Pick<GameSpec, "settings" | "port">) {
	switch (spec.settings.game) {
		case "minecraft-java":
			return 25575;
		case "cs2":
			return spec.port;
		case "teamspeak3":
			return 10011;
		default:
			return undefined;
	}
}

type Env = Record<string, string>;

export type GameDef = {
	image: (s: GameSettings) => string;
	dataDir: string;
	/** Image env from the spec and the service env (secrets). */
	env: (spec: GameSpec, e: Env) => Env;
	/** `port` is the published primary port. */
	healthcheck: (port: number) => string[];
	/** Seconds the first start may take (downloads, world generation, SteamCMD). */
	startPeriod: number;
	/** Seconds after SIGTERM to save the world before the task is killed. */
	stopGrace: number;
};

const bool = (b: boolean) => (b ? "TRUE" : "FALSE");

/** A listening UDP socket in /proc/net/udp (state 07); any image with sh and grep has it. */
export function udpCheck(port: number): string[] {
	const hex = port.toString(16).toUpperCase().padStart(4, "0");
	return [
		"CMD-SHELL",
		`grep -sqE ':${hex} [0-9A-F]{8,32}:0000 07' /proc/net/udp /proc/net/udp6`,
	];
}

function tcpListen(port: number): string[] {
	const hex = port.toString(16).toUpperCase().padStart(4, "0");
	return [
		"CMD-SHELL",
		`grep -sqE ':${hex} [0-9A-F]{8,32}:0000 0A' /proc/net/tcp /proc/net/tcp6`,
	];
}

const IMAGES = {
	javaLatest:
		"itzg/minecraft-server:java25@sha256:4f855c470f6bea196971e6031311130b23d8976258ad5db7e024d568fbda79f1",
	java17:
		"itzg/minecraft-server:java17@sha256:632741e7e7fce0fa2730c428ffdd8f6fb346355d2568548d56b5a313020e1287",
	java8:
		"itzg/minecraft-server:java8@sha256:1bf0a9afde1fc4a0ffb54075339ec9d28dc6c9cb382e27bba72ebaaa764a7db0",
	bedrock:
		"itzg/minecraft-bedrock-server@sha256:8563b123e985fe664f2c3f2310105aac9ba8fb22882902c9051b8914114a0749",
	cs2: "joedwards32/cs2@sha256:b902f6f434204b0c8749a1dcc6e6242159a90fd71411f6e61431a1d687ca496d",
	teamspeak3:
		"teamspeak:3.13.7@sha256:4d3fa1c0db9a5a4ac69a2d07d6f0478539e464b15e7186c243a9f194bc1141fa",
	mumble:
		"mumblevoip/mumble-server:v1.5.915@sha256:018ad3515932e513d8fdc970df918373a2664c4da32b09a89a4aaee28eb7507a",
} as const;

/** 1.17 moved to Java 16+, 1.20.5 to Java 21; LATEST and newer run on the newest Java. */
export function minecraftJavaImage(version: string): string {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	if (version === "LATEST" || major > 1) return IMAGES.javaLatest;
	if (minor < 17) return IMAGES.java8;
	if (minor < 20 || (minor === 20 && patch < 5)) return IMAGES.java17;
	return IMAGES.javaLatest;
}

/** Three quarters of the container limit for the heap; the rest is metaspace, threads, native. */
export const minecraftHeapMb = (limitMb: number | undefined) =>
	Math.max(512, Math.floor((limitMb ?? 4096) * 0.75));

const as = <G extends GameKind>(s: GameSettings, g: G) => {
	if (s.game !== g) throw new Error(`settings are for ${s.game}, not ${g}`);
	return s as GameSettingsOf<G>;
};

export const gameDefs: Record<GameKind, GameDef> = {
	"minecraft-java": {
		image: (s) => minecraftJavaImage(as(s, "minecraft-java").version),
		dataDir: "/data",
		env: (spec, e) => {
			const s = as(spec.settings, "minecraft-java");
			return {
				MEMORY: `${minecraftHeapMb(spec.resources.memoryMb)}M`,
				EULA: bool(s.eula),
				TYPE: s.flavour.toUpperCase(),
				VERSION: s.version,
				MOTD: s.motd,
				MAX_PLAYERS: String(s.maxPlayers),
				DIFFICULTY: s.difficulty,
				MODE: s.gamemode,
				ONLINE_MODE: bool(s.onlineMode),
				ENABLE_WHITELIST: bool(s.whitelist),
				PVP: bool(s.pvp),
				...(s.seed ? { SEED: s.seed } : {}),
				ENABLE_RCON: "true",
				RCON_PORT: "25575",
				RCON_PASSWORD: e[GAME_ENV.admin] ?? "",
				// Without a TTY the image would otherwise wait for console input.
				CREATE_CONSOLE_IN_PIPE: "true",
				...(s.geyser && s.flavour === "paper"
					? { MODRINTH_PROJECTS: "geyser,floodgate" }
					: {}),
			};
		},
		healthcheck: () => ["CMD", "mc-health"],
		startPeriod: 600,
		stopGrace: 60,
	},
	"minecraft-bedrock": {
		image: () => IMAGES.bedrock,
		dataDir: "/data",
		env: (spec) => {
			const s = as(spec.settings, "minecraft-bedrock");
			return {
				EULA: bool(s.eula),
				VERSION: s.version,
				SERVER_NAME: s.serverName,
				MAX_PLAYERS: String(s.maxPlayers),
				DIFFICULTY: s.difficulty,
				GAMEMODE: s.gamemode,
				ALLOW_CHEATS: String(s.allowCheats),
				ALLOW_LIST: String(s.allowList),
				ONLINE_MODE: String(s.onlineMode),
				SERVER_PORT: "19132",
			};
		},
		healthcheck: () => udpCheck(19132),
		startPeriod: 300,
		stopGrace: 30,
	},
	cs2: {
		image: () => IMAGES.cs2,
		dataDir: "/home/steam/cs2-dedicated",
		env: (spec, e) => {
			const s = as(spec.settings, "cs2");
			const mode = CS2_MODES[s.mode];
			return {
				CS2_SERVERNAME: s.serverName,
				CS2_PORT: String(spec.port),
				CS2_MAXPLAYERS: String(s.maxPlayers),
				CS2_RCONPW: e[GAME_ENV.admin] ?? "",
				CS2_PW: s.private ? (e[GAME_ENV.join] ?? "") : "",
				SRCDS_TOKEN: e[GAME_ENV.gslt] ?? "",
				CS2_GAMETYPE: String(mode.type),
				CS2_GAMEMODE: String(mode.mode),
				CS2_MAPGROUP: mode.mapGroup,
				CS2_STARTMAP: s.map,
				CS2_ADDITIONAL_ARGS: s.workshopCollection
					? `+host_workshop_collection ${s.workshopCollection}`
					: "",
			};
		},
		// RCON's TCP listener opens once the map has loaded.
		healthcheck: (port) => tcpListen(port),
		// SteamCMD downloads ~60 GB on the first start.
		startPeriod: 3600,
		stopGrace: 15,
	},
	teamspeak3: {
		image: () => IMAGES.teamspeak3,
		dataDir: "/var/ts3server",
		env: (spec, e) => {
			as(spec.settings, "teamspeak3");
			return {
				TS3SERVER_LICENSE: "accept",
				TS3SERVER_SERVERADMIN_PASSWORD: e[GAME_ENV.admin] ?? "",
				TS3SERVER_QUERY_PROTOCOLS: "raw",
			};
		},
		healthcheck: () => udpCheck(9987),
		startPeriod: 60,
		stopGrace: 10,
	},
	mumble: {
		image: () => IMAGES.mumble,
		dataDir: "/data",
		env: (spec, e) => {
			const s = as(spec.settings, "mumble");
			return {
				MUMBLE_SUPERUSER_PASSWORD: e[GAME_ENV.admin] ?? "",
				MUMBLE_CONFIG_REGISTERNAME: s.serverName,
				MUMBLE_CONFIG_WELCOMETEXT: s.welcomeText,
				MUMBLE_CONFIG_USERS: String(s.maxUsers),
				...(s.private
					? { MUMBLE_CONFIG_SERVERPASSWORD: e[GAME_ENV.join] ?? "" }
					: {}),
			};
		},
		healthcheck: () => tcpListen(64738),
		startPeriod: 60,
		stopGrace: 10,
	},
};

/** Env keys a game service needs before it can deploy. */
export function gameRequiredEnv(s: GameSettings): string[] {
	return [
		...(s.game === "minecraft-bedrock" ? [] : [GAME_ENV.admin]),
		...("private" in s && s.private ? [GAME_ENV.join] : []),
		...(s.game === "cs2" ? [GAME_ENV.gslt] : []),
	];
}

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A password without lookalike characters, since players may type the join one. */
export function gamePassword(length = 20): string {
	const limit = 256 - (256 % ALNUM.length);
	let out = "";
	while (out.length < length)
		for (const b of crypto.getRandomValues(new Uint8Array(length * 2)))
			if (b < limit && out.length < length) out += ALNUM[b % ALNUM.length];
	return out;
}

/** Secrets a new game service is created with; the GSLT comes from the user. */
export function gameCredentials(s: GameSettings): Env {
	return Object.fromEntries(
		gameRequiredEnv(s)
			.filter((k) => k !== GAME_ENV.gslt)
			.map((k) => [k, gamePassword(k === GAME_ENV.join ? 10 : 24)]),
	);
}

/** The published ports of a game spec, as `PortMapping`s. */
export const gameSpecPorts = (spec: GameSpec) =>
	gamePorts(spec.settings, spec.port);

/** Swarm platforms a game image ships for; undefined lets any node run it. */
export const gamePlatforms = (game: GameKind) =>
	GAMES[game].amd64Only ? (["linux/amd64"] as const) : undefined;
