import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Marked, Renderer, type Tokens } from "marked";

const dir = join(process.cwd(), "src/content/blog");

export const categories = [
	"Comparisons",
	"Self-hosting",
	"Deployment",
	"Docker",
	"Orchestration",
	"Networking",
	"Databases",
	"Security",
	"Monitoring",
	"AI",
] as const;
export type Category = (typeof categories)[number];

export type PostMeta = {
	slug: string;
	title: string;
	description: string;
	date: string;
	category: Category;
	keywords: string[];
	minutes: number;
};

export type Heading = { id: string; text: string };
export type Post = PostMeta & { html: string; headings: Heading[] };

/** Splits `---` frontmatter (flat `key: value` lines, optional double quotes) from the body. */
export function parseFrontmatter(src: string): {
	data: Record<string, string>;
	body: string;
} {
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
	if (!m) throw new Error("missing frontmatter");
	const data: Record<string, string> = {};
	for (const line of (m[1] ?? "").split("\n")) {
		const i = line.indexOf(":");
		if (i < 1) continue;
		data[line.slice(0, i).trim()] = line
			.slice(i + 1)
			.trim()
			.replace(/^"(.*)"$/, "$1");
	}
	return { data, body: src.slice(m[0].length) };
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/&[a-z#0-9]+;/g, "")
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-");
}

function toMeta(slug: string, data: Record<string, string>, body: string) {
	const category = data.category as Category;
	if (!data.title || !data.description || !data.date)
		throw new Error(
			`blog/${slug}.md: title, description and date are required`,
		);
	if (!categories.includes(category))
		throw new Error(`blog/${slug}.md: unknown category "${data.category}"`);
	return {
		slug,
		title: data.title,
		description: data.description,
		date: data.date,
		category,
		keywords: (data.keywords ?? "")
			.split(",")
			.map((k) => k.trim())
			.filter(Boolean),
		minutes: Math.max(1, Math.round(body.split(/\s+/).length / 230)),
	} satisfies PostMeta;
}

function read(slug: string) {
	return parseFrontmatter(readFileSync(join(dir, `${slug}.md`), "utf8"));
}

let cache: PostMeta[] | undefined;

/** Every post, newest first, then by title. */
export function allPosts(): PostMeta[] {
	cache ??= readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const slug = f.slice(0, -3);
			const { data, body } = read(slug);
			return toMeta(slug, data, body);
		})
		.sort(
			(a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
		);
	return cache;
}

/** Renders Markdown to HTML, giving `##` headings anchor ids and external links rel attributes. */
export function render(md: string): { html: string; headings: Heading[] } {
	const headings: Heading[] = [];
	const seen = new Map<string, number>();
	const marked = new Marked({ gfm: true });
	marked.use({
		renderer: {
			heading(this: Renderer, t: Tokens.Heading) {
				const inner = this.parser.parseInline(t.tokens);
				const base = slugify(inner) || "section";
				const n = seen.get(base) ?? 0;
				seen.set(base, n + 1);
				const id = n ? `${base}-${n}` : base;
				if (t.depth === 2)
					headings.push({ id, text: inner.replace(/<[^>]+>/g, "") });
				return `<h${t.depth} id="${id}">${inner}</h${t.depth}>\n`;
			},
			link(this: Renderer, t: Tokens.Link) {
				const inner = this.parser.parseInline(t.tokens);
				const external = /^https?:\/\//.test(t.href);
				return `<a href="${t.href}"${external ? ' rel="noopener"' : ""}>${inner}</a>`;
			},
			table(this: Renderer, t: Tokens.Table) {
				return `<div class="table-wrap">${Renderer.prototype.table.call(this, t)}</div>`;
			},
			image(t: Tokens.Image) {
				return `<img src="${t.href}" alt="${t.text}" loading="lazy" decoding="async">`;
			},
		},
	});
	const html = marked.parse(md, { async: false });
	return { html, headings };
}

export function readPost(slug: string): Post {
	const { data, body } = read(slug);
	return { ...toMeta(slug, data, body), ...render(body) };
}
