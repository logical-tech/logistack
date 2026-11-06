import type { GameStatus } from "@logistack/contracts";
import { tcpStream, udpExchange } from "./net.ts";

/** Mumble's legacy UDP ping: 4 zero bytes and an 8-byte ident; the reply is 24 bytes. */
export function mumblePing(ident: bigint): Uint8Array {
	const b = new Uint8Array(12);
	new DataView(b.buffer).setBigUint64(4, ident);
	return b;
}

export function parseMumblePong(msg: Uint8Array): GameStatus {
	if (msg.length < 24) throw new Error("not a Mumble ping reply");
	const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
	return {
		online: true,
		version: `${msg[1]}.${msg[2]}.${msg[3]}`,
		players: v.getUint32(12),
		maxPlayers: v.getUint32(16),
	};
}

export async function mumbleStatus(
	host: string,
	port: number,
): Promise<GameStatus> {
	const started = performance.now();
	const msg = await udpExchange(
		host,
		port,
		mumblePing(0x4c53n),
		(m) => m.length >= 24,
	);
	return {
		...parseMumblePong(msg),
		latencyMs: Math.round(performance.now() - started),
	};
}

const TS3_ESCAPES: [string, string][] = [
	["\\", "\\\\"],
	["/", "\\/"],
	[" ", "\\s"],
	["|", "\\p"],
	["\n", "\\n"],
	["\r", "\\r"],
	["\t", "\\t"],
];

export const ts3Escape = (s: string) =>
	TS3_ESCAPES.reduce((acc, [from, to]) => acc.replaceAll(from, to), s);

export const ts3Unescape = (s: string) =>
	s.replace(/\\(.)/g, (_, c: string) =>
		c === "s"
			? " "
			: c === "p"
				? "|"
				: c === "n"
					? "\n"
					: c === "r"
						? "\r"
						: c === "t"
							? "\t"
							: c,
	);

/** One ServerQuery reply line: `|`-separated entries of `key=value` pairs. */
export function parseTs3(line: string): Record<string, string>[] {
	if (!line) return [];
	return line.split("|").map((entry) =>
		Object.fromEntries(
			entry.split(" ").map((pair) => {
				const i = pair.indexOf("=");
				return i < 0
					? [pair, ""]
					: [pair.slice(0, i), ts3Unescape(pair.slice(i + 1))];
			}),
		),
	);
}

export class Ts3Error extends Error {
	constructor(
		readonly id: number,
		message: string,
	) {
		super(message);
	}
}

/**
 * A ServerQuery session as `serveradmin` on virtual server 1. Each command returns its parsed
 * data lines; a non-zero `error id=` rejects.
 */
export async function ts3Query<T>(
	host: string,
	port: number,
	password: string,
	run: (
		cmd: (command: string) => Promise<Record<string, string>[]>,
	) => Promise<T>,
): Promise<T> {
	const s = await tcpStream(host, port, 5000);
	try {
		// Greeting: "TS3" and a welcome line.
		await s.readLine();
		await s.readLine();
		const cmd = async (command: string) => {
			await s.write(`${command}\n`);
			const data: string[] = [];
			for (;;) {
				const line = await s.readLine();
				if (line.startsWith("error ")) {
					const [e] = parseTs3(line.slice(6));
					const id = Number(e?.id ?? -1);
					if (id !== 0) throw new Ts3Error(id, e?.msg ?? "ServerQuery error");
					return data.flatMap(parseTs3);
				}
				if (line.trim()) data.push(line);
			}
		};
		await cmd(`login serveradmin ${ts3Escape(password)}`);
		await cmd("use sid=1");
		return await run(cmd);
	} finally {
		s.close();
	}
}

/** Name, version, clients online and the client nicknames, as `serveradmin`. */
export async function teamspeakStatus(
	host: string,
	port: number,
	password: string,
): Promise<GameStatus> {
	const started = performance.now();
	return ts3Query(host, port, password, async (cmd) => {
		const [info] = await cmd("serverinfo");
		const clients = await cmd("clientlist");
		// Type 1 is a ServerQuery client (including this session); players are type 0.
		const people = clients.filter((c) => c.client_type === "0");
		return {
			online: true,
			...(info?.virtualserver_name ? { name: info.virtualserver_name } : {}),
			...(info?.virtualserver_version
				? { version: info.virtualserver_version.split(" ")[0] }
				: {}),
			players: people.length,
			maxPlayers: Number(info?.virtualserver_maxclients ?? 0),
			playerNames: people.map((c) => c.client_nickname ?? ""),
			latencyMs: Math.round(performance.now() - started),
		};
	});
}

/**
 * A new Server Admin privilege key. Group 6 is "Server Admin" on a fresh virtual server; the
 * group id is looked up by name so a renumbered server still works.
 */
export async function teamspeakAdminKey(
	host: string,
	port: number,
	password: string,
): Promise<string> {
	return ts3Query(host, port, password, async (cmd) => {
		const groups = await cmd("servergrouplist");
		const admin =
			groups.find((g) => g.name === "Server Admin" && g.type === "1") ??
			groups.find((g) => g.sgid === "6");
		if (!admin?.sgid) throw new Error("no Server Admin group on this server");
		const [key] = await cmd(
			`privilegekeyadd tokentype=0 tokenid1=${admin.sgid} tokenid2=0 tokendescription=${ts3Escape("Created by LogiStack")}`,
		);
		if (!key?.token) throw new Error("ServerQuery returned no key");
		return key.token;
	});
}
