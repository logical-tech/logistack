import {
	type PmDoc,
	type PmMark,
	type PmNode,
	WORK_DESCRIPTION_MAX_BYTES,
} from "@logistack/contracts";

/** Node type → allowed attributes (section 11). Anything else is dropped with its content. */
const NODES: Record<string, readonly string[]> = {
	doc: [],
	paragraph: [],
	text: [],
	heading: ["level"],
	blockquote: [],
	codeBlock: ["language"],
	bulletList: [],
	orderedList: ["start"],
	listItem: [],
	taskList: [],
	taskItem: ["checked"],
	hardBreak: [],
	horizontalRule: [],
	image: ["src", "alt", "title", "width", "height"],
	mention: ["id", "label"],
	taskRef: ["id", "key", "number"],
};
const MARKS: Record<string, readonly string[]> = {
	bold: [],
	italic: [],
	strike: [],
	code: [],
	link: ["href"],
};

const SAFE_HREF = /^(https?:|mailto:)/i;
const ATTACHMENT_SRC = /^\/api\/work\/attachments\/[A-Za-z0-9_-]+(\?thumb=1)?$/;

function pick(
	attrs: Record<string, unknown> | undefined,
	allowed: readonly string[],
): Record<string, unknown> | undefined {
	if (!attrs || !allowed.length) return undefined;
	const out: Record<string, unknown> = {};
	for (const k of allowed) {
		const v = attrs[k];
		if (v !== undefined && (v === null || typeof v !== "object")) out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

function cleanMark(m: PmMark): PmMark | null {
	const allowed = MARKS[m.type];
	if (!allowed) return null;
	const attrs = pick(m.attrs, allowed);
	if (m.type === "link") {
		const href = attrs?.href;
		if (typeof href !== "string" || !SAFE_HREF.test(href.trim())) return null;
	}
	return attrs ? { type: m.type, attrs } : { type: m.type };
}

function cleanNode(n: PmNode): PmNode | null {
	const allowed = NODES[n.type];
	if (!allowed || n.type === "doc") return null;
	let attrs = pick(n.attrs, allowed);
	if (n.type === "image") {
		const src = attrs?.src;
		if (typeof src !== "string" || !ATTACHMENT_SRC.test(src)) return null;
	}
	if (n.type === "heading") {
		attrs = { level: Number(attrs?.level) === 3 ? 3 : 2 };
	}
	const out: PmNode = { type: n.type };
	if (attrs) out.attrs = attrs;
	if (n.type === "text") {
		if (typeof n.text !== "string" || !n.text) return null;
		out.text = n.text;
		const marks = (n.marks ?? []).map(cleanMark).filter((m) => m !== null);
		if (marks.length) out.marks = marks;
		return out;
	}
	if (n.content) {
		const content = n.content.map(cleanNode).filter((c) => c !== null);
		if (content.length) out.content = content;
	}
	return out;
}

/** Allow-list a ProseMirror doc: unknown nodes/marks/attrs dropped, unsafe links and foreign images removed. Throws over `maxBytes`. */
export function sanitizeDoc(
	doc: PmDoc,
	maxBytes = WORK_DESCRIPTION_MAX_BYTES,
): PmDoc {
	const content = (doc.content ?? []).map(cleanNode).filter((c) => c !== null);
	const out: PmDoc = { type: "doc", content };
	if (new TextEncoder().encode(JSON.stringify(out)).length > maxBytes)
		throw new Error(`document larger than ${Math.round(maxBytes / 1000)} KB`);
	return out;
}

const BLOCKS = new Set([
	"paragraph",
	"heading",
	"blockquote",
	"codeBlock",
	"bulletList",
	"orderedList",
	"taskList",
	"listItem",
	"taskItem",
	"horizontalRule",
	"image",
]);

function inlineText(n: PmNode): string {
	switch (n.type) {
		case "text":
			return n.text ?? "";
		case "hardBreak":
			return "\n";
		case "mention":
			return `@${String(n.attrs?.label ?? n.attrs?.id ?? "")}`;
		case "taskRef":
			return `${String(n.attrs?.key ?? "")}-${String(n.attrs?.number ?? "")}`;
		default:
			return "";
	}
}

/** Plain text for search, previews and notifications: blocks on their own lines. */
export function docToText(doc: PmNode | null | undefined): string {
	const lines: string[] = [];
	const walk = (n: PmNode, prefix: string) => {
		if (n.type === "horizontalRule" || n.type === "image") return;
		const kids = n.content ?? [];
		if (kids.some((c) => BLOCKS.has(c.type))) {
			kids.forEach((c, i) => {
				const p =
					n.type === "bulletList" || n.type === "taskList"
						? "- "
						: n.type === "orderedList"
							? `${Number(n.attrs?.start ?? 1) + i}. `
							: "";
				walk(c, p ? `${prefix.replace(/[^ ]/g, " ")}${p}` : prefix);
			});
			return;
		}
		const text = kids.map(inlineText).join("");
		if (text.trim()) lines.push(prefix + text);
	};
	if (doc) walk(doc, "");
	return lines.join("\n").trim();
}

const esc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const TAGS: Record<string, string> = {
	paragraph: "p",
	blockquote: "blockquote",
	bulletList: "ul",
	orderedList: "ol",
	taskList: "ul",
	listItem: "li",
	taskItem: "li",
};
const MARK_TAGS: Record<string, string> = {
	bold: "strong",
	italic: "em",
	strike: "s",
	code: "code",
};

/** Simple escaped HTML for emails. `baseUrl` makes attachment images absolute. Sanitises first. */
export function docToEmailHtml(doc: PmDoc, baseUrl = ""): string {
	const render = (n: PmNode): string => {
		const inner = () => (n.content ?? []).map(render).join("");
		switch (n.type) {
			case "doc":
				return inner();
			case "text": {
				let html = esc(n.text ?? "");
				for (const m of n.marks ?? []) {
					if (m.type === "link")
						html = `<a href="${esc(String(m.attrs?.href))}">${html}</a>`;
					else {
						const t = MARK_TAGS[m.type];
						if (t) html = `<${t}>${html}</${t}>`;
					}
				}
				return html;
			}
			case "heading": {
				const t = `h${n.attrs?.level === 3 ? 3 : 2}`;
				return `<${t}>${inner()}</${t}>`;
			}
			case "codeBlock":
				return `<pre><code>${inner()}</code></pre>`;
			case "hardBreak":
				return "<br>";
			case "horizontalRule":
				return "<hr>";
			case "image":
				return `<img src="${esc(baseUrl + String(n.attrs?.src))}" alt="${esc(String(n.attrs?.alt ?? ""))}" style="max-width:100%">`;
			case "taskItem":
				return `<li>${n.attrs?.checked ? "☑" : "☐"} ${inner()}</li>`;
			case "mention":
			case "taskRef":
				return esc(inlineText(n));
			default: {
				const t = TAGS[n.type];
				return t ? `<${t}>${inner()}</${t}>` : inner();
			}
		}
	};
	return render(sanitizeDoc(doc, Number.POSITIVE_INFINITY));
}
