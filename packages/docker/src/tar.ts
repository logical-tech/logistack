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
