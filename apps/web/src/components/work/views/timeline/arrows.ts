/** Dependency arrows: orthogonal routes between bars, drawn with rounded corners. */

export type Point = { x: number; y: number };

/**
 * Route from the blocker's end `a` to the dependant's start `b`. Forward links turn
 * once just after the blocker; backward links (dependant starts first) loop around
 * through the gap between the two rows.
 */
export function routeArrow(
	a: Point,
	b: Point,
	{ gap = 10, rowHalf = 16 }: { gap?: number; rowHalf?: number } = {},
): Point[] {
	if (a.y === b.y && b.x - a.x >= gap) return [a, b];
	if (b.x - a.x >= 2 * gap) {
		const mx = a.x + gap;
		return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
	}
	const midY = b.y >= a.y ? a.y + rowHalf : a.y - rowHalf;
	const out = a.x + gap;
	const back = b.x - gap;
	return [
		a,
		{ x: out, y: a.y },
		{ x: out, y: midY },
		{ x: back, y: midY },
		{ x: back, y: b.y },
		b,
	];
}

/** Drops repeated points and points in the middle of a straight run. */
function simplify(points: Point[]): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		const last = out.at(-1);
		if (last && last.x === p.x && last.y === p.y) continue;
		const prev = out.at(-2);
		if (
			prev &&
			last &&
			((prev.x === last.x && last.x === p.x) ||
				(prev.y === last.y && last.y === p.y))
		)
			out.pop();
		out.push(p);
	}
	return out;
}

/** SVG path through `points` with each corner rounded by up to `r` (never more than half a segment). */
export function roundedPath(points: Point[], r = 6): string {
	const p = simplify(points);
	if (p.length === 0) return "";
	const f = (n: number) => Math.round(n * 100) / 100;
	let d = `M${f(p[0]?.x ?? 0)} ${f(p[0]?.y ?? 0)}`;
	for (let i = 1; i < p.length - 1; i++) {
		const prev = p[i - 1] as Point;
		const cur = p[i] as Point;
		const next = p[i + 1] as Point;
		const lenIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
		const lenOut = Math.hypot(next.x - cur.x, next.y - cur.y);
		const k = Math.min(r, lenIn / 2, lenOut / 2);
		const ix = cur.x - ((cur.x - prev.x) / lenIn) * k;
		const iy = cur.y - ((cur.y - prev.y) / lenIn) * k;
		const ox = cur.x + ((next.x - cur.x) / lenOut) * k;
		const oy = cur.y + ((next.y - cur.y) / lenOut) * k;
		d += ` L${f(ix)} ${f(iy)} Q${f(cur.x)} ${f(cur.y)} ${f(ox)} ${f(oy)}`;
	}
	const last = p.at(-1) as Point;
	if (p.length > 1) d += ` L${f(last.x)} ${f(last.y)}`;
	return d;
}
