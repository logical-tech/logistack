import type { ReactNode } from "react";

/**
 * The Markdown subset release notes use: headings, paragraphs, lists, fenced code, inline code,
 * bold, emphasis and links. Rendered as React elements, never as HTML, so a release body cannot
 * inject markup; anything outside the subset shows as plain text.
 */
export type Block =
	| { kind: "heading"; level: 2 | 3; text: string }
	| { kind: "paragraph"; text: string }
	| { kind: "list"; ordered: boolean; items: string[] }
	| { kind: "code"; text: string };

const ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const STARTS_BLOCK = /^(#{1,6}\s|```|\s*([-*+]|\d+[.)])\s)/;

export function parseBlocks(source: string): Block[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;
	const at = (n: number) => lines[n] ?? "";
	while (i < lines.length) {
		const line = at(i);
		if (line.startsWith("```")) {
			const code: string[] = [];
			for (i++; i < lines.length && !at(i).startsWith("```"); i++)
				code.push(at(i));
			i++;
			blocks.push({ kind: "code", text: code.join("\n") });
			continue;
		}
		const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) {
			const depth = heading[1]?.length ?? 2;
			blocks.push({
				kind: "heading",
				level: depth <= 2 ? 2 : 3,
				text: heading[2] ?? "",
			});
			i++;
			continue;
		}
		const first = ITEM.exec(line);
		if (first) {
			const ordered = /\d/.test(first[1] ?? "");
			const items: string[] = [];
			while (i < lines.length) {
				const m = ITEM.exec(at(i));
				if (m && /\d/.test(m[1] ?? "") === ordered) items.push(m[2] ?? "");
				// A wrapped item continues on an indented line.
				else if (items.length && /^\s{2,}\S/.test(at(i)))
					items[items.length - 1] += ` ${at(i).trim()}`;
				else break;
				i++;
			}
			blocks.push({ kind: "list", ordered, items });
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		const text: string[] = [];
		while (i < lines.length && at(i).trim() && !STARTS_BLOCK.test(at(i)))
			text.push(at(i++).trim());
		blocks.push({ kind: "paragraph", text: text.join(" ") });
	}
	return blocks;
}

// `code`, **bold**, [text](https://…), a bare https URL, *em* or _em_, in that precedence.
const INLINE =
	/`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])|(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])|(?<!\w)_(?!\s)([^_]+?)_(?!\w)/g;

const linkClass =
	"font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] transition-[text-decoration-color] duration-(--duration-quick) hover:decoration-foreground";

export function renderInline(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		const index = m.index ?? 0;
		if (index > last) out.push(text.slice(last, index));
		const [, code, bold, label, href, bare, em, em2] = m;
		const key = `${index}`;
		if (code !== undefined)
			out.push(
				<code
					key={key}
					className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
				>
					{code}
				</code>,
			);
		else if (bold !== undefined)
			out.push(
				<strong key={key} className="font-semibold">
					{renderInline(bold)}
				</strong>,
			);
		else if (href !== undefined)
			out.push(
				<a
					key={key}
					href={href}
					target="_blank"
					rel="noreferrer"
					className={linkClass}
				>
					{renderInline(label ?? href)}
				</a>,
			);
		else if (bare !== undefined)
			out.push(
				<a
					key={key}
					href={bare}
					target="_blank"
					rel="noreferrer"
					className={`${linkClass} break-all`}
				>
					{bare.replace(/^https:\/\//, "")}
				</a>,
			);
		else out.push(<em key={key}>{renderInline(em ?? em2 ?? "")}</em>);
		last = index + m[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

export function Markdown({ source }: { source: string }) {
	return (
		<div className="grid gap-3 text-sm leading-relaxed text-pretty">
			{parseBlocks(source).map((b, i) => {
				const key = `${b.kind}-${i}`;
				switch (b.kind) {
					case "heading":
						return b.level === 2 ? (
							<h3
								key={key}
								className="mt-3 text-sm font-semibold text-balance first:mt-0"
							>
								{renderInline(b.text)}
							</h3>
						) : (
							<h4
								key={key}
								className="mt-2 text-[13px] font-semibold text-muted-foreground first:mt-0"
							>
								{renderInline(b.text)}
							</h4>
						);
					case "paragraph":
						return (
							<p key={key} className="max-w-[72ch]">
								{renderInline(b.text)}
							</p>
						);
					case "code":
						return (
							<pre
								key={key}
								className="overflow-x-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-[13px] leading-normal"
							>
								<code>{b.text}</code>
							</pre>
						);
					case "list": {
						const List = b.ordered ? "ol" : "ul";
						return (
							<List
								key={key}
								className={`grid max-w-[72ch] gap-1.5 pl-5 marker:text-muted-foreground ${b.ordered ? "list-decimal" : "list-disc"}`}
							>
								{b.items.map((item, j) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: items have no identity beyond their order
									<li key={j} className="pl-1">
										{renderInline(item)}
									</li>
								))}
							</List>
						);
					}
				}
				return null;
			})}
		</div>
	);
}
