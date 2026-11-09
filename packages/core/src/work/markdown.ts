import type { PmDoc, PmMark, PmNode } from "@logistack/contracts";

/**
 * A small markdown → ProseMirror converter for imports: headings, paragraphs, lists (nested by indent),
 * task lists, blockquotes, code blocks, rules, emphasis/strong/strike/code, links and images.
 * shortcut: no tables, HTML or reference links; they come through as text. Upgrade if imports need them.
 */
export function markdownToDoc(md: string): PmDoc {
	const content = parseBlocks(md.replace(/\r\n?/g, "\n").split("\n"));
	return { type: "doc", content };
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (l: string) =>
	(l.match(/^\s*/)?.[0] ?? "").replace(/\t/g, "    ").length;

function parseBlocks(lines: string[]): PmNode[] {
	const out: PmNode[] = [];
	let para: string[] = [];
	const flush = () => {
		if (para.length) out.push(...paragraph(para.join("\n")));
		para = [];
	};
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] as string;
		const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
		if (fence) {
			flush();
			const body: string[] = [];
			i++;
			while (
				i < lines.length &&
				!(lines[i] as string).trim().startsWith(fence[1] as string)
			)
				body.push(lines[i++] as string);
			i++;
			const text = body.join("\n");
			out.push({
				type: "codeBlock",
				...(fence[2] ? { attrs: { language: fence[2] } } : {}),
				...(text ? { content: [{ type: "text", text }] } : {}),
			});
			continue;
		}
		if (!line.trim()) {
			flush();
			i++;
			continue;
		}
		const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (h) {
			flush();
			const content = inline(h[2] as string).filter((n) => n.type !== "image");
			out.push({
				type: "heading",
				attrs: { level: (h[1] as string).length >= 3 ? 3 : 2 },
				...(content.length ? { content } : {}),
			});
			i++;
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			out.push({ type: "horizontalRule" });
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			flush();
			const body: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i] as string))
				body.push((lines[i++] as string).replace(/^\s*>\s?/, ""));
			out.push({ type: "blockquote", content: parseBlocks(body) });
			continue;
		}
		if (LIST_ITEM.test(line)) {
			flush();
			const start = i;
			const base = indentOf(line);
			i++;
			while (i < lines.length) {
				const l = lines[i] as string;
				if (!l.trim()) {
					const next = lines[i + 1];
					if (
						next !== undefined &&
						(indentOf(next) > base || LIST_ITEM.test(next))
					) {
						i++;
						continue;
					}
					break;
				}
				if (indentOf(l) > base || (LIST_ITEM.test(l) && indentOf(l) === base))
					i++;
				else break;
			}
			out.push(...list(lines.slice(start, i), base));
			continue;
		}
		para.push(line);
		i++;
	}
	flush();
	return out;
}

/** Items at `base` indent; consecutive items of the same kind share one list node. */
function list(lines: string[], base: number): PmNode[] {
	const items: {
		kind: string;
		ordered: number | null;
		check: boolean | null;
		body: string[];
	}[] = [];
	for (const l of lines) {
		const m = l.match(LIST_ITEM);
		if (m && indentOf(l) === base) {
			const ordered = /\d/.test(m[2] as string)
				? Number.parseInt(m[2] as string, 10)
				: null;
			const task = (m[3] as string).match(/^\[( |x|X)\]\s+(.*)$/);
			items.push({
				kind: task ? "task" : ordered !== null ? "ordered" : "bullet",
				ordered,
				check: task ? task[1] !== " " : null,
				body: [task ? (task[2] as string) : (m[3] as string)],
			});
		} else items.at(-1)?.body.push(l.slice(Math.min(indentOf(l), base + 2)));
	}
	const out: PmNode[] = [];
	for (const it of items) {
		const node: PmNode =
			it.kind === "task"
				? {
						type: "taskItem",
						attrs: { checked: it.check },
						content: parseBlocks(it.body),
					}
				: { type: "listItem", content: parseBlocks(it.body) };
		if (!node.content?.length) node.content = [{ type: "paragraph" }];
		const last = out.at(-1);
		const type =
			it.kind === "task"
				? "taskList"
				: it.kind === "ordered"
					? "orderedList"
					: "bulletList";
		if (last?.type === type) last.content?.push(node);
		else
			out.push({
				type,
				...(type === "orderedList" && it.ordered !== 1
					? { attrs: { start: it.ordered } }
					: {}),
				content: [node],
			});
	}
	return out;
}

/** A paragraph, with images lifted out as their own blocks. */
function paragraph(text: string): PmNode[] {
	const out: PmNode[] = [];
	let run: PmNode[] = [];
	const push = () => {
		while (run[0]?.type === "hardBreak") run.shift();
		while (run.at(-1)?.type === "hardBreak") run.pop();
		if (run.length) out.push({ type: "paragraph", content: run });
		run = [];
	};
	for (const n of inline(text)) {
		if (n.type === "image") {
			push();
			out.push(n);
		} else run.push(n);
	}
	push();
	return out;
}

type Rule = {
	re: RegExp;
	make: (m: RegExpExecArray, marks: PmMark[]) => PmNode[];
};

const RULES: Rule[] = [
	{
		re: /\\([\\`*_~[\]()#>!-])/,
		make: (m, marks) => text(m[1] as string, marks),
	},
	{
		re: /`([^`]+)`/,
		make: (m, marks) => text(m[1] as string, [...marks, { type: "code" }]),
	},
	{
		re: /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/,
		make: (m) => [
			{
				type: "image",
				attrs: {
					src: m[2],
					alt: m[1] || null,
					...(m[3] ? { title: m[3] } : {}),
				},
			},
		],
	},
	{
		re: /\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/,
		make: (m, marks) =>
			inline(m[1] as string, [
				...marks,
				{ type: "link", attrs: { href: m[2] } },
			]),
	},
	{
		re: /<(https?:\/\/[^>\s]+)>/,
		make: (m, marks) =>
			text(m[1] as string, [...marks, { type: "link", attrs: { href: m[1] } }]),
	},
	{
		re: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/,
		make: (m, marks) => inline(m[2] as string, [...marks, { type: "bold" }]),
	},
	{
		re: /~~(?=\S)([\s\S]*?\S)~~/,
		make: (m, marks) => inline(m[1] as string, [...marks, { type: "strike" }]),
	},
	{
		re: /(?<![\w*])([*_])(?=\S)([\s\S]*?\S)\1(?![\w*])/,
		make: (m, marks) => inline(m[2] as string, [...marks, { type: "italic" }]),
	},
	{ re: / {2,}\n|\\\n/, make: () => [{ type: "hardBreak" }] },
];

const text = (t: string, marks: PmMark[]): PmNode[] =>
	t ? [{ type: "text", text: t, ...(marks.length ? { marks } : {}) }] : [];

function inline(src: string, marks: PmMark[] = []): PmNode[] {
	const out: PmNode[] = [];
	let rest = src;
	while (rest) {
		let best: { m: RegExpExecArray; rule: Rule } | null = null;
		for (const rule of RULES) {
			const m = rule.re.exec(rest);
			if (m && (!best || m.index < best.m.index)) best = { m, rule };
		}
		if (!best) {
			out.push(...text(rest.replace(/\n/g, " "), marks));
			break;
		}
		out.push(...text(rest.slice(0, best.m.index).replace(/\n/g, " "), marks));
		out.push(...best.rule.make(best.m, marks));
		rest = rest.slice(best.m.index + best.m[0].length);
	}
	// Merge adjacent text nodes with identical marks.
	return out.reduce<PmNode[]>((acc, n) => {
		const prev = acc.at(-1);
		if (
			prev?.type === "text" &&
			n.type === "text" &&
			JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])
		)
			prev.text = (prev.text ?? "") + (n.text ?? "");
		else acc.push(n);
		return acc;
	}, []);
}
