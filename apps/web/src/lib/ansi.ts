/** ANSI SGR (colour, bold, italic, underline) for log lines; every other escape is dropped. */

export type AnsiStyle = {
	/** A palette index 0–15 (themed via `--ansi-N`) or a CSS colour. */
	fg?: number | string;
	bg?: number | string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
};

export type AnsiSpan = { text: string; style: AnsiStyle };

// CSI (`ESC [ params final`), OSC (`ESC ] ... BEL|ST`) and two-byte escapes.
const ESCAPE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
	/\x1b(?:\[([0-9;:?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

export const stripAnsi = (line: string) => line.replace(ESCAPE, "");

const CUBE = [0, 95, 135, 175, 215, 255];

/** xterm's 256-colour table: 0–15 the themed palette, then the 6×6×6 cube, then 24 greys. */
function color256(n: number): number | string | undefined {
	if (n < 0 || n > 255) return undefined;
	if (n < 16) return n;
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return `rgb(${v} ${v} ${v})`;
	}
	const i = n - 16;
	return `rgb(${CUBE[Math.floor(i / 36)]} ${CUBE[Math.floor(i / 6) % 6]} ${CUBE[i % 6]})`;
}

/** Reads an extended colour (`38;5;n` or `38;2;r;g;b`) starting at `codes[i]`; returns it and the codes consumed. */
function extended(
	codes: number[],
	i: number,
): [number | string | undefined, number] {
	if (codes[i + 1] === 5) return [color256(codes[i + 2] ?? -1), 2];
	if (codes[i + 1] === 2) {
		const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
		const valid = [r, g, b].every((v) => v !== undefined && v >= 0 && v <= 255);
		return [valid ? `rgb(${r} ${g} ${b})` : undefined, 4];
	}
	return [undefined, 0];
}

function apply(style: AnsiStyle, params: string): AnsiStyle {
	const codes =
		params === ""
			? [0]
			: params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
	let s = { ...style };
	for (let i = 0; i < codes.length; i++) {
		const c = codes[i] as number;
		if (c === 0) s = {};
		else if (c === 1) s.bold = true;
		else if (c === 2) s.dim = true;
		else if (c === 3) s.italic = true;
		else if (c === 4) s.underline = true;
		else if (c === 7) s.inverse = true;
		else if (c === 22) s.bold = s.dim = undefined;
		else if (c === 23) s.italic = undefined;
		else if (c === 24) s.underline = undefined;
		else if (c === 27) s.inverse = undefined;
		else if (c >= 30 && c <= 37) s.fg = c - 30;
		else if (c >= 90 && c <= 97) s.fg = c - 90 + 8;
		else if (c === 39) s.fg = undefined;
		else if (c >= 40 && c <= 47) s.bg = c - 40;
		else if (c >= 100 && c <= 107) s.bg = c - 100 + 8;
		else if (c === 49) s.bg = undefined;
		else if (c === 38 || c === 48) {
			const [color, used] = extended(codes, i);
			if (c === 38) s.fg = color;
			else s.bg = color;
			i += used;
		}
	}
	for (const k of Object.keys(s) as (keyof AnsiStyle)[])
		if (s[k] === undefined) delete s[k];
	return s;
}

/** Splits one line into styled runs. Styles reset at the start of each line. */
export function parseAnsi(line: string): AnsiSpan[] {
	const spans: AnsiSpan[] = [];
	let style: AnsiStyle = {};
	let last = 0;
	const push = (text: string) => {
		if (!text) return;
		const prev = spans.at(-1);
		if (prev && prev.style === style) prev.text += text;
		else spans.push({ text, style });
	};
	for (const m of line.matchAll(ESCAPE)) {
		push(line.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[2] === "m") style = apply(style, m[1] ?? "");
	}
	push(line.slice(last));
	return spans;
}

const paint = (c: number | string) =>
	typeof c === "number" ? `var(--ansi-${c})` : c;

/** Inline CSS for a span; `inverse` swaps the colours, defaulting to the viewer's own. */
export function spanCss(style: AnsiStyle): Record<string, string> {
	const css: Record<string, string> = {};
	let { fg, bg } = style;
	// Bold with a basic colour brightens it, as terminals do.
	if (style.bold && typeof fg === "number" && fg < 8) fg += 8;
	if (style.inverse) {
		css.color = bg === undefined ? "var(--log-bg)" : paint(bg);
		css.backgroundColor = fg === undefined ? "var(--log-fg)" : paint(fg);
	} else {
		if (fg !== undefined) css.color = paint(fg);
		if (bg !== undefined) css.backgroundColor = paint(bg);
	}
	if (style.bold) css.fontWeight = "600";
	if (style.dim) css.opacity = "0.65";
	if (style.italic) css.fontStyle = "italic";
	if (style.underline) css.textDecoration = "underline";
	return css;
}
