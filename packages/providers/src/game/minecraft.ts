import type { GameStatus } from "@logistack/contracts";
import { tcpStream, udpExchange } from "./net.ts";

export function writeVarInt(n: number): number[] {
	const out: number[] = [];
	let v = n >>> 0;
	do {
		let b = v & 0x7f;
		v >>>= 7;
		if (v) b |= 0x80;
		out.push(b);
	} while (v);
	return out;
}

/** Reads a VarInt at `offset`; returns the value and how many bytes it used. */
export function readVarInt(b: Uint8Array, offset = 0): [number, number] {
	let value = 0;
	for (let i = 0; i < 5; i++) {
		const byte = b[offset + i];
		if (byte === undefined) throw new RangeError("truncated VarInt");
		value |= (byte & 0x7f) << (7 * i);
		if (!(byte & 0x80)) return [value >>> 0, i + 1];
	}
	throw new RangeError("VarInt longer than 5 bytes");
}

const packet = (body: number[]) => [...writeVarInt(body.length), ...body];

const mcString = (s: string) => {
	const bytes = [...new TextEncoder().encode(s)];
	return [...writeVarInt(bytes.length), ...bytes];
};

/** Minecraft chat components flatten to their text; `§` formatting codes are dropped. */
export function chatText(c: unknown): string {
	if (typeof c === "string") return c.replace(/§./g, "");
	if (!c || typeof c !== "object") return "";
	const o = c as { text?: unknown; extra?: unknown[] };
	return (
		chatText(o.text ?? "") + (o.extra ?? []).map((e) => chatText(e)).join("")
	);
}

/** The handshake (next state: status) and the status request, as one write. */
export function slpRequest(host: string, port: number): Uint8Array {
	const handshake = packet([
		0x00,
		...writeVarInt(767),
		...mcString(host),
		(port >> 8) & 0xff,
		port & 0xff,
		0x01,
	]);
	return Uint8Array.from([...handshake, ...packet([0x00])]);
}

/** Parses the JSON a status response carries into a `GameStatus`. */
export function parseSlpJson(json: string, latencyMs?: number): GameStatus {
	const s = JSON.parse(json) as {
		version?: { name?: string };
		players?: { online?: number; max?: number; sample?: { name: string }[] };
		description?: unknown;
	};
	return {
		online: true,
		name: chatText(s.description ?? ""),
		...(s.version?.name ? { version: s.version.name } : {}),
		players: s.players?.online ?? 0,
		maxPlayers: s.players?.max ?? 0,
		...(s.players?.sample?.length
			? { playerNames: s.players.sample.map((p) => p.name) }
			: {}),
		...(latencyMs !== undefined ? { latencyMs } : {}),
	};
}

/** Server List Ping: what the multiplayer screen shows, from a Java server. */
export async function minecraftJavaStatus(
	host: string,
	port: number,
): Promise<GameStatus> {
	const started = performance.now();
	const s = await tcpStream(host, port);
	try {
		await s.write(slpRequest(host, port));
		// The packet length VarInt, then id 0x00, then the JSON string's own length.
		const head = await s.read(1);
		let lenBytes = Buffer.from(head);
		while ((lenBytes.at(-1) ?? 0) & 0x80)
			lenBytes = Buffer.concat([lenBytes, await s.read(1)]);
		const [length] = readVarInt(lenBytes);
		const body = await s.read(length);
		const latency = Math.round(performance.now() - started);
		if (body[0] !== 0x00) throw new Error("not a status response");
		const [strLen, used] = readVarInt(body, 1);
		return parseSlpJson(
			body.subarray(1 + used, 1 + used + strLen).toString("utf8"),
			latency,
		);
	} finally {
		s.close();
	}
}

const RAKNET_MAGIC = Uint8Array.from([
	0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12,
	0x34, 0x56, 0x78,
]);

export function raknetPing(nowMs: bigint): Uint8Array {
	const b = new Uint8Array(1 + 8 + 16 + 8);
	const v = new DataView(b.buffer);
	b[0] = 0x01;
	v.setBigUint64(1, nowMs);
	b.set(RAKNET_MAGIC, 9);
	v.setBigUint64(25, 0x4c5354414b4cn);
	return b;
}

/** Unconnected pong: `MCPE;motd;protocol;version;players;max;serverId;level;gamemode;…`. */
export function parseRaknetPong(msg: Uint8Array): GameStatus {
	if (msg[0] !== 0x1c) throw new Error("not an unconnected pong");
	const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
	const len = v.getUint16(33);
	const fields = new TextDecoder()
		.decode(msg.subarray(35, 35 + len))
		.split(";");
	return {
		online: true,
		name: fields[1] ?? "",
		...(fields[3] ? { version: fields[3] } : {}),
		players: Number(fields[4] ?? 0),
		maxPlayers: Number(fields[5] ?? 0),
	};
}

/** Bedrock's RakNet unconnected ping over UDP. */
export async function minecraftBedrockStatus(
	host: string,
	port: number,
): Promise<GameStatus> {
	const started = performance.now();
	const msg = await udpExchange(
		host,
		port,
		raknetPing(BigInt(Date.now())),
		(m) => m[0] === 0x1c,
	);
	return {
		...parseRaknetPong(msg),
		latencyMs: Math.round(performance.now() - started),
	};
}
