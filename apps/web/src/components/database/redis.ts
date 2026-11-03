import type { RedisBytes } from "@logistack/contracts";

/** The text a user reads for some bytes: UTF-8 as is, binary as its base64. */
export const bytesText = (v: RedisBytes) =>
	typeof v === "string" ? v : v.value;

export const isBinary = (v: RedisBytes) => typeof v !== "string";

/** A stable id for bytes, binary or not, for React keys and selection. */
export const bytesId = (v: RedisBytes) =>
	typeof v === "string" ? `t:${v}` : `b:${v.value}`;

/**
 * Splits a command line the way redis-cli does: whitespace separates words, "double quotes"
 * take \n \t \" \\ escapes, 'single quotes' are literal. Throws on an unclosed quote.
 */
export function parseArgv(line: string): string[] {
	const out: string[] = [];
	let word: string | null = null;
	let quote: '"' | "'" | null = null;
	const esc: Record<string, string> = { n: "\n", t: "\t", r: "\r" };
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && i + 1 < line.length) {
				const next = line[++i] as string;
				word += esc[next] ?? next;
			} else word += ch;
		} else if (/\s/.test(ch)) {
			if (word !== null) out.push(word);
			word = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			word ??= "";
		} else word = (word ?? "") + ch;
	}
	if (quote) throw new Error(`Unclosed ${quote} quote.`);
	if (word !== null) out.push(word);
	return out;
}

/** A TTL in ms as the largest two units: 59s, 4m 12s, 3h 5m, 12d 4h. */
export function ttlText(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const units: [string, number][] = [
		["d", 86_400],
		["h", 3600],
		["m", 60],
		["s", 1],
	];
	const parts: string[] = [];
	let rest = s;
	for (const [u, n] of units) {
		const q = Math.floor(rest / n);
		if (q || (u === "s" && !parts.length)) parts.push(`${q}${u}`);
		rest -= q * n;
		if (parts.length === 2) break;
	}
	return parts.join(" ");
}

export function sizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** The value pretty-printed when it is a JSON object or array, else null. */
export function prettyJson(text: string): string | null {
	const t = text.trim();
	if (!t.startsWith("{") && !t.startsWith("[")) return null;
	try {
		return JSON.stringify(JSON.parse(t), null, 2);
	} catch {
		return null;
	}
}
