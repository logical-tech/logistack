/**
 * Fractional index keys (`position text collate "C"`): base-62 digits in ASCII order,
 * never ending in the smallest digit, so there is always room between two keys.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = "0";
/** Keys longer than this get the list rebalanced. */
export const RANK_REBALANCE_LENGTH = 24;

function midpoint(a: string, b: string | null): string {
	if (b !== null && a >= b) throw new Error(`rank: ${a} >= ${b}`);
	if (a.endsWith(ZERO) || b?.endsWith(ZERO))
		throw new Error("rank: trailing zero");
	if (b !== null) {
		let n = 0;
		while ((a[n] ?? ZERO) === b[n]) n++;
		if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
	}
	const da = a ? DIGITS.indexOf(a[0] as string) : 0;
	const db = b !== null ? DIGITS.indexOf(b[0] as string) : DIGITS.length;
	if (db - da > 1) return DIGITS[Math.round((da + db) / 2)] as string;
	if (b !== null && b.length > 1) return b.slice(0, 1);
	return (DIGITS[da] as string) + midpoint(a.slice(1), null);
}

/** A key strictly between `a` and `b` (either may be absent: start / end of the list). */
export function rankBetween(a?: string | null, b?: string | null): string {
	// Appends and prepends step one digit instead of halving, so growing a list at either end stays short.
	// shortcut: still linear (one char per ~30 appends past "z"); `needsRebalance` catches long keys.
	if (a && !b) {
		for (let i = 0; i < a.length; i++) {
			const d = DIGITS.indexOf(a[i] as string);
			if (d < DIGITS.length - 1) return a.slice(0, i) + DIGITS[d + 1];
		}
	}
	if (b && !a) {
		for (let i = 0; i < b.length; i++) {
			const d = DIGITS.indexOf(b[i] as string);
			if (d > 1) return b.slice(0, i) + DIGITS[d - 1];
			if (d === 1) break;
		}
	}
	return midpoint(a ?? "", b ?? null);
}

/** `n` ascending keys strictly between `a` and `b`, balanced so they stay short. */
export function rankN(
	a: string | null | undefined,
	b: string | null | undefined,
	n: number,
): string[] {
	if (n <= 0) return [];
	const mid = rankBetween(a, b);
	const left = Math.floor((n - 1) / 2);
	return [...rankN(a, mid, left), mid, ...rankN(mid, b, n - 1 - left)];
}

export const needsRebalance = (key: string) =>
	key.length > RANK_REBALANCE_LENGTH;

/** Fresh evenly spread keys for a whole list of `count` items, in order. */
export const rebalance = (count: number) => rankN(null, null, count);
