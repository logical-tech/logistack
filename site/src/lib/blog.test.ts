import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { allPosts, categories, parseFrontmatter, render } from "./blog";
import { catalogIndex } from "./catalog";

test("frontmatter strips quotes and keeps colons in values", () => {
	const { data, body } = parseFrontmatter(
		'---\ntitle: "A: B"\ndate: 2026-11-08\n---\n\nHello',
	);
	expect(data).toEqual({ title: "A: B", date: "2026-11-08" });
	expect(body.trim()).toBe("Hello");
});

test("render gives h2 ids, dedupes them and wraps tables", () => {
	const { html, headings } = render(
		"## Why `Swarm`?\n\n## Why `Swarm`?\n\n| a |\n|---|\n| b |\n\n[x](https://e.com)",
	);
	expect(headings).toEqual([
		{ id: "why-swarm", text: "Why Swarm?" },
		{ id: "why-swarm-1", text: "Why Swarm?" },
	]);
	expect(html).toContain('<div class="table-wrap"><table>');
	expect(html).toContain('rel="noopener"');
});

test("every post has valid metadata and only links to existing posts and templates", () => {
	const posts = allPosts();
	const slugs = posts.map((p) => p.slug);
	const templates = catalogIndex().map((t) => t.id);
	for (const p of posts) {
		expect(categories).toContain(p.category);
		expect(p.title.length).toBeLessThanOrEqual(70);
		const src = readFileSync(`src/content/blog/${p.slug}.md`, "utf8");
		for (const [, linked = ""] of src.matchAll(/\]\(\/blog\/([^/)#]+)/g))
			expect(slugs, `${p.slug} links to ${linked}`).toContain(linked);
		for (const [, id = ""] of src.matchAll(/\]\(\/templates\/([^/)#]+)/g))
			expect(templates, `${p.slug} links to template ${id}`).toContain(id);
	}
});
