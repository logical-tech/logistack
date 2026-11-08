import { createWriteStream, renameSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { createGunzip } from "node:zlib";

// Country lookups from DB-IP's IP-to-Country Lite database (CC BY 4.0, attribution "IP
// Geolocation by DB-IP", https://db-ip.com), in the MaxMind DB format. The file is mapped,
// not read into the heap. Only the ISO country code leaves this module.

const MARKER = new Uint8Array([
	0xab,
	0xcd,
	0xef,
	...new TextEncoder().encode("MaxMind.com"),
]);

type Value =
	| string
	| number
	| boolean
	| bigint
	| Uint8Array
	| Value[]
	| { [k: string]: Value }
	| null;

class Decoder {
	constructor(
		private buf: Uint8Array,
		/** Pointers are relative to this offset. */
		private base: number,
	) {}

	private uint(at: number, n: number): number {
		let v = 0;
		for (let i = 0; i < n; i++) v = v * 256 + (this.buf[at + i] as number);
		return v;
	}

	decode(at: number): [Value, number] {
		const ctrl = this.buf[at++] as number;
		let type = ctrl >> 5;
		if (type === 1) {
			const ss = (ctrl >> 3) & 3;
			const v = ctrl & 7;
			const ptr =
				ss === 0
					? (v << 8) | this.uint(at, 1)
					: ss === 1
						? ((v << 16) | this.uint(at, 2)) + 2048
						: ss === 2
							? v * 2 ** 24 + this.uint(at, 3) + 526336
							: this.uint(at, 4);
			return [this.decode(this.base + ptr)[0], at + ss + 1];
		}
		if (type === 0) type = 7 + (this.buf[at++] as number);
		let size = ctrl & 0x1f;
		if (size === 29) size = 29 + this.uint(at++, 1);
		else if (size === 30) {
			size = 285 + this.uint(at, 2);
			at += 2;
		} else if (size === 31) {
			size = 65821 + this.uint(at, 3);
			at += 3;
		}
		switch (type) {
			case 2:
				return [
					new TextDecoder().decode(this.buf.subarray(at, at + size)),
					at + size,
				];
			case 3:
				return [
					new DataView(this.buf.buffer, this.buf.byteOffset + at, 8).getFloat64(
						0,
					),
					at + 8,
				];
			case 4:
				return [this.buf.subarray(at, at + size), at + size];
			case 5:
			case 6:
			case 8:
				return [this.uint(at, size), at + size];
			case 9:
			case 10:
				return [
					size
						? BigInt(
								`0x${Buffer.from(this.buf.subarray(at, at + size)).toString("hex")}`,
							)
						: 0n,
					at + size,
				];
			case 7: {
				const out: Record<string, Value> = {};
				for (let i = 0; i < size; i++) {
					const [k, a] = this.decode(at);
					const [v, b] = this.decode(a);
					out[String(k)] = v;
					at = b;
				}
				return [out, at];
			}
			case 11: {
				const out: Value[] = [];
				for (let i = 0; i < size; i++) {
					const [v, b] = this.decode(at);
					out.push(v);
					at = b;
				}
				return [out, at];
			}
			case 14:
				return [size !== 0, at];
			case 15:
				return [
					new DataView(this.buf.buffer, this.buf.byteOffset + at, 4).getFloat32(
						0,
					),
					at + 4,
				];
			default:
				return [null, at + size];
		}
	}
}

function lastIndexOf(buf: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = buf.length - needle.length; i >= 0; i--) {
		for (let j = 0; j < needle.length; j++)
			if (buf[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

function ipBits(ip: string): number[] | undefined {
	const v4 =
		ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/) ??
		ip.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i);
	const bytes: number[] = [];
	if (v4) {
		for (const p of v4.slice(1)) bytes.push(Number(p));
		if (bytes.some((b) => b > 255)) return undefined;
		return [
			...Array(96).fill(0),
			...bytes.flatMap((b) =>
				[7, 6, 5, 4, 3, 2, 1, 0].map((s) => (b >> s) & 1),
			),
		];
	}
	if (!ip.includes(":")) return undefined;
	const [head = "", tail = ""] = ip.split("::");
	const h = head ? head.split(":") : [];
	const t = tail ? tail.split(":") : [];
	if (!ip.includes("::") && h.length !== 8) return undefined;
	const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
	if (groups.length !== 8) return undefined;
	return groups.flatMap((g) => {
		const n = Number.parseInt(g, 16);
		return Array.from({ length: 16 }, (_, i) => (n >> (15 - i)) & 1);
	});
}

export type CountryReader = (ip: string) => string | undefined;

/** Opens a MaxMind DB file and returns a country-code lookup. Throws on a file it cannot read. */
export function openCountryDb(buf: Uint8Array): CountryReader {
	const m = lastIndexOf(buf, MARKER);
	if (m < 0) throw new Error("not a MaxMind DB file");
	const metaStart = m + MARKER.length;
	const meta = new Decoder(buf, metaStart).decode(metaStart)[0] as Record<
		string,
		Value
	>;
	const nodeCount = Number(meta.node_count);
	const recordSize = Number(meta.record_size);
	const ipVersion = Number(meta.ip_version);
	if (![24, 28, 32].includes(recordSize))
		throw new Error(`record size ${recordSize}`);
	const nodeBytes = recordSize / 4;
	const dataStart = nodeCount * nodeBytes + 16;
	const data = new Decoder(buf, dataStart);

	const record = (node: number, bit: number): number => {
		const at = node * nodeBytes;
		if (recordSize === 24) {
			const o = at + bit * 3;
			return (
				((buf[o] as number) << 16) |
				((buf[o + 1] as number) << 8) |
				(buf[o + 2] as number)
			);
		}
		if (recordSize === 32) {
			const o = at + bit * 4;
			return (
				(((buf[o] as number) << 24) >>> 0) +
				(((buf[o + 1] as number) << 16) |
					((buf[o + 2] as number) << 8) |
					(buf[o + 3] as number))
			);
		}
		const mid = buf[at + 3] as number;
		return bit === 0
			? ((mid >> 4) << 24) |
					((buf[at] as number) << 16) |
					((buf[at + 1] as number) << 8) |
					(buf[at + 2] as number)
			: ((mid & 0x0f) << 24) |
					((buf[at + 4] as number) << 16) |
					((buf[at + 5] as number) << 8) |
					(buf[at + 6] as number);
	};

	// A few hundred records (one per country) serve every address: decode each once.
	const byOffset = new Map<number, string | undefined>();
	return (ip) => {
		let bits = ipBits(ip);
		if (!bits) return undefined;
		if (ipVersion === 4) {
			if (bits.slice(0, 96).some((b) => b)) return undefined;
			bits = bits.slice(96);
		}
		let node = 0;
		for (const bit of bits) {
			if (node >= nodeCount) break;
			node = record(node, bit);
		}
		if (node <= nodeCount) return undefined;
		const offset = dataStart + (node - nodeCount) - 16;
		if (byOffset.has(offset)) return byOffset.get(offset);
		const [v] = data.decode(offset);
		const country = (v as Record<string, Value> | null)?.country as
			| Record<string, Value>
			| undefined;
		const iso =
			typeof country?.iso_code === "string" &&
			/^[A-Z]{2}$/.test(country.iso_code)
				? country.iso_code
				: undefined;
		if (byOffset.size < 4096) byOffset.set(offset, iso);
		return iso;
	};
}

const MONTH = 31 * 86_400_000;

export const dbipUrl = (d: Date) =>
	`https://download.db-ip.com/free/dbip-country-lite-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.mmdb.gz`;

/** Downloads this month's file (last month's while this one is not out yet) when `path` is missing or a month old. */
export async function refreshCountryDb(
	path: string,
	now = new Date(),
): Promise<boolean> {
	try {
		if (now.getTime() - statSync(path).mtimeMs < MONTH) return false;
	} catch {
		// missing
	}
	const last = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
	);
	for (const url of [dbipUrl(now), dbipUrl(last)]) {
		const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (res.status === 404) continue;
		if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
		// Streamed through gunzip to disk: the agent never holds the file in memory.
		await pipeline(
			Readable.fromWeb(res.body as WebStream),
			createGunzip(),
			createWriteStream(`${path}.tmp`),
		);
		renameSync(`${path}.tmp`, path);
		return true;
	}
	throw new Error("no DB-IP country file for this or last month");
}

/** A lookup over the file at `path`, memory-mapped; undefined when it is missing or unreadable. */
export function loadCountryDb(path: string): CountryReader | undefined {
	try {
		return openCountryDb(Bun.mmap(path));
	} catch {
		return undefined;
	}
}
