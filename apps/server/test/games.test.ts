import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import net from "node:net";
import { envVar, node } from "@logistack/db";
import { RCON, rconPacket } from "@logistack/providers";
import { and, eq } from "drizzle-orm";
import {
	type Harness,
	hasDocker,
	owner,
	setupBody,
	startHarness,
} from "./harness.ts";

const mumble = (port = 64738) => ({
	kind: "game",
	settings: {
		game: "mumble",
		serverName: "Squad",
		welcomeText: "Hi",
		maxUsers: 20,
		private: true,
	},
	port,
	resources: {},
});

const minecraft = {
	kind: "game",
	settings: {
		game: "minecraft-java",
		eula: true,
		flavour: "paper",
		version: "1.21.4",
		motd: "Hello",
		maxPlayers: 20,
		difficulty: "normal",
		gamemode: "survival",
		onlineMode: true,
		whitelist: false,
		pvp: true,
	},
	port: 25565,
	resources: { memoryMb: 2048 },
};

describe.skipIf(!hasDocker)("game servers", () => {
	let h: Harness;
	let envId: string;
	let cookie: string;
	let nodeId: string;
	const as = () => ({ headers: { cookie } });
	const create = (name: string, spec: unknown, extra = {}) =>
		h.call("POST", `/api/environments/${envId}/services`, {
			...as(),
			body: { name, spec, ...extra },
		});
	const closers: (() => void)[] = [];

	beforeAll(async () => {
		h = await startHarness({ area: "games", label: "games" });
		const orgId = (await h.call("POST", "/api/setup", { body: setupBody })).json
			.organizationId;
		cookie = await h.signIn(owner.email, owner.password);
		const project = await h.call("POST", "/api/projects", {
			...as(),
			body: { name: "Fun" },
		});
		envId = (
			await h.call("GET", `/api/projects/${project.json.id}/environments`, as())
		).json[0].id;
		const [row] = await h.deps.db
			.insert(node)
			.values({
				organizationId: orgId,
				swarmNodeId: "swarm-game",
				hostname: "box",
				address: "10.0.0.5",
				role: "manager",
			})
			.returning();
		nodeId = row?.id as string;
	});
	afterAll(async () => {
		for (const c of closers) c();
		await h?.close();
	});

	let mumbleId: string;
	test("creating a game server mints its secrets and pins it", async () => {
		const res = await create("voice", mumble());
		expect(res.status).toBe(201);
		expect(res.json.kind).toBe("game");
		expect(res.json.nodeId).toBe(nodeId);
		expect(res.json.icon).toBe("mumble");
		mumbleId = res.json.id;
		const keys = await h.deps.db
			.select({ key: envVar.key, isSecret: envVar.isSecret })
			.from(envVar)
			.where(and(eq(envVar.scope, "service"), eq(envVar.scopeId, mumbleId)));
		expect(keys.map((k) => k.key).sort()).toEqual([
			"GAME_ADMIN_PASSWORD",
			"GAME_JOIN_PASSWORD",
		]);
		expect(keys.every((k) => k.isSecret)).toBe(true);
		const creds = await h.call(
			"GET",
			`/api/services/${mumbleId}/game/credentials`,
			as(),
		);
		expect(creds.json.join).toMatch(/^[A-Za-z0-9]{10}$/);
	});

	test("a port taken on the node is refused, and the next free one suggested", async () => {
		const res = await create("voice-2", mumble());
		expect(res.status).toBe(409);
		expect(res.json.error.message).toContain("64738/tcp");
		const port = await h.call(
			"GET",
			`/api/games/port?game=mumble&nodeId=${nodeId}`,
			as(),
		);
		expect(port.json.port).toBe(64739);
		expect((await create("voice-2", mumble(64739))).status).toBe(201);
	});

	test("Counter-Strike 2 needs a Steam token", async () => {
		const spec = {
			kind: "game",
			settings: {
				game: "cs2",
				serverName: "Frag",
				maxPlayers: 10,
				mode: "competitive",
				map: "de_dust2",
				private: false,
			},
			port: 27015,
			resources: {},
		};
		expect((await create("cs", spec)).status).toBe(400);
		const res = await create("cs", spec, {
			gameToken: "ABCDEF0123456789ABCDEF0123456789",
		});
		expect(res.status).toBe(201);
		const [token] = await h.deps.db
			.select()
			.from(envVar)
			.where(
				and(
					eq(envVar.scopeId, res.json.id),
					eq(envVar.key, "GAME_STEAM_TOKEN"),
				),
			);
		expect(token?.isSecret).toBe(true);
	});

	test("Minecraft needs the EULA accepted", async () => {
		const res = await create("mc-no-eula", {
			...minecraft,
			settings: { ...minecraft.settings, eula: false },
		});
		expect(res.status).toBe(400);
	});

	test("the game view reads live status over the game's protocol", async () => {
		const sock = dgram.createSocket("udp4");
		sock.on("message", (msg, r) => {
			const b = Buffer.alloc(24);
			b.set([0, 1, 5, 9], 0);
			msg.copy(b, 4, 4, 12);
			b.writeUInt32BE(3, 12);
			b.writeUInt32BE(20, 16);
			sock.send(b, r.port, r.address);
		});
		await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
		closers.push(() => sock.close());
		h.deps.gameEndpoint = () => ({
			host: "127.0.0.1",
			port: sock.address().port,
		});
		const res = await h.call("GET", `/api/services/${mumbleId}/game`, as());
		expect(res.status).toBe(200);
		expect(res.json.status).toMatchObject({
			online: true,
			players: 3,
			maxPlayers: 20,
		});
		// The node's address is private, so players get the instance's public IP.
		expect(res.json.address).toBe("203.0.113.7");
		expect(res.json.directAddress).toBe("203.0.113.7");
		expect(res.json.ports).toEqual([
			{ published: 64738, protocol: "tcp", label: "Control" },
			{ published: 64738, protocol: "udp", label: "Voice" },
		]);
		expect(res.json.console).toBe(false);
	});

	test("RCON runs console commands; games without it refuse", async () => {
		const mc = await create("mc", minecraft);
		expect(mc.status).toBe(201);
		const [pw] = (
			await h.call("GET", `/api/services/${mc.json.id}/game/credentials`, as())
		).json.admin.split("\n");
		const server = net.createServer((s) => {
			let buf = Buffer.alloc(0);
			s.on("data", (d: Buffer) => {
				buf = Buffer.concat([buf, d]);
				while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
					const size = buf.readInt32LE(0);
					const id = buf.readInt32LE(4);
					const type = buf.readInt32LE(8);
					const text = buf.subarray(12, 4 + size - 2).toString();
					buf = buf.subarray(4 + size);
					s.write(
						type === RCON.auth
							? rconPacket(text === pw ? id : -1, RCON.authResponse, "")
							: rconPacket(id, RCON.response, `ok: ${text}`),
					);
				}
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		closers.push(() => server.close());
		h.deps.gameEndpoint = (_id, port) => {
			expect(port).toBe(25575);
			return {
				host: "127.0.0.1",
				port: (server.address() as net.AddressInfo).port,
			};
		};
		const res = await h.call(
			"POST",
			`/api/services/${mc.json.id}/game/command`,
			{ ...as(), body: { command: "/whitelist add alex" } },
		);
		expect(res.status).toBe(200);
		expect(res.json.output).toBe("ok: whitelist add alex");
		const audit = await h.call(
			"GET",
			"/api/audit-log?action=game.command",
			as(),
		);
		expect(JSON.stringify(audit.json)).not.toContain(pw);

		const refused = await h.call(
			"POST",
			`/api/services/${mumbleId}/game/command`,
			{ ...as(), body: { command: "list" } },
		);
		expect(refused.status).toBe(400);
		h.deps.gameEndpoint = undefined;
	});

	test("an endpoint without a DNS provider lists the records to create", async () => {
		await h.deps.db
			.update(node)
			.set({ publicAddress: "198.51.100.4" })
			.where(eq(node.id, nodeId));
		const res = await h.call(
			"POST",
			`/api/services/${mumbleId}/game/endpoints`,
			{ ...as(), body: { hostname: "Voice.Example.com", dnsProviderId: null } },
		);
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({
			hostname: "voice.example.com",
			status: "active",
			inSync: true,
			playerAddress: "voice.example.com",
			records: [
				{ name: "voice.example.com", type: "A", value: "198.51.100.4" },
				{
					name: "_mumble._tcp.voice.example.com",
					type: "SRV",
					value: "0 5 64738 voice.example.com",
				},
			],
		});
		const dupe = await h.call(
			"POST",
			`/api/services/${mumbleId}/game/endpoints`,
			{ ...as(), body: { hostname: "voice.example.com", dnsProviderId: null } },
		);
		expect(dupe.status).toBe(409);
		const view = await h.call("GET", `/api/services/${mumbleId}/game`, as());
		expect(view.json.endpoints).toHaveLength(1);
		expect(
			(await h.call("DELETE", `/api/game-endpoints/${res.json.id}`, as()))
				.status,
		).toBe(204);
	});

	test("the game cannot change on an existing service", async () => {
		const res = await h.call("PATCH", `/api/services/${mumbleId}`, {
			...as(),
			body: { spec: minecraft },
		});
		expect(res.status).toBe(400);
	});
});
