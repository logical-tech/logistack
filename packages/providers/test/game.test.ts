import { afterEach, describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import net from "node:net";
import {
	a2sInfo,
	chatText,
	minecraftBedrockStatus,
	minecraftJavaStatus,
	mumbleStatus,
	parseTs3,
	RCON,
	rcon,
	rconPacket,
	readVarInt,
	teamspeakAdminKey,
	teamspeakStatus,
	ts3Escape,
	ts3Unescape,
	writeVarInt,
} from "../src/game/index.ts";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const c of closers.splice(0)) c();
});

async function tcpServer(onConn: (s: net.Socket) => void): Promise<number> {
	const server = net.createServer(onConn);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => server.close());
	return (server.address() as net.AddressInfo).port;
}

async function udpServer(
	onMsg: (msg: Buffer, reply: (b: Uint8Array) => void) => void,
): Promise<number> {
	const sock = dgram.createSocket("udp4");
	sock.on("message", (msg, rinfo) =>
		onMsg(msg, (b) => sock.send(b, rinfo.port, rinfo.address)),
	);
	await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
	closers.push(() => sock.close());
	return sock.address().port;
}

describe("Minecraft", () => {
	test("VarInt round trip", () => {
		for (const n of [0, 1, 127, 128, 255, 25565, 2097151, 2147483647])
			expect(readVarInt(Uint8Array.from(writeVarInt(n)))[0]).toBe(n);
	});

	test("chat components flatten to text without § codes", () => {
		expect(
			chatText({ text: "§aHello ", extra: [{ text: "world" }, "!"] }),
		).toBe("Hello world!");
	});

	test("Server List Ping reads version, players and the sample", async () => {
		const json = JSON.stringify({
			version: { name: "Paper 1.21.4", protocol: 769 },
			players: { online: 2, max: 20, sample: [{ name: "alex", id: "x" }] },
			description: { text: "Welcome" },
		});
		const port = await tcpServer((s) =>
			s.once("data", () => {
				const str = [
					...writeVarInt(Buffer.byteLength(json)),
					...Buffer.from(json),
				];
				const body = [0x00, ...str];
				s.write(Uint8Array.from([...writeVarInt(body.length), ...body]));
			}),
		);
		expect(await minecraftJavaStatus("127.0.0.1", port)).toMatchObject({
			online: true,
			name: "Welcome",
			version: "Paper 1.21.4",
			players: 2,
			maxPlayers: 20,
			playerNames: ["alex"],
		});
	});

	test("Bedrock answers a RakNet unconnected ping", async () => {
		const port = await udpServer((msg, reply) => {
			expect(msg[0]).toBe(0x01);
			const text = Buffer.from(
				"MCPE;Island;712;1.21.40;3;10;123;level;Survival;1;19132;19133;",
			);
			const b = Buffer.alloc(35 + text.length);
			b[0] = 0x1c;
			msg.copy(b, 17, 9, 25); // the magic sits after time and server GUID
			b.writeUInt16BE(text.length, 33);
			text.copy(b, 35);
			reply(b);
		});
		expect(await minecraftBedrockStatus("127.0.0.1", port)).toMatchObject({
			online: true,
			name: "Island",
			version: "1.21.40",
			players: 3,
			maxPlayers: 10,
		});
	});
});

describe("Source", () => {
	test("A2S_INFO answers a challenge, then reads the reply", async () => {
		let asked = 0;
		const port = await udpServer((msg, reply) => {
			asked++;
			if (msg.length === 25) {
				reply(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4]));
				return;
			}
			expect([...msg.subarray(25)]).toEqual([1, 2, 3, 4]);
			const z = (s: string) => [...Buffer.from(s), 0];
			reply(
				Uint8Array.from([
					0xff,
					0xff,
					0xff,
					0xff,
					0x49,
					17,
					...z("Frag"),
					...z("de_dust2"),
					...z("csgo"),
					...z("Counter-Strike 2"),
					0xda,
					0x02,
					5,
					10,
					1,
					0x64,
					0x6c,
					0,
					1,
					...z("1.40.4.5"),
				]),
			);
		});
		expect(await a2sInfo("127.0.0.1", port)).toMatchObject({
			name: "Frag",
			map: "de_dust2",
			players: 4,
			maxPlayers: 10,
			version: "1.40.4.5",
		});
		expect(asked).toBe(2);
	});

	function rconServer(password: string, reply: (cmd: string) => string) {
		return tcpServer((s) => {
			let buf = Buffer.alloc(0);
			s.on("data", (d: Buffer) => {
				buf = Buffer.concat([buf, d]);
				while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
					const size = buf.readInt32LE(0);
					const id = buf.readInt32LE(4);
					const type = buf.readInt32LE(8);
					const body = buf.subarray(12, 4 + size - 2).toString();
					buf = buf.subarray(4 + size);
					if (type === RCON.auth) {
						s.write(rconPacket(id, RCON.response, ""));
						s.write(
							rconPacket(body === password ? id : -1, RCON.authResponse, ""),
						);
					} else {
						const out = reply(body);
						for (let i = 0; i < out.length || i === 0; i += 4096)
							s.write(rconPacket(id, RCON.response, out.slice(i, i + 4096)));
					}
				}
			});
		});
	}

	test("RCON logs in and runs commands", async () => {
		const port = await rconServer("pw", (cmd) => `ran ${cmd}`);
		expect(await rcon("127.0.0.1", port, "pw", ["list", "say hi"])).toEqual([
			"ran list",
			"ran say hi",
		]);
	});

	test("RCON joins a reply split over several packets", async () => {
		const long = "x".repeat(10_000);
		const port = await rconServer("pw", () => long);
		expect((await rcon("127.0.0.1", port, "pw", ["help"]))[0]).toBe(long);
	});

	test("RCON rejects a wrong password", async () => {
		const port = await rconServer("pw", () => "");
		await expect(rcon("127.0.0.1", port, "nope", ["list"])).rejects.toThrow(
			/refused the password/,
		);
	});
});

describe("voice", () => {
	test("Mumble UDP ping reads users and max", async () => {
		const port = await udpServer((msg, reply) => {
			const b = Buffer.alloc(24);
			b.set([0, 1, 5, 9], 0);
			msg.copy(b, 4, 4, 12);
			b.writeUInt32BE(7, 12);
			b.writeUInt32BE(100, 16);
			b.writeUInt32BE(558000, 20);
			reply(b);
		});
		expect(await mumbleStatus("127.0.0.1", port)).toMatchObject({
			version: "1.5.9",
			players: 7,
			maxPlayers: 100,
		});
	});

	test("ServerQuery escaping round-trips", () => {
		const s = "a b|c/d\\e";
		expect(ts3Escape(s)).toBe("a\\sb\\pc\\/d\\\\e");
		expect(ts3Unescape(ts3Escape(s))).toBe(s);
		expect(
			parseTs3("clid=1 client_nickname=A\\sB|clid=2 client_nickname=C"),
		).toEqual([
			{ clid: "1", client_nickname: "A B" },
			{ clid: "2", client_nickname: "C" },
		]);
	});

	function ts3Server(password: string) {
		const seen: string[] = [];
		const port = tcpServer((s) => {
			s.write("TS3\n\rWelcome to the TeamSpeak 3 ServerQuery interface\n\r");
			let buf = "";
			s.on("data", (d: Buffer) => {
				buf += d.toString();
				while (buf.includes("\n")) {
					const line = buf.slice(0, buf.indexOf("\n"));
					buf = buf.slice(buf.indexOf("\n") + 1);
					seen.push(line);
					const ok = "error id=0 msg=ok\n\r";
					if (line.startsWith("login"))
						s.write(
							line === `login serveradmin ${password}`
								? ok
								: "error id=520 msg=invalid\\sloginname\\sor\\spassword\n\r",
						);
					else if (line === "serverinfo")
						s.write(
							`virtualserver_name=Squad virtualserver_maxclients=32 virtualserver_version=3.13.7\\s[Build:\\s1]\n\r${ok}`,
						);
					else if (line === "clientlist")
						s.write(
							`clid=1 client_nickname=serveradmin client_type=1|clid=2 client_nickname=Ana client_type=0\n\r${ok}`,
						);
					else if (line === "servergrouplist")
						s.write(
							`sgid=6 name=Server\\sAdmin type=1|sgid=8 name=Guest type=1\n\r${ok}`,
						);
					else if (line.startsWith("privilegekeyadd"))
						s.write(`token=abc+def\n\r${ok}`);
					else s.write(ok);
				}
			});
		});
		return { port, seen };
	}

	test("TeamSpeak status lists real clients only", async () => {
		const srv = ts3Server("pw");
		expect(
			await teamspeakStatus("127.0.0.1", await srv.port, "pw"),
		).toMatchObject({
			name: "Squad",
			version: "3.13.7",
			players: 1,
			maxPlayers: 32,
			playerNames: ["Ana"],
		});
		expect(srv.seen.slice(0, 2)).toEqual(["login serveradmin pw", "use sid=1"]);
	});

	test("TeamSpeak admin key uses the Server Admin group", async () => {
		const srv = ts3Server("pw");
		expect(await teamspeakAdminKey("127.0.0.1", await srv.port, "pw")).toBe(
			"abc+def",
		);
		expect(srv.seen.find((l) => l.startsWith("privilegekeyadd"))).toContain(
			"tokenid1=6",
		);
	});

	test("ServerQuery errors reject with the server's message", async () => {
		const srv = ts3Server("pw");
		await expect(
			teamspeakStatus("127.0.0.1", await srv.port, "bad"),
		).rejects.toThrow("invalid loginname or password");
	});
});
