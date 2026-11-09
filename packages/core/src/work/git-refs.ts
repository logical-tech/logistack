const CLOSING =
	/\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\b:?\s*$/i;
const LIST_JOIN = /^\s*(,|&|and)\s*$/i;

/**
 * `SHOP-12`-style refs in a commit message, PR title/body or branch name. Keys must be in `keys`
 * (uppercase). Messages are case-sensitive; pass `{ caseInsensitive: true }` for branch names
 * (`feature/shop-42-login`). A ref closes when a closing keyword precedes it, or it continues a
 * list that started with one ("Fixes SHOP-1, SHOP-2").
 */
export function parseWorkRefs(
	message: string,
	keys: Iterable<string>,
	opts: { caseInsensitive?: boolean } = {},
): { key: string; number: number; closes: boolean }[] {
	const keySet = new Set([...keys].map((k) => k.toUpperCase()));
	const re = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})(?!\d)/g;
	const out = new Map<
		string,
		{ key: string; number: number; closes: boolean }
	>();
	let lastEnd = 0;
	let lastCloses = false;
	let hadPrev = false;
	for (const m of message.matchAll(re)) {
		const raw = m[1] as string;
		const key = raw.toUpperCase();
		if (!opts.caseInsensitive && raw !== key) continue;
		if (!keySet.has(key)) continue;
		const before = message.slice(lastEnd, m.index);
		const closes: boolean =
			CLOSING.test(before) || (hadPrev && lastCloses && LIST_JOIN.test(before));
		const number = Number(m[2]);
		const id = `${key}-${number}`;
		const prev = out.get(id);
		out.set(id, { key, number, closes: closes || (prev?.closes ?? false) });
		lastEnd = (m.index ?? 0) + m[0].length;
		lastCloses = closes;
		hadPrev = true;
	}
	return [...out.values()];
}
