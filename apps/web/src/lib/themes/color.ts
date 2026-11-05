/*
 * Just enough colour math to hold themes to WCAG contrast: parse the two notations
 * the themes use (hex and oklch), compute relative luminance, and nudge a colour's
 * lightness until it reads on its surfaces.
 */

export type Oklch = { l: number; c: number; h: number };

const linear = (v: number) =>
	v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

function hexToLinear(hex: string): [number, number, number] | null {
	let h = hex.slice(1);
	if (h.length === 3 || h.length === 4)
		h = [...h].map((ch) => ch + ch).join("");
	if (h.length !== 6 && h.length !== 8) return null;
	const n = (i: number) => linear(Number.parseInt(h.slice(i, i + 2), 16) / 255);
	return [n(0), n(2), n(4)];
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
	const rad = (h * Math.PI) / 180;
	const a = c * Math.cos(rad);
	const b = c * Math.sin(rad);
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const clamp = (v: number) => Math.min(1, Math.max(0, v));
	return [
		clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
		clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
		clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
	];
}

function linearToOklch([r, g, b]: [number, number, number]): Oklch {
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const c = Math.hypot(A, B);
	const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
	return { l: L, c, h };
}

const OKLCH =
	/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/;

/** `oklch(L C H)` or `#rgb[a]`/`#rrggbb[aa]`; null for anything else or a translucent colour. */
export function parse(css: string): Oklch | null {
	const v = css.trim();
	if (v.startsWith("#")) {
		const rgb = hexToLinear(v);
		const alpha = v.length === 5 || v.length === 9;
		return rgb && !alpha ? linearToOklch(rgb) : null;
	}
	const m = OKLCH.exec(v);
	if (!m) return null;
	if (m[5] !== undefined) {
		const alpha = Number(m[5]) / (m[6] ? 100 : 1);
		if (alpha < 1) return null;
	}
	return {
		l: Number(m[1]) / (m[2] ? 100 : 1),
		c: Number(m[3]),
		h: Number(m[4]),
	};
}

export const format = ({ l, c, h }: Oklch) =>
	`oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;

export function luminance(color: Oklch) {
	const [r, g, b] = oklchToLinear(color);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Oklch, b: Oklch) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (hi + 0.05) / (lo + 0.05);
}

/** The lowest contrast of `fg` against any of `surfaces`. */
export const worstContrast = (fg: Oklch, surfaces: Oklch[]) =>
	Math.min(...surfaces.map((s) => contrast(fg, s)));

/**
 * `fg` unchanged when it already reaches `target` on every surface; otherwise the
 * nearest lightness (same hue, chroma eased toward the extremes) that does, trying
 * darker and lighter and keeping the smaller change. Null when neither direction can.
 */
export function ensureContrast(
	fg: Oklch,
	surfaces: Oklch[],
	target: number,
): Oklch | null {
	if (worstContrast(fg, surfaces) >= target) return fg;
	const walk = (dir: -1 | 1) => {
		for (let step = 1; step <= 100; step++) {
			const l = fg.l + dir * step * 0.01;
			if (l < 0 || l > 1) return null;
			// Chroma fades near black and white, where it would fall out of gamut.
			const c = fg.c * Math.min(1, (dir < 0 ? l : 1 - l) / 0.25);
			const next = { l, c, h: fg.h };
			if (worstContrast(next, surfaces) >= target) return { next, step };
		}
		return null;
	};
	const down = walk(-1);
	const up = walk(1);
	if (down && up) return (down.step <= up.step ? down : up).next;
	return (down ?? up)?.next ?? null;
}
