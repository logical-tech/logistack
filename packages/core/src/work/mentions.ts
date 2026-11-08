import type { PmNode } from "@logistack/contracts";

function walk(node: PmNode | null | undefined, visit: (n: PmNode) => void) {
	if (!node) return;
	visit(node);
	for (const c of node.content ?? []) walk(c, visit);
}

/** User ids of `mention` nodes, first-seen order, no duplicates. */
export function extractMentions(doc: PmNode | null | undefined): string[] {
	const ids = new Set<string>();
	walk(doc, (n) => {
		const id = n.type === "mention" ? n.attrs?.id : undefined;
		if (typeof id === "string" && id) ids.add(id);
	});
	return [...ids];
}

/** Users mentioned in `newDoc` but not in `oldDoc` (only they get notified). */
export function newMentions(
	oldDoc: PmNode | null | undefined,
	newDoc: PmNode | null | undefined,
): string[] {
	const before = new Set(extractMentions(oldDoc));
	return extractMentions(newDoc).filter((id) => !before.has(id));
}

const REF = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9})-(\d{1,9})(?![\d])/g;

function refsInText(
	text: string,
	keys: ReadonlySet<string>,
	out: Map<string, { key: string; number: number }>,
) {
	for (const m of text.matchAll(REF)) {
		const key = m[1] as string;
		const number = Number(m[2]);
		if (keys.has(key)) out.set(`${key}-${number}`, { key, number });
	}
}

/**
 * `SHOP-42`-style references to known keys, deduplicated. Text inside code (code blocks,
 * `code` marks, markdown backticks) is ignored; `taskRef` nodes count.
 */
export function extractTaskRefs(
	input: string | PmNode | null | undefined,
	keys: Iterable<string>,
): { key: string; number: number }[] {
	const keySet = new Set(keys);
	const out = new Map<string, { key: string; number: number }>();
	if (typeof input === "string") {
		const plain = input
			.replace(/```[\s\S]*?(```|$)/g, " ")
			.replace(/`[^`\n]*`/g, " ");
		refsInText(plain, keySet, out);
		return [...out.values()];
	}
	const visit = (n: PmNode) => {
		if (n.type === "codeBlock") return;
		if (n.type === "taskRef") {
			const key = n.attrs?.key;
			const number = Number(n.attrs?.number);
			if (
				typeof key === "string" &&
				keySet.has(key) &&
				Number.isInteger(number)
			)
				out.set(`${key}-${number}`, { key, number });
		}
		if (n.type === "text" && n.text && !n.marks?.some((m) => m.type === "code"))
			refsInText(n.text, keySet, out);
		for (const c of n.content ?? []) visit(c);
	};
	if (input) visit(input);
	return [...out.values()];
}
