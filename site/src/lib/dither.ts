/*
 * Ordered dithering on a cell grid, ported from design/dither.glsl. Every shape is a density
 * field over the box; a 4×4 Bayer threshold turns density into lit cells whose size grows with it.
 */

export type Shape =
	| "arc"
	| "wave"
	| "mosaic"
	| "rings"
	| "stripes"
	| "signal"
	| "plus"
	| "sunrise"
	| "orb"
	| "spiral"
	| "diamond"
	| "bloom"
	| "bridge";

export type Rgb = readonly [number, number, number];

export interface DitherSpec {
	shape: Shape;
	/** Cell edge in CSS pixels. */
	cell: number;
	/** Left, middle and right colour of the horizontal ramp. */
	colors: readonly [Rgb, Rgb, Rgb];
	gain?: number;
	seed?: number;
}

export interface Cell {
	x: number;
	y: number;
	size: number;
	/** Density in 0..1 before thresholding; the entrance animation sweeps the threshold up to it. */
	density: number;
	threshold: number;
	color: Rgb;
}

/** uv in 0..1 with y pointing up, p centred with x scaled by the aspect ratio. */
type Field = (
	uv: { x: number; y: number },
	p: { x: number; y: number },
	seed: number,
) => number;

const smoothstep = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const band = (d: number, w: number) => 1 - smoothstep(0, w, Math.abs(d));
const fract = (x: number) => x - Math.floor(x);
const hash = (x: number, y: number, seed: number) =>
	fract(Math.sin((x + seed) * 127.1 + (y + seed) * 311.7) * 43758.5453);
const len = (x: number, y: number) => Math.hypot(x, y);

const FIELDS: Record<Shape, Field> = {
	arc: (_, p) =>
		band(len(p.x, p.y + 0.55) - 0.95, 0.26) * smoothstep(-0.6, -0.1, p.y),
	wave: (uv, _, s) => {
		const y =
			0.5 +
			0.18 * Math.sin(uv.x * 9 + s) +
			0.08 * Math.sin(uv.x * 23 + 1.7 * s);
		const under = uv.y <= y ? (0.35 * uv.y) / Math.max(y, 0.01) : 0;
		return Math.max(band(uv.y - y, 0.07), under);
	},
	mosaic: (uv, _, s) => {
		const bx = Math.floor(uv.x * 9);
		const by = Math.floor(uv.y * 5);
		const on = hash(bx * 1.3, by * 1.3, s) >= 0.42 ? 1 : 0;
		return on * (0.45 + 0.55 * hash(bx + 7, by + 7, s));
	},
	rings: (_, p) => {
		const r = len(p.x, p.y);
		return band(fract(r * 3.2) - 0.5, 0.22) * (1 - smoothstep(0.2, 0.75, r));
	},
	stripes: (uv) =>
		band(fract((uv.x + uv.y) * 3) - 0.5, 0.2) * (0.5 + 0.5 * uv.y),
	signal: (uv) => {
		const row = Math.floor(uv.y * 3);
		const length = row === 2 ? 0.92 : row === 1 ? 0.66 : 0.4;
		const inRow = band(fract(uv.y * 3) - 0.5, 0.32);
		return (
			inRow *
			(1 - smoothstep(length - 0.12, length, uv.x)) *
			(uv.x >= 0.06 ? 1 : 0)
		);
	},
	plus: (_, p) => {
		const ax = Math.abs(p.x);
		const ay = Math.abs(p.y);
		return Math.max(
			band(ax, 0.16) * (ay <= 0.42 ? 1 : 0),
			band(ay, 0.16) * (ax <= 0.42 ? 1 : 0),
		);
	},
	sunrise: (_, p) => 1 - smoothstep(0.25, 0.85, len(p.x, p.y + 0.5)),
	orb: (_, p) => 1 - smoothstep(0.05, 0.48, len(p.x, p.y)),
	spiral: (_, p) => {
		const r = len(p.x, p.y);
		const a = Math.atan2(p.y, p.x);
		return (
			band(fract(r * 6 - a / (2 * Math.PI)) - 0.5, 0.25) *
			(1 - smoothstep(0.15, 0.5, r))
		);
	},
	diamond: (_, p) => band(Math.abs(p.x) + Math.abs(p.y) - 0.3, 0.16),
	bloom: (uv) => 1 - smoothstep(0, 1.05, len(uv.x, uv.y)),
	bridge: (_, p) => {
		const o1 = 1 - smoothstep(0.05, 0.26, len(p.x + 0.45, p.y));
		const o2 = 1 - smoothstep(0.05, 0.26, len(p.x - 0.45, p.y));
		const bridge = band(p.y, 0.06) * (Math.abs(p.x) <= 0.45 ? 0.8 : 0);
		return Math.max(o1, o2, bridge);
	},
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
	a[0] + (b[0] - a[0]) * t,
	a[1] + (b[1] - a[1]) * t,
	a[2] + (b[2] - a[2]) * t,
];

/** Every cell that can light up, with the threshold it must exceed. Pure: same input, same cells. */
export function ditherCells(
	spec: DitherSpec,
	width: number,
	height: number,
): Cell[] {
	const { shape, cell, colors, gain = 1, seed = 0 } = spec;
	const field = FIELDS[shape];
	const cols = Math.floor(width / cell);
	const rows = Math.floor(height / cell);
	const aspect = width / height;
	const out: Cell[] = [];
	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < cols; i++) {
			const ux = (i + 0.5) / cols;
			const uy = 1 - (j + 0.5) / rows;
			const raw = field(
				{ x: ux, y: uy },
				{ x: (ux - 0.5) * aspect, y: uy - 0.5 },
				seed,
			);
			const density =
				Math.min(1, Math.max(0, raw * gain)) * (0.85 + 0.3 * hash(i, j, seed));
			const threshold = ((BAYER[(i % 4) + (j % 4) * 4] ?? 0) + 0.5) / 16;
			if (density < threshold) continue;
			const color =
				ux < 0.5
					? mix(colors[0], colors[1], ux * 2)
					: mix(colors[1], colors[2], ux * 2 - 1);
			out.push({
				x: i * cell,
				y: j * cell,
				size: cell * (0.45 + 0.41 * Math.min(1, density)),
				density,
				threshold,
				color,
			});
		}
	}
	return out;
}

export const hex = (value: string): Rgb => {
	const n = Number.parseInt(value.replace("#", ""), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
