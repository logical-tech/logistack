import type { GameStatus } from "@logistack/contracts";
import { type TcpStream, tcpStream, udpExchange } from "./net.ts";

const A2S_INFO = Uint8Array.from([
	0xff,
	0xff,
	0xff,
	0xff,
	0x54,
	...new TextEncoder().encode("Source Engine Query"),
	0x00,
]);

/** A2S_INFO reply (header 0x49): name, map, folder, game, app id, players, max, bots, … */
export function parseA2sInfo(msg: Uint8Array): GameStatus {
	if (msg[4] !== 0x49) throw new Error("not an A2S_INFO reply");
	let at = 6;
	const str = () => {
		const end = msg.indexOf(0, at);
		const s = new TextDecoder().decode(msg.subarray(at, end));
		at = end + 1;
		return s;
	};
	const name = str();
	const map = str();
	str(); // folder
	str(); // game
	at += 2; // app id
	const players = msg[at] ?? 0;
	const maxPlayers = msg[at + 1] ?? 0;
	const bots = msg[at + 2] ?? 0;
	// After bots: server type, environment, visibility, VAC, then the version string.
	const versionAt = at + 7;
	const versionEnd = msg.indexOf(0, versionAt);
	const version =
		versionEnd > versionAt
			? new TextDecoder().decode(msg.subarray(versionAt, versionEnd))
			: undefined;
	return {
		online: true,
		name,
		map,
		players: Math.max(0, players - bots),
		maxPlayers,
		...(version ? { version } : {}),
	};
}

/** A2S_INFO over UDP; answers a challenge (0x41) by repeating the query with it. */
export async function a2sInfo(host: string, port: number): Promise<GameStatus> {
	const started = performance.now();
	const msg = await udpExchange(host, port, A2S_INFO, (m, reply) => {
		if (m[4] === 0x41) {
			reply(Uint8Array.from([...A2S_INFO, ...m.subarray(5, 9)]));
			return false;
		}
		return m[4] === 0x49;
	});
	return {
		...parseA2sInfo(msg),
		latencyMs: Math.round(performance.now() - started),
	};
}

export const RCON = { auth: 3, authResponse: 2, exec: 2, response: 0 } as const;

export function rconPacket(id: number, type: number, body: string): Buffer {
	const text = Buffer.from(body, "utf8");
	const b = Buffer.alloc(4 + 4 + 4 + text.length + 2);
	b.writeInt32LE(b.length - 4, 0);
	b.writeInt32LE(id, 4);
	b.writeInt32LE(type, 8);
	text.copy(b, 12);
	return b;
}

type RconPacket = { id: number; type: number; body: string };

async function readPacket(s: TcpStream): Promise<RconPacket> {
	const size = (await s.read(4)).readInt32LE(0);
	if (size < 10 || size > 1 << 20) throw new Error("malformed RCON packet");
	const rest = await s.read(size);
	return {
		id: rest.readInt32LE(0),
		type: rest.readInt32LE(4),
		body: rest.subarray(8, rest.length - 2).toString("utf8"),
	};
}

/**
 * Source RCON (Minecraft Java and CS2 speak it). Logs in with `password`, runs each command and
 * returns its output. A long reply arrives in several packets with the command's id; they are
 * joined until the server goes quiet.
 */
export async function rcon(
	host: string,
	port: number,
	password: string,
	commands: string[],
): Promise<string[]> {
	const s = await tcpStream(host, port, 5000);
	try {
		await s.write(rconPacket(1, RCON.auth, password));
		let auth = await readPacket(s);
		// Source servers send an empty response value before the auth response.
		if (auth.type === RCON.response) auth = await readPacket(s);
		if (auth.id === -1) throw new Error("RCON refused the password");
		const out: string[] = [];
		let id = 10;
		for (const command of commands) {
			id++;
			await s.write(rconPacket(id, RCON.exec, command));
			const first = await readPacket(s);
			let body = first.id === id ? first.body : "";
			// A reply over 4 KB comes in pieces; keep reading until the server goes quiet.
			if (body.length >= 4000) {
				let pending = Buffer.alloc(0);
				for (;;) {
					const more = await s.drain(150);
					if (!more.length) break;
					pending = Buffer.concat([pending, more]);
					while (pending.length >= 4) {
						const size = pending.readInt32LE(0);
						if (pending.length < 4 + size) break;
						body += pending.subarray(12, 4 + size - 2).toString("utf8");
						pending = pending.subarray(4 + size);
					}
				}
			}
			out.push(body);
		}
		return out;
	} finally {
		s.close();
	}
}
