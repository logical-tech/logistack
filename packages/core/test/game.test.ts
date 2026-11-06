import { describe, expect, test } from "bun:test";
import {
	type GameKind,
	type GameSettings,
	type GameSpec,
	gamePorts,
	gameRecords,
	playerAddress,
} from "@logistack/contracts";
import {
	type CompileServiceInput,
	compileService,
	dataDirOf,
} from "../src/compile-service.ts";
import {
	GAME_ENV,
	gameAdminPort,
	gameCredentials,
	gameRequiredEnv,
	minecraftHeapMb,
	minecraftJavaImage,
} from "../src/game.ts";

const settings: Record<GameKind, GameSettings> = {
	"minecraft-java": {
		game: "minecraft-java",
		eula: true,
		flavour: "paper",
		version: "1.21.4",
		motd: "Hello",
		maxPlayers: 20,
		difficulty: "normal",
		gamemode: "survival",
		onlineMode: true,
		whitelist: true,
		pvp: true,
		geyser: true,
	},
	"minecraft-bedrock": {
		game: "minecraft-bedrock",
		eula: true,
		version: "LATEST",
		serverName: "Bedrock",
		maxPlayers: 10,
		difficulty: "easy",
		gamemode: "survival",
		allowCheats: false,
		allowList: false,
		onlineMode: true,
	},
	cs2: {
		game: "cs2",
		serverName: "Frag",
		maxPlayers: 10,
		mode: "competitive",
		map: "de_dust2",
		workshopCollection: "123",
		private: true,
	},
	teamspeak3: { game: "teamspeak3", license: true },
	mumble: {
		game: "mumble",
		serverName: "Voice",
		welcomeText: "Hi",
		maxUsers: 50,
		private: false,
	},
};

const ports: Record<GameKind, number> = {
	"minecraft-java": 25566,
	"minecraft-bedrock": 19132,
	cs2: 27016,
	teamspeak3: 9987,
	mumble: 64738,
};

const env = (s: GameSettings) => ({
	...Object.fromEntries(gameRequiredEnv(s).map((k) => [k, `${k}-value`])),
});

const gameInput = (game: GameKind): CompileServiceInput => ({
	service: {
		id: "svc_game000000000000000000000",
		organizationId: "org_acme",
		environmentId: "env_prod00000000000000000000",
		slug: "game",
		desiredState: "running",
		spec: {
			kind: "game",
			settings: settings[game],
			port: ports[game],
			resources: { memoryMb: 4096 },
		} satisfies GameSpec,
	},
	deploymentId: "dep_one0000000000000000000000",
	env: env(settings[game]),
	context: {
		project: "Fun",
		environment: "prod",
		service: "Game",
		domains: [],
	},
	mounts: [],
	domains: [],
	networks: {
		environment: "net-env-id",
		ingress: "net-ingress-id",
		game: "net-game-id",
	},
	pinNodeId: "node-abc",
	fileIds: {},
});

describe("compileService for game servers", () => {
	for (const game of Object.keys(settings) as GameKind[])
		test(game, () => {
			expect(compileService(gameInput(game))).toMatchSnapshot();
		});

	test("pins to its node, publishes host ports, joins ls-game but not ingress", () => {
		const spec = compileService(gameInput("teamspeak3"));
		expect(spec.TaskTemplate.Placement?.Constraints).toContain(
			"node.id==node-abc",
		);
		expect(spec.TaskTemplate.Placement?.Platforms).toEqual([
			{ OS: "linux", Architecture: "amd64" },
		]);
		expect(spec.EndpointSpec?.Ports).toEqual([
			{
				Protocol: "udp",
				TargetPort: 9987,
				PublishedPort: 9987,
				PublishMode: "host",
			},
			{
				Protocol: "tcp",
				TargetPort: 30033,
				PublishedPort: 30033,
				PublishMode: "host",
			},
		]);
		expect(spec.TaskTemplate.Networks?.map((n) => n.Target)).toEqual([
			"net-env-id",
			"net-game-id",
		]);
		expect(spec.UpdateConfig?.Order).toBe("stop-first");
	});

	test("refuses to deploy without its minted secrets", () => {
		expect(() => compileService({ ...gameInput("cs2"), env: {} })).toThrow(
			/GAME_ADMIN_PASSWORD, GAME_JOIN_PASSWORD, GAME_STEAM_TOKEN/,
		);
	});

	test("the data dir is the game's", () => {
		expect(dataDirOf(gameInput("cs2").service.spec)).toBe(
			"/home/steam/cs2-dedicated",
		);
	});
});

describe("game ports", () => {
	test("a second server shifts every port by the same offset", () => {
		expect(gamePorts({ game: "teamspeak3" }, 9990)).toEqual([
			{ target: 9987, published: 9990, protocol: "udp", mode: "host" },
			{ target: 30033, published: 30036, protocol: "tcp", mode: "host" },
		]);
	});
	test("CS2 listens on the published port itself", () => {
		expect(gamePorts({ game: "cs2" }, 27016)).toEqual([
			{ target: 27016, published: 27016, protocol: "udp", mode: "host" },
		]);
		expect(gameAdminPort({ settings: settings.cs2, port: 27016 })).toBe(27016);
	});
	test("Geyser adds Bedrock's UDP port", () => {
		expect(gamePorts({ game: "minecraft-java", geyser: true }, 25565)).toEqual([
			{ target: 25565, published: 25565, protocol: "tcp", mode: "host" },
			{ target: 19132, published: 19132, protocol: "udp", mode: "host" },
		]);
	});
});

describe("game DNS records", () => {
	test("SRV games get an A and the SRV on the hostname", () => {
		expect(
			gameRecords("minecraft-java", "Play.Example.com", "203.0.113.7", 25570),
		).toEqual([
			{ name: "play.example.com", type: "A", value: "203.0.113.7" },
			{
				name: "_minecraft._tcp.play.example.com",
				type: "SRV",
				value: "0 5 25570 play.example.com",
			},
		]);
	});
	test("games without SRV get the address only, IPv6 as AAAA", () => {
		expect(gameRecords("cs2", "cs.example.com", "2001:db8::1", 27015)).toEqual([
			{ name: "cs.example.com", type: "AAAA", value: "2001:db8::1" },
		]);
	});
	test("players type a port only when SRV can't carry it", () => {
		expect(playerAddress("mumble", "v.example.com", 64740, true)).toBe(
			"v.example.com",
		);
		expect(playerAddress("cs2", "cs.example.com", 27015, true)).toBe(
			"cs.example.com",
		);
		expect(playerAddress("cs2", "cs.example.com", 27016, true)).toBe(
			"cs.example.com:27016",
		);
		expect(playerAddress("mumble", "1.2.3.4", 64740, false)).toBe(
			"1.2.3.4:64740",
		);
	});
});

describe("game definitions", () => {
	test("Java version picks the Java runtime", () => {
		expect(minecraftJavaImage("1.16.5")).toContain(":java8@");
		expect(minecraftJavaImage("1.20.4")).toContain(":java17@");
		expect(minecraftJavaImage("1.20.5")).toContain(":java25@");
		expect(minecraftJavaImage("LATEST")).toContain(":java25@");
		expect(minecraftJavaImage("26.1")).toContain(":java25@");
	});
	test("heap is three quarters of the limit, at least 512 MB", () => {
		expect(minecraftHeapMb(4096)).toBe(3072);
		expect(minecraftHeapMb(256)).toBe(512);
	});
	test("credentials cover every required key but the Steam token", () => {
		const minted = gameCredentials(settings.cs2);
		expect(Object.keys(minted).sort()).toEqual(
			[GAME_ENV.admin, GAME_ENV.join].sort(),
		);
		expect(minted[GAME_ENV.join]).toMatch(/^[A-HJ-NP-Za-km-z2-9]{10}$/);
		expect(gameCredentials(settings["minecraft-bedrock"])).toEqual({});
	});
});
