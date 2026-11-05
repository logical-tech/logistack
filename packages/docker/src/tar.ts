/*
 * The minimal ustar writer behind uploads into a container: regular files and their parent
 * directories, owned by root, as the engine's archive endpoint and `tar -x` both accept.
 */

export type TarFile = { path: string; data: Uint8Array };

const BLOCK = 512;
const enc = new TextEncoder();

/**
 * A relative path inside a volume, normalized ("a//b/./c" -> "a/b/c"); throws on anything that
 * could leave it: `..`, an absolute path, a backslash, a control character or an empty name.
 */
export function safeRelativePath(input: string): string {
	if (input.startsWith("/")) throw new Error("absolute paths are not allowed");
	if (input.includes("\\")) throw new Error("backslashes are not allowed");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
	if (/[\u0000-\u001f\u007f]/.test(input))
		throw new Error("control characters are not allowed");
	const parts = input.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.some((p) => p === "..")) throw new Error(".. is not allowed");
	if (!parts.length) throw new Error("empty path");
	const path = parts.join("/");
	if (enc.encode(path).length > 255)
		throw new Error("path longer than 255 bytes");
	return path;
}

/** `name` fits ustar's 100-byte name, else splits at a slash into the 155-byte prefix. */
function splitName(path: string): { name: string; prefix: string } {
	if (enc.encode(path).length <= 100) return { name: path, prefix: "" };
	for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
		const prefix = path.slice(0, i);
		const name = path.slice(i + 1);
		if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100)
			return { name, prefix };
	}
	throw new Error(`${path}: no ustar split fits`);
}

function octal(n: number, width: number): string {
	return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function header(path: string, size: number, dir: boolean, mtime: number) {
	const h = new Uint8Array(BLOCK);
	const put = (s: string, at: number) => h.set(enc.encode(s), at);
	const { name, prefix } = splitName(dir ? `${path}/` : path);
	put(name, 0);
	put(octal(dir ? 0o755 : 0o644, 8), 100);
	put(octal(0, 8), 108); // uid
	put(octal(0, 8), 116); // gid
	put(octal(size, 12), 124);
	put(octal(mtime, 12), 136);
	put("        ", 148); // checksum counts as spaces while summing
	put(dir ? "5" : "0", 156);
	put("ustar\0", 257);
	put("00", 263);
	put(prefix, 345);
	let sum = 0;
	for (const b of h) sum += b;
	put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return h;
}

/**
 * One archive with every file under its sanitized path, preceded by each parent directory once.
 * Throws on an unsafe path or a duplicate.
 */
export function buildTar(
	files: TarFile[],
	mtime = Math.floor(Date.now() / 1000),
): Uint8Array {
	const parts: Uint8Array[] = [];
	const dirs = new Set<string>();
	const seen = new Set<string>();
	for (const f of files) {
		const path = safeRelativePath(f.path);
		if (seen.has(path)) throw new Error(`${path}: listed twice`);
		seen.add(path);
		const segments = path.split("/");
		for (let i = 1; i < segments.length; i++) {
			const dir = segments.slice(0, i).join("/");
			if (dirs.has(dir)) continue;
			dirs.add(dir);
			parts.push(header(dir, 0, true, mtime));
		}
		parts.push(header(path, f.data.length, false, mtime));
		parts.push(f.data);
		const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
		if (pad) parts.push(new Uint8Array(pad));
	}
	parts.push(new Uint8Array(BLOCK * 2));
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/**
 * The content of the first regular file in a tar, as the engine's archive endpoint returns one
 * file. Undefined when there is none (the path was a directory).
 */
export function firstTarFile(tar: Uint8Array): Uint8Array | undefined {
	for (let at = 0; at + BLOCK <= tar.length; ) {
		const head = tar.subarray(at, at + BLOCK);
		if (head.every((b) => b === 0)) return undefined;
		const size = Number.parseInt(
			new TextDecoder()
				.decode(head.subarray(124, 136))
				.replace(/\0.*$/, "")
				.trim() || "0",
			8,
		);
		const type = String.fromCharCode(head[156] ?? 0);
		const start = at + BLOCK;
		if (type === "0" || type === "\0") return tar.slice(start, start + size);
		at = start + Math.ceil(size / BLOCK) * BLOCK;
	}
	return undefined;
}

export type TarHeader = {
	name: string;
	type: "file" | "dir" | "symlink" | "hardlink" | "other";
	size: number;
	/** Permission bits. */
	mode: number;
	/** Unix seconds. */
	mtime: number;
	linkname: string;
};
export type TarEvent = { header: TarHeader } | { data: Uint8Array };

const TYPES: Record<string, TarHeader["type"]> = {
	"0": "file",
	"\0": "file",
	"7": "file",
	"1": "hardlink",
	"2": "symlink",
	"5": "dir",
};

const dec = new TextDecoder();
const field = (h: Uint8Array, at: number, len: number) => {
	const b = h.subarray(at, at + len);
	const nul = b.indexOf(0);
	return dec.decode(nul === -1 ? b : b.subarray(0, nul));
};
const octalField = (h: Uint8Array, at: number, len: number) =>
	Number.parseInt(field(h, at, len).trim() || "0", 8);

/** `<len> <key>=<value>\n` records; `len` counts bytes, so this walks bytes, not characters. */
function paxRecords(b: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	for (let at = 0; at < b.length; ) {
		const sp = b.indexOf(0x20, at);
		const len = sp === -1 ? 0 : Number(dec.decode(b.subarray(at, sp)));
		if (!len) break;
		const rec = dec.decode(b.subarray(sp + 1, at + len - 1));
		const eq = rec.indexOf("=");
		if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
		at += len;
	}
	return out;
}

/**
 * Streams a tar as each entry's header followed by its content in chunks, without buffering a
 * whole file. PAX `path`/`linkpath`/`size`/`mtime` and GNU long names apply to the next header.
 */
export async function* readTar(
	source: AsyncIterable<Uint8Array>,
): AsyncGenerator<TarEvent> {
	const it = source[Symbol.asyncIterator]();
	let buf = new Uint8Array(0);
	const pull = async () => {
		const r = await it.next();
		if (r.done) return false;
		buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
		return true;
	};
	const take = async (n: number) => {
		while (buf.length < n)
			if (!(await pull())) throw new Error("tar ended mid-entry");
		const out = buf.subarray(0, n);
		buf = buf.subarray(n);
		return out;
	};
	let pax: Record<string, string> = {};
	let longName: string | undefined;
	let longLink: string | undefined;
	try {
		for (;;) {
			while (buf.length < BLOCK) if (!(await pull())) return;
			const h = await take(BLOCK);
			if (h.every((b) => b === 0)) return;
			const flag = String.fromCharCode(h[156] ?? 0);
			const size = pax.size ? Number(pax.size) : octalField(h, 124, 12);
			const pad = (BLOCK - (size % BLOCK)) % BLOCK;
			if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
				const body = await take(size + pad);
				if (flag === "x") pax = paxRecords(body.subarray(0, size));
				else if (flag === "L") longName = field(body, 0, size);
				else if (flag === "K") longLink = field(body, 0, size);
				continue;
			}
			const prefix = field(h, 345, 155);
			const short = field(h, 0, 100);
			yield {
				header: {
					name: pax.path ?? longName ?? (prefix ? `${prefix}/${short}` : short),
					type: TYPES[flag] ?? "other",
					size,
					mode: octalField(h, 100, 8) & 0o7777,
					mtime: pax.mtime
						? Math.floor(Number(pax.mtime))
						: octalField(h, 136, 12),
					linkname: pax.linkpath ?? longLink ?? field(h, 157, 100),
				},
			};
			pax = {};
			longName = longLink = undefined;
			for (let left = size; left > 0; ) {
				if (!buf.length && !(await pull()))
					throw new Error("tar ended mid-entry");
				const data = buf.subarray(0, Math.min(left, buf.length));
				buf = buf.subarray(data.length);
				left -= data.length;
				yield { data };
			}
			await take(pad);
		}
	} finally {
		await it.return?.();
	}
}
